import { createTeamClient } from './team-api-client.mjs'
import { realpath, readFile, stat, writeFile, open, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { loadTeamSession, defaultWorkspace } from './team-credentials.mjs'
import { resumeInvoiceWork } from './invoice-assistant.mjs'

// A session must come from the employee's authorization flow. Do not accept
// credentials in tool parameters or publish them in tool output.
export async function teamClientFromEnvironment(env = process.env) {
  const synthetic = env.ZY_BRIDGE_SYNTHETIC_TEST === '1' && env.ZY_TEAM_URL === 'http://127.0.0.1:8081'
  const auth = synthetic ? { baseUrl: env.ZY_TEAM_URL, session: env.ZY_TEAM_SESSION, csrf: env.ZY_TEAM_CSRF, workspace: env.ZY_TEAM_WORKSPACE } : await loadTeamSession()
  const client = createTeamClient(auth)
  client.workspace = auth.workspace || defaultWorkspace()
  return client
}

async function workspacePath(file, forOutput = false, workspace) {
  workspace ||= process.env.ZY_TEAM_WORKSPACE
  if (!workspace) throw new Error('请先设置用于交接的本机工作目录')
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('文件必须使用工作目录内的相对路径')
  const root = await realpath(workspace)
  const absolute = path.resolve(root, file)
  const parent = await realpath(forOutput ? path.dirname(absolute) : absolute)
  const relative = path.relative(root, parent)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件不在授权交接目录内')
  return forOutput ? path.join(parent, path.basename(absolute)) : parent
}

async function saveHandoff(dest, bytes) {
  // Same-directory publication is atomic and link() refuses an existing target.
  // A failed write never leaves a partial file under the requested output name.
  const temporary = path.join(path.dirname(dest), `.invoice-handoff-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, dest)
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('交接文件已存在，未覆盖；请核实上次下载或指定另一个输出文件名。')
      throw error
    }
  } finally {
    // Only this call's exclusively created temporary file may be removed.
    await unlink(temporary).catch(() => {})
  }
}

export async function executeTeamCommand(client, command, args = {}) {
  switch (command) {
    case 'resume-invoice-work': return resumeInvoiceWork(client, args, input => executeTeamCommand(client, 'download-invoice-accounting', input))
    case 'me': return client.me()
    case 'companies': return client.companies(args)
    case 'client-dossier': return client.dossier(args.companyId, args.period)
    case 'client-dossier-revision': return client.dossierRevision(args.companyId, args.revisionId)
    case 'client-dossier-draft': return client.dossierDraft(args.companyId, args.draftId)
    case 'prepare-client-dossier': { const { companyId, ...body } = args; return client.createDossierDraft(companyId, body) }
    case 'orders': return client.orders(args)
    case 'order': return client.order(args.orderId)
    case 'files': { const { orderId, ...query } = args; return client.files(orderId, query) }
    case 'workflows': return client.workflows()
    case 'workflow': return client.workflow(args.workflowId)
    case 'jobs': return client.jobs()
    case 'download-file':
    case 'workflow-template':
    case 'accounting-template': {
      const dest = await workspacePath(args.filePath, true, client.workspace)
      const bytes = command === 'download-file' ? await client.downloadFile(args.fileId) : command === 'workflow-template' ? await client.workflowTemplate(args.workflowId) : await client.accountingTemplate()
      await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 })
      return { filePath: args.filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    case 'start-accounting':
    case 'start-prepared-workflow':
    case 'upload-accounting-input': {
      const source = await workspacePath(args.filePath, false, client.workspace)
      const info = await stat(source)
      if (!info.isFile() || info.size > 10 * 1024 * 1024 || !/\.xlsx$/i.test(source)) throw new Error('整理底稿必须为 10 MB 以内的标准 XLSX')
      if (command === 'start-accounting' && !['monthly-management-report', 'vat-monthly-check'].includes(args.workflowId)) throw new Error('请选择支持后台账务计算的工作流')
      if (command === 'start-prepared-workflow' && !/^[a-z][a-z0-9-]{0,99}$/.test(args.workflowId || '')) throw new Error('请指定工作流编号')
      return client.uploadAccountingInput(args.orderId, { ...args, name: path.basename(source), bytes: await readFile(source) })
    }
    case 'package': return client.createJob({ kind: 'run_export', key: args.key, companyId: args.companyId, payload: { runId: args.runId } })
    case 'download-package': {
      const dest = await workspacePath(args.filePath, true, client.workspace)
      const bytes = await client.downloadJob(args.jobId)
      await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 })
      return { filePath: args.filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    case 'upload-result': {
      const source = await workspacePath(args.filePath, false, client.workspace)
      const info = await stat(source)
      if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('成果必须是 50 MB 以内的普通文件')
      const bytes = await readFile(source)
      return client.uploadRunResult(args.runId, { version: args.version, key: args.key || randomUUID(), name: path.basename(source), bytes })
    }
    case 'create-run': { const { orderId, ...body } = args; return client.createRun(orderId, body) }
    case 'start-workflow': { const { orderId, ...body } = args; return client.startWorkflow(orderId, body) }
    case 'workflow-status': return client.workflowStatus(args.runId)
    case 'calculation': { const { runId, ...query } = args; return client.calculation(runId, query) }
    case 'return-calculation': { const { runId, ...body } = args; return client.returnCalculation(runId, body) }
    case 'revise-workflow': { const { runId, ...body } = args; return client.reviseRun(runId, body) }
    case 'retry-job': return client.retryJob(args.jobId)
    case 'invoicing-capabilities': return client.invoicingCapabilities()
    case 'invoice-requests': { const { orderId, ...query } = args; return client.invoiceRequests(orderId, query) }
    case 'prepare-invoice': { const { orderId, ...body } = args; return client.prepareInvoice(orderId, body) }
    case 'invoice-request': return client.invoiceRequest(args.requestId)
    case 'revise-invoice': { const { requestId, ...body } = args; return client.reviseInvoice(requestId, body) }
    case 'invoice-revisions': { const { requestId, ...query } = args; return client.invoiceRevisions(requestId, query) }
    case 'invoice-authorizations': { const { companyId, ...query } = args; return client.invoiceAuthorizations(companyId, query) }
    case 'invoice-authorization': return client.invoiceAuthorization(args.authorizationId)
    case 'prepare-invoice-authorization': { const { orderId, ...body } = args; return client.prepareInvoiceAuthorization(orderId, body) }
    case 'prepare-invoice-batch': return client.prepareInvoiceBatch(args)
    case 'invoice-batches': return client.invoiceBatches(args)
    case 'invoice-batch': return client.invoiceBatch(args.batchId)
    case 'invoice-batch-actions': return client.invoiceBatchActions(args.batchId)
    case 'continue-invoice-batch': { const { batchId, ...body } = args; return client.continueInvoiceBatch(batchId, body) }
    case 'invoice-continuation': return client.invoiceContinuation(args.continuationId)
    case 'invoice-accounting-context': return client.invoiceAccountingContext(args.companyId, args.period)
    case 'invoice-accounting-rules': { const { companyId, ...query } = args; return client.invoiceAccountingRules(companyId, query) }
    case 'invoice-accounting-rule': return client.invoiceAccountingRule(args.ruleId)
    case 'prepare-invoice-accounting-rule': { const { companyId, ...body } = args; return client.prepareInvoiceAccountingRule(companyId, body) }
    case 'revise-invoice-accounting-rule': { const { ruleId, ...body } = args; return client.reviseInvoiceAccountingRule(ruleId, body) }
    case 'register-invoice-ledger': { const { requestId, ...body } = args; return client.registerInvoiceLedger(requestId, body) }
    case 'invoice-ledger': { const { orderId, ...query } = args; return client.invoiceLedger(orderId, query) }
    case 'invoice-ledger-entry': { const { ledgerId, ...query } = args; return client.invoiceLedgerEntry(ledgerId, query) }
    case 'prepare-invoice-accounting': { const { ledgerId, ...body } = args; return client.prepareInvoiceAccounting(ledgerId, body) }
    case 'revise-invoice-accounting': { const { draftId, ...body } = args; return client.reviseInvoiceAccounting(draftId, body) }
    case 'invoice-accounting-draft': return client.invoiceAccountingDraft(args.draftId)
    case 'download-invoice-accounting': {
      if (!['json', 'xlsx'].includes(args.format)) throw new Error('交接成果格式须为 json 或 xlsx')
      if (path.extname(args.filePath).toLowerCase() !== '.' + args.format) throw new Error('输出文件扩展名须与交接成果格式一致')
      const dest = await workspacePath(args.filePath, true, client.workspace)
      const bytes = await client.downloadInvoiceAccounting(args.draftId, args.format)
      await saveHandoff(dest, bytes)
      return { draftId: args.draftId, format: args.format, filePath: args.filePath, absolutePath: dest,
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        state: 'downloaded', posted: false,
        nextAction: '已保存人工核验后的交接成果，可向用户返回保存位置。未写入正式账套；无需重新上传为原始资料。' }
    }
    case 'invoice-results': { const { requestId, ...query } = args; return client.invoiceResults(requestId, query) }
    case 'prepare-invoice-result': { const { requestId, ...body } = args; return client.prepareInvoiceResult(requestId, body) }
    case 'upload-invoice-evidence': {
      const source = await workspacePath(args.filePath, false, client.workspace)
      const info = await stat(source)
      if (!info.isFile() || info.size > 50 * 1024 * 1024 || !/\.(pdf|png|jpe?g)$/i.test(source)) throw new Error('授权或开票凭证须为 50 MB 以内的 PDF、PNG 或 JPG 原件')
      return client.uploadInvoiceEvidence(args.orderId, { ...args, name: path.basename(source), bytes: await readFile(source) })
    }
    case 'return-run': { const { runId, ...body } = args; return client.returnRun(runId, body) }
    default: throw new Error('未知团队命令')
  }
}
