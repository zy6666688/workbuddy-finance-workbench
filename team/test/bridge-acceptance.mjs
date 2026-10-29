// Explicit synthetic-only integration against the already running isolated test DB.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, unlink, rmdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import argon2 from 'argon2'
import AdmZip from 'adm-zip'
import { authorizeEmployee, loadTeamSession } from '../../src/team-credentials.mjs'
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

if (process.env.ZY_BRIDGE_SYNTHETIC_TEST !== '1') throw new Error('Only the isolated synthetic test environment may be used')
const base = 'http://127.0.0.1:8081', org = randomUUID(), owner = randomUUID(), employee = randomUUID(), reviewer = randomUUID()
const usernameOwner = 'bridge_owner_' + owner.replaceAll('-', ''), usernameEmployee = 'bridge_employee_' + employee.replaceAll('-', ''), usernameReviewer = 'bridge_review_' + reviewer.replaceAll('-', '')
const password = 'Synthetic-' + randomUUID(), hash = await argon2.hash(password)
const sql = `INSERT INTO organizations(id,name) VALUES('${org}','虚构接入测试机构'); INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES('${owner}','${org}','${usernameOwner}','虚构负责人','${hash}','owner',false),('${employee}','${org}','${usernameEmployee}','虚构会计','${hash}','operator',false),('${reviewer}','${org}','${usernameReviewer}','虚构复核','${hash}','reviewer',false);`
execFileSync('docker', ['exec', 'zy-finance-test-db-1', 'psql', '-U', 'postgres', '-d', 'zy', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' })
async function login(username) {
  const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
  assert.equal(r.status, 200)
  return { session: r.headers.get('set-cookie').match(/zy_session=([^;]+)/)[1], csrf: (await r.json()).csrf }
}
async function post(auth, url, body) {
  const r = await fetch(base + '/api/v1' + url, { method: 'POST', headers: { cookie: `zy_session=${auth.session}`, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result
}
const admin = await login(usernameOwner), reviewerSession = await login(usernameReviewer)
const company = await post(admin, '/companies', { name: '虚构客户接入测试', code: 'BRIDGE-' + randomUUID() })
const home = await mkdtemp(path.join(tmpdir(), 'zy-bridge-acceptance-'))
const workspace = path.join(home, 'workspace')
await mkdir(workspace)
const oldLocalAppData = process.env.LOCALAPPDATA
process.env.LOCALAPPDATA = home
await authorizeEmployee({ baseUrl: base, username: usernameEmployee, password, workspace })
const member = await loadTeamSession()
if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocalAppData
const env = { ...process.env, LOCALAPPDATA: home }
delete env.ZY_BRIDGE_SYNTHETIC_TEST; delete env.ZY_TEAM_SESSION; delete env.ZY_TEAM_CSRF
const runCli = (...args) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../workbuddy/team-cli.mjs', import.meta.url)), ...args], { env, encoding: 'utf8' }))
assert.equal(runCli('me').id, employee)
assert.equal(runCli('companies').length, 0)
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../workbuddy/server.mjs', import.meta.url))], env, stderr: 'pipe' })
const mcp = new Client({ name: 'synthetic-bridge-test', version: '1.0.0' })
try {
  await mcp.connect(transport)
  const call = async (name, args = {}) => mcp.callTool({ name, arguments: args })
  const identity = await call('team_whoami')
  assert.equal(JSON.parse(identity.content[0].text).id, employee)
  assert.equal(identity.content[0].text.includes(member.csrf), false)
  assert.equal(JSON.parse((await call('team_companies')).content[0].text).length, 0)
  await post(admin, `/companies/${company.id}/members`, { userId: employee, enabled: true })
  assert.equal(JSON.parse((await call('team_companies')).content[0].text)[0].id, company.id)
  const dossierArgs = { companyId: company.id, period: '2026-01' }
  const dossier = JSON.parse((await call('team_client_dossier', dossierArgs)).content[0].text)
  assert.equal(dossier.company.id, company.id)
  assert.equal(dossier.period, '2026-01')
  assert.equal(dossier.selectedVersion, 0)
  assert.ok(dossier.gaps.some(g => g.key === 'opening'))
  assert.deepEqual(runCli('client-dossier', JSON.stringify(dossierArgs)).payload, dossier.payload)
  const draftArgs = { companyId: company.id, version: 0, companyVersion: dossier.company.version, key: randomUUID(), effectiveFrom: '2026-01', reason: '虚构接入验收草稿', payload: dossier.payload }
  const draftResult = await call('team_prepare_client_dossier', draftArgs)
  assert.ok(!draftResult.isError, JSON.stringify(draftResult))
  const prepared = JSON.parse(draftResult.content[0].text)
  assert.equal(JSON.parse((await call('team_prepare_client_dossier', draftArgs)).content[0].text).id, prepared.id)
  assert.equal(JSON.parse((await call('team_client_dossier', dossierArgs)).content[0].text).selectedVersion, 0)
  assert.equal(JSON.parse((await call('team_client_dossier_draft', { companyId: company.id, draftId: prepared.id })).content[0].text).status, 'pending')
  const revision = await post(admin, `/companies/${company.id}/dossier/drafts/${prepared.id}/confirm`, { version: 0 })
  assert.equal(JSON.parse((await call('team_client_dossier_revision', { companyId: company.id, revisionId: revision.id })).content[0].text).version, 1)
  assert.ok(!(await mcp.listTools()).tools.some(t => /confirm|bind/.test(t.name)))
  await post(admin, `/companies/${company.id}/members`, { userId: employee, enabled: false })
  assert.equal(JSON.parse((await call('team_companies')).content[0].text).length, 0)
  assert.equal((await call('team_client_dossier', dossierArgs)).isError, true)
  assert.ok(!(await mcp.listTools()).tools.some(t => /approve|review/.test(t.name)))
  console.log('隔离数据库测试通过：CLI 身份、MCP 身份、公司授权和同一会话即时撤权；复核工具未暴露。')
  const client = await post(admin, '/clients/onboard', {
    name: '虚构客户 · 接入流程', code: 'BRIDGE-' + randomUUID(),
    profile: { contactName: '虚构联系人', contactPhone: '', serviceNotes: '仅供隔离测试' },
    checklist: [{ name: '银行流水', required: true }], assigneeId: employee, reviewerId: reviewer,
    firstMonth: { period: '2026-10', dueDate: '2026-11-10' },
  })
  const cliOrder = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../workbuddy/team-cli.mjs', import.meta.url)), 'order', '--json-stdin'], { env, input: JSON.stringify({ orderId: client.orderId }), encoding: 'utf8' }))
  assert.equal(cliOrder.id, client.orderId)
  const request = async (auth, url, body, expected = 200) => {
    const multipart = body instanceof FormData
    const r = await fetch(base + '/api/v1' + url, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `zy_session=${auth.session}`, ...(body === undefined ? {} : { 'x-csrf-token': auth.csrf, ...(multipart ? {} : { 'content-type': 'application/json' }) }) }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) })
    const value = await r.json(); assert.equal(r.status, expected, JSON.stringify(value)); return value
  }
  const detail = () => request(member, `/orders/${client.orderId}`)
  const upload = async (kind, name, contents, index) => {
    const data = new FormData(); data.set('file', new Blob([contents]), name)
    return request(member, `/orders/${client.orderId}/files?kind=${kind}&version=${(await detail()).version}&key=${randomUUID()}${index === undefined ? '' : '&materialIndex=' + index}`, data)
  }
  const action = async (auth, action, extra = {}, expected = 200) => request(auth, `/orders/${client.orderId}/action`, { version: (await detail()).version, action, ...extra }, expected)
  const source = await upload('source', 'synthetic-bank.csv', 'date,amount\n2026-10-01,100.00\n', 0)
  await action(member, 'finish_collection'); await action(member, 'start_processing')
  const workbook = {accounts:[{code:'1001',name:'银行',category:'asset',opening:'1000'},{code:'2001',name:'税额',category:'liability',opening:'0'},{code:'3001',name:'权益',category:'equity',opening:'-1000'},{code:'4001',name:'收入',category:'revenue',opening:'0'}],vouchers:[{number:'V1',date:'2026-10-05',lines:[{account:'1001',debit:'113',credit:'0'},{account:'4001',debit:'0',credit:'100'},{account:'2001',debit:'0',credit:'13'}]}],invoices:[{number:'I1',date:'2026-10-05',kind:'sale',net:'100',tax:'13',gross:'113',voucher:'V1',account:'4001',taxAccount:'2001'}]}
  const accounting = await request(member, `/companies/${client.id}/accounting/2026-10`, {version:0,payload:workbook})
  assert.deepEqual(accounting.report.issues, [])
  assert.equal(accounting.report.summary.assets, '1113.00')
  const bad = {...workbook, invoices:[{...workbook.invoices[0],gross:'112'}]}
  const badSaved = await request(member, `/companies/${client.id}/accounting/2026-10`, {version:1,payload:bad})
  assert.ok(badSaved.report.issues.length)
  const badFile = new FormData();badFile.set('file',new Blob(['虚构人工成果']),'bad-result.txt')
  const manual = await request(member, `/orders/${client.orderId}/files?kind=result&origin=manual&version=${(await detail()).version}&key=${randomUUID()}`,badFile)
  await action(member,'submit',{manualFileIds:[manual.id],checks:{passed:true,summary:'虚构检查',unresolved:''}},400)
  const fixed = await request(member, `/companies/${client.id}/accounting/2026-10`, {version:2,payload:workbook})
  assert.deepEqual(fixed.report.issues,[])


  const workflows = JSON.parse((await call('team_workflows')).content[0].text)
  const startArgs = { orderId: client.orderId, version: (await detail()).version, workflowId: workflows[0].id, fileIds: [source.id], key: randomUUID(), taskBrief: { requirements: '仅处理虚构资料，输出核对摘要' } }
  const created = await call('team_start_workflow', startArgs)
  assert.equal(created.isError, undefined, JSON.stringify(created)); const task = JSON.parse(created.content[0].text)
  const run = { id: task.runId }, job = task.package
  assert.equal(JSON.parse((await call('team_start_workflow', startArgs)).content[0].text).runId, run.id)
  const progress = async () => JSON.parse((await call('team_workflow_status', { runId: run.id })).content[0].text)
  assert.equal(runCli('workflow-status', JSON.stringify({ runId: run.id })).runId, run.id)
  let completed
  for (let i = 0; i < 30; i++) {
    completed = await progress()
    if (completed.state === 'ready') break
    if (completed.state === 'failed') throw new Error('任务包生成失败')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(completed?.state, 'ready')
  assert.equal(completed.package.id, job.id)
  const downloaded = await call('team_download_package', { jobId: job.id, filePath: 'synthetic-package.zip' })
  assert.equal(downloaded.isError, undefined, JSON.stringify(downloaded))
  const manifest = JSON.parse(new AdmZip(await readFile(path.join(workspace, 'synthetic-package.zip'))).readAsText('return-manifest.json'))
  // Simulated output verifies transport only; it is not a real WorkBuddy AI run.
  await writeFile(path.join(workspace, 'synthetic-result.txt'), '虚构核对：1 笔，100.00 元。')
  const runNow = (await detail()).runs.find(x => x.id === run.id)
  const uploaded = await call('team_upload_result', { runId: run.id, version: runNow.version, key: randomUUID(), filePath: 'synthetic-result.txt' })
  assert.equal(uploaded.isError, undefined, JSON.stringify(uploaded)); const file = JSON.parse(uploaded.content[0].text)
  const returned = await call('team_return_run', { runId: run.id, version: (await detail()).runs.find(x => x.id === run.id).version, inputHashes: manifest.inputHashes, resultFileIds: [file.id], summary: '模拟传输测试，实际财务判断待复核' })
  assert.equal(returned.isError, undefined, JSON.stringify(returned))
  assert.equal((await progress()).state, 'returned')
  await action(member, 'submit', { checks: { passed: true, summary: '虚构测试资料已检查', unresolved: '' } })
  assert.equal((await detail()).submission.accounting.version, 3)
  assert.equal((await progress()).state, 'review')
  await action(member, 'approve', { reason: '自审必须拒绝' }, 403)
  await action(reviewerSession, 'approve', { reason: '虚构复核通过' })
  assert.equal((await progress()).state, 'delivery')
  const evidence = await upload('evidence', 'synthetic-evidence.txt', '虚构交付记录，不发送客户信息')
  await action(member, 'deliver', { delivery: { channel: '虚构测试', evidenceFileId: evidence.id } })
  assert.equal((await detail()).status, 'archived')
  assert.equal((await progress()).state, 'archived')
  await request(member, `/companies/${client.id}/accounting/2026-10`, {version:3,payload:workbook},409)
  console.log('虚构流程传输测试通过：建档、收集、MCP 任务包、模拟成果、回传、独立复核和归档；未调用 WorkBuddy AI。')
  const secondSession = await login(usernameEmployee, password)
  execFileSync(process.execPath, [fileURLToPath(new URL('../../workbuddy/team-cli.mjs', import.meta.url)), 'logout'], { env, encoding: 'utf8' })
  const afterLogout = await fetch(base + '/api/v1/auth/me', { headers: { cookie: `zy_session=${member.session}` } })
  const otherDevice = await fetch(base + '/api/v1/auth/me', { headers: { cookie: `zy_session=${secondSession.session}` } })
  assert.equal(afterLogout.status, 401)
  assert.equal(otherDevice.status, 200)
  console.log('员工退出测试通过：只撤销本机授权会话，另一设备会话仍有效。')
} finally {
  await mcp.close()
  await unlink(path.join(workspace, 'synthetic-package.zip')).catch(() => {})
  await unlink(path.join(workspace, 'synthetic-result.txt')).catch(() => {})
  await unlink(path.join(home, 'ZYFinance', 'workbuddy-session.dat')).catch(e => { if (e.code !== 'ENOENT') throw e })
  await rmdir(path.join(home, 'ZYFinance'))
  await rmdir(workspace)
  await rmdir(home)
}
