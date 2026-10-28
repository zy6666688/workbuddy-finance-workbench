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
  async function request(method, pathname, { query, body, multipart = false, binary = false } = {}) {
    const url = new URL('/api/v1' + pathname, base)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        cookie: `zy_session=${session}`,
        ...(method === 'POST' ? { 'x-csrf-token': csrf, ...(multipart ? {} : { 'content-type': 'application/json' }) } : {}),
      },
      ...(method === 'POST' ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    if (response.ok && binary) {
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
    const data = await response.json().catch(() => ({ error: '团队服务返回了无法解析的响应' }))
    if (!response.ok) throw Object.assign(new Error(data.error || '团队服务请求失败'), { status: response.status })
    return data
  }
  const id = value => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) throw new Error('编号格式不正确')
    return value
  }
  return {
    me: async () => { const { csrf: _csrf, ...actor } = await request('GET', '/auth/me'); return actor },
    logoutCurrent: () => request('POST', '/auth/session/logout', { body: {} }),
    companies: query => request('GET', '/companies', { query }),
    orders: query => request('GET', '/orders', { query }),
    order: orderId => request('GET', `/orders/${id(orderId)}`, { query: { compact: 1 } }),
    files: (orderId, query) => request('GET', `/orders/${id(orderId)}/files/page`, { query }),
    workflows: () => request('GET', '/workflows'),
    jobs: () => request('GET', '/jobs'),
    createJob: body => request('POST', '/jobs', { body }),
    downloadJob: jobId => request('GET', `/jobs/${id(jobId)}/download`, { binary: true }),
    downloadFile: fileId => request('GET', `/files/${id(fileId)}/download`, { binary: true }),
    createRun: (orderId, body) => request('POST', `/orders/${id(orderId)}/runs`, { body }),
    returnRun: (runId, body) => request('POST', `/runs/${id(runId)}/return`, { body }),
    uploadRunResult: (runId, { version, key, name, bytes }) => {
      const form = new FormData()
      form.set('file', new Blob([bytes]), name)
      return request('POST', `/runs/${id(runId)}/files`, { query: { version, key }, body: form, multipart: true })
    },
  }
}
