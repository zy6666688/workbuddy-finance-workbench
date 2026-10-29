import { randomUUID, createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  open,
  link,
  unlink,
  realpath,
  readdir,
} from 'node:fs/promises'
import path from 'node:path'

const labels = {
  application_materials: '待补资料',
  retry_available: '可继续补办',
  application_review: '待独立核验申请',
  awaiting_receipt: '等待实际开票回执',
  receipt_review: '待独立核验回执',
  receipt_correction: '回执被驳回，待补正',
  receipt_unknown: '实际结果待核实',
  receipt_failed: '实际开票失败，待人工核实',
  accounting_materials: '账务待补资料',
  draft_review: '记账草稿待独立复核',
  handoff_ready: '交接成果已形成',
  withdrawn: '申请已撤回',
}
const nextSteps = {
  application_materials: '补齐下面缺少的资料后继续，已有内容会保留。',
  retry_available: '可以沿用原资料继续补办。',
  application_review: '请另一名有权限的同事在工作台核验申请。',
  awaiting_receipt: '收到实际开票回执后再回录。',
  receipt_review: '请另一名有权限的同事在工作台核验回执。',
  receipt_correction: '按驳回意见补正原回执资料，再交另一名同事核验。',
  receipt_unknown: '先核实实际开票结果，避免重复开票。',
  receipt_failed: '先核实开票失败原因，继续跟踪原申请。',
  accounting_materials: '补齐下面列出的账务资料和业务依据后继续。',
  draft_review: '请另一名有权限的同事复核记账草稿。',
  handoff_ready: '可以取回已复核的交接成果，尚未正式入账。',
  withdrawn: '请负责人核实撤回后的安排。',
}

function summary(items) {
  return items.map((i) => ({
    customer: i.company_name,
    business: i.payload.businessRef,
    status: i.handoff?.stale
      ? '历史成果已复核，当前资料有变化'
      : labels[i.group] || '待核实',
    missing: [...new Set((i.feedback || []).map((f) => f.message))],
    next:
      i.availabilityIssue ||
      (i.handoff?.stale
        ? '请负责人按最新资料核实，历史成果会保留。'
        : nextSteps[i.group]) ||
      '请负责人核实当前进度。',
    reviewRequired: !!i.nextStep?.requiresHumanReview,
    hasHandoff: !!i.handoff && !i.handoff.stale,
  }))
}
async function allPages(read) {
  const result = []
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await read({ limit: 50, offset })
    if (!Array.isArray(page)) throw Error('未能读取完整列表，请稍后再试。')
    result.push(...page)
    if (page.length < 50) return result
  }
  throw Error('匹配范围较大，请补充客户全称或批次名称后再继续。')
}

