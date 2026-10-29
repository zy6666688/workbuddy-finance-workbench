import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resumeInvoiceWork } from '../src/invoice-assistant.mjs'

const args = {
  customer: '虚构明澄咨询',
  period: '2026-10',
  operation: 'continue',
}
const item = () => ({
  id: 'item',
  company_id: 'company',
  company_name: args.customer,
  orderPeriod: args.period,
  payload: {
    businessRef: '业务甲',
    payload: { buyerName: '旧购方', buyerTaxId: '', lines: [{ net: '100' }] },
    sourceFileIds: ['file'],
    authorization: { id: 'auth', version: 1 },
  },
  group: 'retry_available',
  allowedActions: ['retry'],
  expected: { attemptId: null, orderVersion: 2 },
  feedback: [{ message: '缺购方税号' }],
})
function client(workspace, rows = [item()]) {
  return {
    workspace,
    origin: 'http://127.0.0.1:8097',
    me: async () => ({ id: 'actor', org_id: 'org' }),
    companies: async () => [{ id: 'company', name: args.customer }],
    orders: async () => [{ id: 'order' }],
    invoiceBatches: async () => [{ id: 'batch', title: '虚构补件' }],
    invoiceBatchActions: async () => ({ items: rows }),
  }
}
test('一句话续办自动取版本、沿用资料；重启后只重放未知结果的原请求', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'invoice-assistant-'))
  try {
    const c = client(dir),
      sent = []
    c.continueInvoiceBatch = async (_, body) => {
      sent.push(structuredClone(body))
      throw Object.assign(Error('timeout'), { outcomeUnknown: true })
    }
    await assert.rejects(
      resumeInvoiceWork(c, {
        ...args,
        corrections: { buyerTaxId: 'SYNTHETIC' },
      }),
      /timeout/,
    )
    const restarted = client(dir, [
      { ...item(), group: 'application_review', allowedActions: [] },
    ])
    restarted.continueInvoiceBatch = async (_, body) => {
      sent.push(structuredClone(body))
      return {
        id: 'receipt',
        scopeComplete: true,
        items: [{ status: 'completed' }],
      }
    }
    const result = await resumeInvoiceWork(restarted, args)
    assert.deepEqual(sent[0], sent[1])
    assert.equal(sent[0].items[0].changes.payload.buyerName, '旧购方')
    assert.deepEqual(sent[0].items[0].changes.payload.lines, [{ net: '100' }])
    assert.equal(sent[0].items[0].changes.payload.buyerTaxId, 'SYNTHETIC')
    assert.match(result.message, /找回上次/)
    assert.deepEqual(await readdir(path.join(dir, '.invoice-resume')), [])
    const again = await resumeInvoiceWork(restarted, args)
    assert.match(again.message, /人工核验/)
    assert.equal(sent.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('多业务补件、歧义批次不扩大范围；只下载非过期已核验成果', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'invoice-assistant-'))
  try {
    const c = client(dir, [item(), { ...item(), id: 'other' }])
    await assert.rejects(
      resumeInvoiceWork(c, { ...args, operation: undefined }),
      /请明确/,
    )
    const result = await resumeInvoiceWork(c, {
      ...args,
      corrections: { buyerName: '新购方' },
    })
    assert.match(result.message, /哪一笔/)
    c.invoiceBatches = async () => [
      { id: 'one', title: '第一批' },
      { id: 'two', title: '第二批' },
    ]
    assert.equal((await resumeInvoiceWork(c, args)).choices.length, 2)
    c.invoiceBatches = async () => [{ id: 'batch', title: '批次' }]
    c.invoiceBatchActions = async () => ({
      items: [
        { ...item(), handoff: { draftId: 'good', stale: false } },
        { ...item(), id: 'other', handoff: { draftId: 'old', stale: true } },
      ],
    })
    const seen = []
    const download = await resumeInvoiceWork(
      c,
      { ...args, operation: 'download' },
      async (input) => {
        seen.push(input)
        return { absolutePath: 'saved.xlsx', state: 'downloaded' }
      },
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].draftId, 'good')
    assert.equal(download.files[0].state, 'downloaded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('首次账务资料可直接续办，规则变更不沿用旧确认；未知请求不扩大范围', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'invoice-assistant-'))
  try {
    const row = {
      ...item(),
      group: 'accounting_materials',
      allowedActions: ['accounting'],
      expected: {
        attemptId: null,
        orderVersion: 2,
        requestVersion: 1,
        draftVersion: 0,
      },
    }
    const c = client(dir, [row]),
      sent = []
    c.continueInvoiceBatch = async (_, body) => {
      sent.push(body)
      return {
        id: 'receipt',
        scopeComplete: true,
        items: [{ status: 'completed' }],
      }
    }
    await resumeInvoiceWork(c, {
      ...args,
      context: { businessType: '服务收入', note: '客户明确提供的确认说明' },
    })
    assert.equal(sent[0].items[0].action, 'accounting')
    assert.equal(sent[0].items[0].context.businessType, '服务收入')
    row.accountingDraft = {
      context: {
        ruleId: 'old',
        ruleVersion: 1,
        conditionsConfirmed: true,
        note: '原说明',
        evidence: [{ fileId: 'old-file' }],
      },
    }
    await resumeInvoiceWork(c, {
      ...args,
      context: { ruleId: 'new', ruleVersion: 2 },
    })
    assert.equal(sent[1].items[0].context.conditionsConfirmed, false)
    assert.deepEqual(sent[1].items[0].context.evidence, [
      { fileId: 'old-file' },
    ])
    c.continueInvoiceBatch = async () => {
      throw Object.assign(Error('timeout'), { outcomeUnknown: true })
    }
    await assert.rejects(resumeInvoiceWork(c, args), /timeout/)
    c.invoiceBatchActions = async () => ({
      items: [row, { ...row, id: 'extra' }],
    })
    const blocked = await resumeInvoiceWork(c, args)
    assert.equal(blocked.needsOriginalScope, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('并发相同办理共享稳定请求，部分权限回执不能报告全部完成', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'invoice-assistant-'))
  try {
    const c = client(dir),
      sent = []
    c.continueInvoiceBatch = async (_, body) => {
      sent.push(structuredClone(body))
      return { id: 'receipt', scopeComplete: false, items: [] }
    }
    const results = await Promise.all([
      resumeInvoiceWork(c, args),
      resumeInvoiceWork(c, args),
    ])
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0], sent[1])
    for (const result of results) assert.match(result.message, /无法确认全部/)
    assert.deepEqual(await readdir(path.join(dir, '.invoice-resume')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
