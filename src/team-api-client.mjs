// Shared transport for a WorkBuddy team adapter. Credentials are supplied by
// the caller; this module never creates, stores or prints an employee session.
export function createTeamClient({ baseUrl, session, csrf, fetchImpl = fetch }) {
  const base = new URL(baseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && loopback))) {
    throw new Error('团队服务地址必须是 HTTPS 根地址，或本机 HTTP 根地址')
  }
  if (!/^[a-f0-9]{64}$/.test(session || '') || !/^[a-f0-9]{64}$/.test(csrf || '')) {
    throw new Error('缺少有效的员工会话，请先完成团队版授权')
  }
  async function request(method, pathname, { query, body, multipart = false, binary = false, expectedType } = {}) {
    const url = new URL('/api/v1' + pathname, base)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    let response
    try {
      response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        cookie: `zy_session=${session}`,
        ...(method === 'POST' ? { 'x-csrf-token': csrf, ...(multipart ? {} : { 'content-type': 'application/json' }) } : {}),
      },
      ...(method === 'POST' ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
      })
    } catch {
      throw Object.assign(new Error(method === 'POST'
        ? '服务响应中断，本次提交结果尚不能确认；请查询原任务，或保留原请求标识及全部参数重试，不要新建重复任务。'
        : '服务响应中断，请重新查询。'), { outcomeUnknown: method === 'POST' })
    }
    if (response.ok && binary) {
      if (expectedType && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== expectedType)
        throw new Error('交接下载响应格式不正确，未保存文件；请重新查询成果后再下载。')
      const max = 100 * 1024 * 1024
      if (Number(response.headers.get('content-length') || 0) > max) throw new Error('下载文件超过本机交接上限')
      let size = 0
      const chunks = []
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > max) throw new Error('下载文件超过本机交接上限')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    }
    let data
    try {
      data = await response.json()
      if (data === null || typeof data !== 'object') throw new Error('invalid response')
    } catch {
      throw Object.assign(new Error(method === 'POST'
        ? '无法读取提交回执，不能确认是否已保存；请查询原任务，或使用相同请求标识和参数重试。'
        : '团队服务返回了无法解析的响应，请重新查询。'), { outcomeUnknown: method === 'POST', ...(!response.ok ? { status: response.status } : {}) })
    }
    if (!response.ok) throw Object.assign(new Error(data.error || '团队服务请求失败'), { status: response.status, requestId: data.requestId, outcomeUnknown: method === 'POST' && response.status >= 500 })
    return data
  }
  const id = value => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) throw new Error('编号格式不正确')
    return value
  }
  return {
    origin: base.origin,
    me: async () => { const { csrf: _csrf, ...actor } = await request('GET', '/auth/me'); return actor },
    logoutCurrent: () => request('POST', '/auth/session/logout', { body: {} }),
    companies: query => request('GET', '/companies', { query }),
    dossier: (companyId, period) => request('GET', `/companies/${id(companyId)}/dossier`, { query: { period } }),
    dossierRevision: (companyId, revisionId) => request('GET', `/companies/${id(companyId)}/dossier/revisions/${id(revisionId)}`),
    dossierDraft: (companyId, draftId) => request('GET', `/companies/${id(companyId)}/dossier/drafts/${id(draftId)}`),
    createDossierDraft: (companyId, body) => request('POST', `/companies/${id(companyId)}/dossier/drafts`, { body }),
    orders: query => request('GET', '/orders', { query }),
    order: orderId => request('GET', `/orders/${id(orderId)}`, { query: { compact: 1 } }),
    files: (orderId, query) => request('GET', `/orders/${id(orderId)}/files/page`, { query }),
    workflows: () => request('GET', '/workflows'),
    workflow: workflowId => {
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(workflowId || '')) throw new Error('工作流编号格式不正确')
      return request('GET', `/workflows/${workflowId}`)
    },
    jobs: () => request('GET', '/jobs'),
    createJob: body => request('POST', '/jobs', { body }),
    downloadJob: jobId => request('GET', `/jobs/${id(jobId)}/download`, { binary: true }),
    downloadFile: fileId => request('GET', `/files/${id(fileId)}/download`, { binary: true }),
    accountingTemplate: () => request('GET', '/accounting/template', { binary: true }),
    workflowTemplate: workflowId => {
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(workflowId || '')) throw new Error('工作流编号格式不正确')
      return request('GET', `/workflows/${workflowId}/template`, { binary: true })
    },
    uploadAccountingInput: (orderId, { version, key, sourceFileIds, reason, workflowId, name, bytes }) => {
      const form = new FormData(); form.set('sourceFileIds', sourceFileIds.map(id).join(',')); form.set('reason', reason); if (workflowId) form.set('workflowId', workflowId); form.set('file', new Blob([bytes]), name)
      return request('POST', `/orders/${id(orderId)}/accounting-input`, { query: { version, key }, body: form, multipart: true })
    },
    createRun: (orderId, body) => request('POST', `/orders/${id(orderId)}/runs`, { body }),
    startWorkflow: (orderId, body) => request('POST', `/orders/${id(orderId)}/workflow-tasks`, { body }),
    workflowStatus: runId => request('GET', `/workflow-tasks/${id(runId)}`),
    calculation: (runId, query) => request('GET', `/workflow-tasks/${id(runId)}/calculation`, { query }),
    returnCalculation: (runId, body) => request('POST', `/workflow-tasks/${id(runId)}/return-calculation`, { body }),
    reviseRun: (runId, body) => request('POST', `/runs/${id(runId)}/revise`, { body }),
    retryJob: jobId => request('POST', `/jobs/${id(jobId)}/retry`, { body: {} }),
    invoicingCapabilities: () => request('GET', '/invoicing/capabilities'),
    invoiceRequests: (orderId, query) => request('GET', `/orders/${id(orderId)}/invoice-requests`, { query }),
    prepareInvoice: (orderId, body) => request('POST', `/orders/${id(orderId)}/invoice-requests`, { body }),
    invoiceRequest: requestId => request('GET', `/invoice-requests/${id(requestId)}`),
    reviseInvoice: (requestId, body) => request('POST', `/invoice-requests/${id(requestId)}/revise`, { body }),
    invoiceRevisions: (requestId, query) => request('GET', `/invoice-requests/${id(requestId)}/revisions`, { query }),
    invoiceAuthorizations: (companyId, query) => request('GET', `/companies/${id(companyId)}/invoice-authorizations`, { query }),
    invoiceAuthorization: authorizationId => request('GET', `/invoice-authorizations/${id(authorizationId)}`),
    prepareInvoiceAuthorization: (orderId, body) => request('POST', `/orders/${id(orderId)}/invoice-authorizations`, { body }),
    prepareInvoiceBatch: body => request('POST', '/invoice-batches', { body }),
    invoiceBatches: query => request('GET', '/invoice-batches', { query }),
    invoiceBatch: batchId => request('GET', `/invoice-batches/${id(batchId)}`),
    invoiceBatchActions: batchId => request('GET', `/invoice-batches/${id(batchId)}/actions`),
    continueInvoiceBatch: (batchId, body) => request('POST', `/invoice-batches/${id(batchId)}/continue`, { body }),
    invoiceContinuation: continuationId => request('GET', `/invoice-continuations/${id(continuationId)}`),
    invoiceAccountingContext: (companyId, period) => request('GET', `/companies/${id(companyId)}/invoice-accounting-context`, { query: { period } }),
    invoiceAccountingRules: (companyId, query) => request('GET', `/companies/${id(companyId)}/invoice-accounting-rules`, { query }),
    invoiceAccountingRule: ruleId => request('GET', `/invoice-accounting-rules/${id(ruleId)}`),
    prepareInvoiceAccountingRule: (companyId, body) => request('POST', `/companies/${id(companyId)}/invoice-accounting-rules`, { body }),
    reviseInvoiceAccountingRule: (ruleId, body) => request('POST', `/invoice-accounting-rules/${id(ruleId)}/revise`, { body }),
    registerInvoiceLedger: (requestId, body) => request('POST', `/invoice-requests/${id(requestId)}/ledger`, { body }),
    invoiceLedger: (orderId, query) => request('GET', `/orders/${id(orderId)}/invoice-ledger`, { query }),
    invoiceLedgerEntry: (ledgerId, query) => request('GET', `/invoice-ledger/${id(ledgerId)}`, { query }),
    prepareInvoiceAccounting: (ledgerId, body) => request('POST', `/invoice-ledger/${id(ledgerId)}/accounting-drafts`, { body }),
    reviseInvoiceAccounting: (draftId, body) => request('POST', `/invoice-accounting-drafts/${id(draftId)}/revise`, { body }),
    invoiceAccountingDraft: draftId => request('GET', `/invoice-accounting-drafts/${id(draftId)}`),
    downloadInvoiceAccounting: (draftId, format) => request('GET', `/invoice-accounting-drafts/${id(draftId)}/export`, { query: { format }, binary: true,
      expectedType: format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    invoiceResults: (requestId, query) => request('GET', `/invoice-requests/${id(requestId)}/result-records`, { query }),
    prepareInvoiceResult: (requestId, body) => request('POST', `/invoice-requests/${id(requestId)}/result-records`, { body }),
    uploadInvoiceEvidence: (orderId, { version, key, purpose, name, bytes }) => {
      if (!['authorization', 'receipt'].includes(purpose)) throw new Error('请选择授权凭证或开票回执')
      const form = new FormData(); form.set('file', new Blob([bytes]), name)
      return request('POST', `/orders/${id(orderId)}/files`, { query: { version, key, kind: 'evidence', category: purpose === 'authorization' ? '客户开票授权凭证' : '开票结果回执' }, body: form, multipart: true })
    },
    returnRun: (runId, body) => request('POST', `/runs/${id(runId)}/return`, { body }),
    uploadRunResult: (runId, { version, key, name, bytes }) => {
      const form = new FormData()
      form.set('file', new Blob([bytes]), name)
      return request('POST', `/runs/${id(runId)}/files`, { query: { version, key }, body: form, multipart: true })
    },
  }
}
