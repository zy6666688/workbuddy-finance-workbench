// Only synthetic isolated Docker environment; never target a production server.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import argon2 from 'argon2'
import AdmZip from 'adm-zip'
import { parse } from 'csv-parse/sync'
import { createHash } from 'node:crypto'
import { authorizeEmployee, loadTeamSession } from '../../src/team-credentials.mjs'

if (process.env.ZY_DESKTOP_SYNTHETIC !== '1') throw new Error('仅用于隔离的虚构验收')
const root = path.resolve('team/.test/desktop-bridge'), base = 'http://127.0.0.1:8081'
const api = async (auth, route, data) => {
  const multi = data instanceof FormData
  const res = await fetch(base + '/api/v1' + route, { method: data === undefined ? 'GET' : 'POST', headers: { cookie: `zy_session=${auth.session}`, ...(data === undefined ? {} : { 'x-csrf-token': auth.csrf, ...(multi ? {} : { 'content-type': 'application/json' }) }) }, ...(data === undefined ? {} : { body: multi ? data : JSON.stringify(data) }) })
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value
}
const login = async (username, password) => {
  const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!res.ok) throw new Error('虚构账号登录失败')
  return { session: res.headers.get('set-cookie').match(/zy_session=([^;]+)/)[1], csrf: (await res.json()).csrf }
}
const store = async (name, username, password, workspace) => {
  const old = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(root, name)
  try { await authorizeEmployee({ baseUrl: base, username, password, workspace }); return await loadTeamSession() }
  finally { if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old }
}
if (process.argv[2] === 'setup') {
  const org = randomUUID(), owner = randomUUID(), employee = randomUUID(), reviewer = randomUUID(), password = 'Synthetic-' + randomUUID(), hash = await argon2.hash(password)
  const users = [ ['owner', owner], ['operator', employee], ['reviewer', reviewer] ].map(([role, id]) => ({ id, role, username: `desktop_${role}_${id.replaceAll('-', '')}` }))
  const rows = users.map(u => `('${u.id}','${org}','${u.username}','虚构${u.role}','${hash}','${u.role}',false)`).join(',')
  execFileSync('docker', ['exec', 'zy-finance-test-db-1', 'psql', '-U', 'postgres', '-d', 'zy', '-v', 'ON_ERROR_STOP=1', '-c', `INSERT INTO organizations(id,name) VALUES('${org}','虚构桌面联调机构'); INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES ${rows}`], { stdio: 'pipe' })
  const admin = await login(users[0].username, password), workspace = path.join(root, 'workspace')
  const member = await store('operator', users[1].username, password, workspace)
  await store('reviewer', users[2].username, password, path.join(root, 'review-workspace'))
  const client = await api(admin, '/clients/onboard', { name: '虚构客户 · WorkBuddy桌面联调', code: 'WB-' + randomUUID(), profile: { contactName: '虚构联系人', contactPhone: '', serviceNotes: '仅隔离测试' }, checklist: [{ name: '银行流水', required: true }], assigneeId: employee, reviewerId: reviewer, firstMonth: { period: '2026-10', dueDate: '2026-11-10' } })
  const detail = () => api(member, `/orders/${client.orderId}`)
  const data = new FormData(); data.set('file', new Blob(['date,amount\n2026-10-01,100.00\n2026-10-02,200.00\n']), 'synthetic-bank.csv')
  const source = await api(member, `/orders/${client.orderId}/files?kind=source&version=${(await detail()).version}&key=${randomUUID()}&materialIndex=0`, data)
  for (const action of ['finish_collection', 'start_processing']) await api(member, `/orders/${client.orderId}/action`, { version: (await detail()).version, action })
  const workflows = await api(member, '/workflows')
  const meta = { companyId: client.id, orderId: client.orderId, sourceId: source.id, workflowId: workflows[0].id, workspace, accountRoot: path.join(root, 'operator'), testServer: base }
  await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'meta.json'), JSON.stringify(meta, null, 2))
  console.log(JSON.stringify(meta))
} else if (process.argv[2] === 'revise') {
  const meta = JSON.parse(await readFile(path.join(root, 'meta.json'), 'utf8'))
  const old = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(root, 'operator'); const member = await loadTeamSession()
  if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old
  const detail = () => api(member, `/orders/${meta.orderId}`)
  const current = await detail(), run = current.runs.find(r => r.status === 'returned' && r.active)
  if (!run) throw new Error('没有可退回的已回传执行')
  const next = await api(member, `/runs/${run.id}/revise`, { version: run.version, reason: process.argv[3] || '送审前发现未解决事项，补齐主结果表与异常明细表', fileIds: [meta.sourceId], key: randomUUID() })
  console.log(JSON.stringify({ orderId: meta.orderId, runId: next.id, supersedes: run.id }))
} else if (process.argv[2] === 'finish') {
  const meta = JSON.parse(await readFile(path.join(root, 'meta.json'), 'utf8'))
  const old = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(root, 'operator'); const member = await loadTeamSession()
  process.env.LOCALAPPDATA = path.join(root, 'reviewer'); const review = await loadTeamSession()
  if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old
  const detail = () => api(member, `/orders/${meta.orderId}`)
  const current = await detail()
  const active = current.runs.find(r => r.active && r.status === 'returned')
  if (!active || active.resultFiles.length !== 3 || current.runs.length < 3) throw new Error('当前修订未回传三份成果或修订记录不完整')
  const downloaded = []
  for (const f of active.resultFiles) {
    const response = await fetch(base + `/api/v1/files/${f.id}/download`, { headers: { cookie: `zy_session=${review.session}` } })
    if (!response.ok) throw new Error('复核人无法读取成果')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error('成果摘要不一致')
    downloaded.push({ name: f.name, bytes })
  }
  const csvs = downloaded.filter(f => f.name.toLowerCase().endsWith('.csv'))
  if (csvs.length !== 2 || downloaded.filter(f => f.name.toLowerCase().endsWith('.txt')).length !== 1) throw new Error('成果类型不符合预期')
  const sheets = csvs.map(f => parse(f.bytes.toString('utf8'), { bom: true, skip_empty_lines: true }))
  if (sheets.map(s => s.length).sort().join(',') !== '1,3') throw new Error('主结果须两条数据，零异常表只能保留表头')
  const main = sheets.find(s => s.length === 3), amountIndex = main[0].findIndex(x => /金额|amount/i.test(x))
  if (amountIndex < 0 || main.slice(1).map(row => row[amountIndex]).join(',') !== '100.00,200.00') throw new Error('虚构流水金额与输入不一致')
  await api(member, `/orders/${meta.orderId}/action`, { version: current.version, action: 'submit', checks: { passed: true, summary: '虚构样本清洗两行、合计300元；余额勾稽不在样本范围', unresolved: '' } })
  const self = await fetch(base + `/api/v1/orders/${meta.orderId}/action`, { method: 'POST', headers: { cookie: `zy_session=${member.session}`, 'x-csrf-token': member.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: (await detail()).version, action: 'approve', reason: '自审应被拒绝' }) })
  if (self.status !== 403) throw new Error('经办自审未被拒绝')
  await api(review, `/orders/${meta.orderId}/action`, { version: (await detail()).version, action: 'approve', reason: '已复核虚构样本及三份成果，不代表银行余额勾稽' })
  const job = await api(member, '/jobs', { kind: 'delivery_export', key: randomUUID(), companyId: meta.companyId, payload: { orderId: meta.orderId } })
  let jobState
  for (let i = 0; i < 30; i++) {
    jobState = (await api(member, '/jobs')).find(j => j.id === job.id)
    if (jobState?.status === 'completed') break
    if (jobState?.status === 'failed') throw new Error('交付包生成失败')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (jobState?.status !== 'completed') throw new Error('交付包未完成')
  const packageResponse = await fetch(base + `/api/v1/jobs/${job.id}/download`, { headers: { cookie: `zy_session=${member.session}` } })
  if (!packageResponse.ok) throw new Error('无法下载交付包')
  const zip = new AdmZip(Buffer.from(await packageResponse.arrayBuffer()))
  const manifest = JSON.parse(zip.readAsText('交付清单.json'))
  if (manifest.submission.files.length !== 3) throw new Error('交付包文件数量不匹配')
  for (const f of manifest.submission.files) {
    const entry = zip.getEntry(`results/${f.id}-${f.name}`)
    if (!entry || createHash('sha256').update(entry.getData()).digest('hex') !== f.sha256) throw new Error('交付包成果摘要不匹配')
  }
  const evidence = new FormData(); evidence.set('file', new Blob(['仅作虚构交付演练，未向客户发送']), 'synthetic-evidence.txt')
  const saved = await api(member, `/orders/${meta.orderId}/files?kind=evidence&version=${(await detail()).version}&key=${randomUUID()}`, evidence)
  await api(member, `/orders/${meta.orderId}/action`, { version: (await detail()).version, action: 'deliver', delivery: { channel: '虚构测试', evidenceFileId: saved.id } })
  const archived = await detail()
  if (archived.status !== 'archived' || archived.submission.files.length !== 3 || archived.runs.length < 3) throw new Error('归档快照或历史执行不完整')
  console.log(JSON.stringify({ status: archived.status, orderId: meta.orderId, results: archived.submission.files.map(f => ({ id: f.id, name: f.name, sha256: f.sha256 })), runs: archived.runs.length, selfReviewRejected: true }))
} else throw new Error('使用 setup、revise 或 finish')