// Journal is local to the authorized handoff directory, account, server and
// batch. It survives MCP/app restart and is written before any mutation.
async function submitRemembered(client, actor, batchId, selectedIds, body) {
  const root = await realpath(client.workspace)
  const dir = path.join(root, '.invoice-resume')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if ((await realpath(dir)) !== dir)
    throw Error('续办暂存目录不可用，请联系负责人检查交接目录。')
  const scope = createHash('sha256')
    .update(JSON.stringify([client.origin, actor.org_id, actor.id, batchId]))
    .digest('hex')
  let pending, file
  // Immutable, atomically published requests need no process lock that could
  // strand the user after a crash. Concurrent identical calls share one key;
  // differing requests still use the server's version/transaction protections.
  for (const name of (await readdir(dir))
    .filter((n) => n.startsWith(scope + '-') && n.endsWith('.json'))
    .sort()) {
    try {
      file = path.join(dir, name)
      pending = JSON.parse(await readFile(file, 'utf8'))
      break
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw Error(
          '上次续办记录无法读取，请先核实原处理结果，未发起新的提交。',
        )
    }
  }
  if (
    pending &&
    (!Array.isArray(pending.scopeIds) ||
      !Array.isArray(pending.body?.items) ||
      typeof pending.body?.key !== 'string')
  )
    throw Error('上次续办暂存不完整，请先核实原处理结果，未发起新的提交。')
  const recovered = !!pending
  if (
    pending &&
    (pending.scopeIds.length !== selectedIds.length ||
      pending.scopeIds.some((id) => !selectedIds.includes(id)) ||
      pending.body.items.some((item) => !selectedIds.includes(item.itemId)))
  )
    return {
      needsOriginalScope: true,
      message:
        '上次续办结果尚未确认，请先按原客户和业务范围继续查询，暂不另办其他项目。',
    }
  if (!pending) {
    if (!body.items.length) return { idle: true }
    const stable = (value) =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, stable(value[k])]),
            )
          : value
    const digest = createHash('sha256')
      .update(scope + JSON.stringify(stable(body)))
      .digest('hex')
    const key = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    pending = { scopeIds: selectedIds, body: { ...body, key } }
    file = path.join(dir, `${scope}-${digest}.json`)
    const temp = file + '.' + randomUUID() + '.tmp'
    const out = await open(temp, 'wx', 0o600)
    try {
      try {
        await out.writeFile(JSON.stringify(pending))
        await out.sync()
      } finally {
        await out.close()
      }
      try {
        await link(temp, file)
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
  let result
  try {
    result = await client.continueInvoiceBatch(batchId, pending.body)
  } catch (e) {
    if (e.status >= 400 && e.status < 500 && !e.outcomeUnknown)
      await unlink(file).catch((e) => {
        if (e.code !== 'ENOENT') throw e
      })
    throw e
  }
  if (!result?.id || !Array.isArray(result.items))
    throw Object.assign(
      Error(
        '尚未取得完整结果，已保存本次填写。下次说“继续办理”即可核实，不必重填。',
      ),
      { outcomeUnknown: true },
    )
  await unlink(file).catch((e) => {
    if (e.code !== 'ENOENT') throw e
  })
  return { result, recovered }
}

export async function resumeInvoiceWork(client, args, download) {
  if (!['progress', 'continue', 'download'].includes(args.operation))
    throw Error('请明确是查询进度、继续办理，还是取回成果。')
  const actor = await client.me()
  const matches = await allPages((q) =>
    client.companies({ ...q, search: args.customer.slice(0, 100) }),
  )
  const companies = matches.filter(
    (c) => c.name === args.customer || c.code === args.customer,
  )
  if (companies.length !== 1)
    return {
      message: '请确认客户全称或客户编码，已有资料会继续保留。',
      choices: matches.map((c) => ({ customer: c.name, code: c.code })),
    }
  const orders = await allPages((q) =>
    client.orders({ ...q, companyId: companies[0].id, period: args.period }),
  )
  if (!orders.length)
    return {
      message: '当前账号下未找到该客户本期工作单，请核实客户、月份或权限。',
    }
  const batches = new Map()
  for (const order of orders)
    for (const b of await allPages((q) =>
      client.invoiceBatches({ ...q, orderId: order.id }),
    ))
      batches.set(b.id, b)
  const candidates = [...batches.values()].filter(
    (b) =>
      (!args.batchTitle || b.title === args.batchTitle) &&
      (!args.batchCreatedAt ||
        new Date(b.created_at).toISOString() === args.batchCreatedAt),
  )
  if (candidates.length !== 1)
    return {
      message: candidates.length
        ? '找到多批业务，请选要接着办的批次，不需要重填资料。'
        : '未找到符合范围的开票批次，请核实批次名称。',
      choices: candidates.map((b) => ({
        batch: b.title,
        createdAt: b.created_at,
      })),
    }
  const batchId = candidates[0].id,
    batch = await client.invoiceBatchActions(batchId)
  const select = (batch) =>
    batch.items.filter(
      (i) =>
        i.company_id === companies[0].id &&
        i.orderPeriod === args.period &&
        (!args.businessRef || i.payload.businessRef === args.businessRef),
    )
  const items = select(batch)
  if (!items.length)
    return { message: '未找到当前可办理的指定业务，未扩大客户或项目范围。' }
  if (items.length > 50)
    return { message: '本期超过 50 项，请按业务编号缩小范围后续办。' }
  if (args.operation === 'progress')
    return {
      message: '已查到当前进度，已填资料无需重填。',
      items: summary(items),
    }
  if (args.operation === 'download') {
    const files = []
    for (const item of items)
      if (item.handoff && !item.handoff.stale) {
        const safeName = item.company_name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .slice(0, 60)
        files.push(
          await download({
            draftId: item.handoff.draftId,
            format: 'xlsx',
            filePath: `${safeName}-${args.period}-${randomUUID().slice(0, 8)}-交接.xlsx`,
          }),
        )
      }
    return {
      message: files.length
        ? '已保存通过复核的交接成果，未正式入账。'
        : '当前没有可交接的最新复核成果，请先完成待办。',
      files: files.map((f) => ({ location: f.absolutePath, state: f.state })),
      items: summary(items),
    }
  }
  if ((args.corrections || args.context) && items.length !== 1)
    return {
      message:
        '本批有多笔业务，请说明要补正哪一笔的业务编号，避免把同一份补充资料填到其他业务。',
      items: summary(items),
    }
  const inputs = []
  for (const item of items) {
    if (item.resume && !item.resume.canPrefill) continue
    const resume = item.resume
    const action =
      resume?.action ||
      (item.allowedActions.includes('repair')
        ? 'repair'
        : item.allowedActions.includes('retry')
          ? 'retry'
          : (item.accountingDraft?.context || args.context) &&
              item.allowedActions.includes('accounting')
            ? 'accounting'
            : item.allowedActions.includes('ledger')
              ? 'ledger'
              : null)
    if (!action) continue
    const e = item.expected
    const input = {
      itemId: item.id,
      action,
      expectedAttemptId: e.attemptId,
      orderVersion: e.orderVersion,
      reason:
        args.note || resume?.reason || '按原资料继续办理，保留独立人工复核。',
    }
    if (action !== 'retry') input.requestVersion = e.requestVersion
    if (action === 'repair' || action === 'retry') {
      const original =
        resume?.changes ||
        (item.request
          ? {
              payload: item.request.payload,
              sourceFileIds: item.request.source_files.map((f) => f.id),
              authorization: {
                id: item.request.authorization_id,
                version: item.request.authorization_version,
              },
            }
          : {
              payload: item.payload.payload,
              sourceFileIds: item.payload.sourceFileIds,
              authorization: item.payload.authorization,
            })
      input.changes = structuredClone(original)
      if (args.corrections)
        Object.assign(input.changes.payload, args.corrections)
    }
    if (action === 'accounting') {
      const previous = resume?.context || item.accountingDraft?.context || {}
      input.context = { ...structuredClone(previous), ...args.context }
      if (
        args.context &&
        ((args.context.ruleId !== undefined &&
          args.context.ruleId !== previous.ruleId) ||
          (args.context.ruleVersion !== undefined &&
            args.context.ruleVersion !== previous.ruleVersion)) &&
        args.context.conditionsConfirmed !== true
      )
        input.context.conditionsConfirmed = false
      input.draftVersion = e.draftVersion
      if (args.note)
        input.context.note = [input.context.note, args.note]
          .filter(Boolean)
          .join('\n')
          .slice(-2000)
      input.context.note ||= input.reason
    }
    inputs.push(input)
  }
  // Even when all actions have already completed, replay a previously unknown
  // request under its original key. The journal, not the new status, owns it.
  const outcome = await submitRemembered(
    client,
    actor,
    batchId,
    items.map((i) => i.id),
    { items: inputs },
  )
  if (outcome.needsOriginalScope) return outcome
  if (outcome.idle)
    return {
      message: '已有资料已保留；当前需要补充资料或人工核验，请按以下待办继续。',
      items: summary(items),
    }
  let fresh
  try {
    fresh = select(await client.invoiceBatchActions(batchId))
  } catch {
    return {
      message:
        '上次提交已有回执，但当前进度暂时无法读取。请稍后查询进度，无需重复填写或提交。',
      progressUnavailable: true,
      receipt: outcome.result.id,
      scopeComplete: outcome.result.scopeComplete,
    }
  }
  return {
    message:
      outcome.result.scopeComplete === false
        ? '部分客户权限发生变化，当前无法确认全部项目的结果；请负责人核实，已有资料无需重填。'
        : outcome.recovered
          ? '已找回上次提交结果，无需重填。若本次又补充了新内容，请在核对结果后继续办理。'
          : '已按原资料续办，请查看每笔业务的待办；需要人工核验的已保留。',
    scopeComplete: outcome.result.scopeComplete,
    items: summary(fresh),
    receipt: outcome.result.id,
    failures: outcome.result.items
      .filter((i) => i.status === 'blocked')
      .map((i) => i.error),
  }
}
