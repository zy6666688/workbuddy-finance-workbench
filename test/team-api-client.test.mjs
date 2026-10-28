import test from 'node:test'
import assert from 'node:assert/strict'
import { createTeamClient } from '../src/team-api-client.mjs'
import { executeTeamCommand } from '../src/team-adapter.mjs'
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveTeamSession, loadTeamSession, clearTeamSession } from '../src/team-credentials.mjs'

const session = 'a'.repeat(64)
const csrf = 'b'.repeat(64)
const order = '30000000-0000-4000-8000-000000000001'

test('team client rejects unsafe endpoints and invalid session credentials', () => {
  for (const baseUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'file:///']) {
    assert.throws(() => createTeamClient({ baseUrl, session, csrf }))
  }
  assert.throws(() => createTeamClient({ baseUrl: 'http://127.0.0.1:8081', session: 'bad', csrf }))
})

test('team client forwards the employee session and prevents credential exposure in identity output', async () => {
  const calls = []
  const client = createTeamClient({ baseUrl: 'http://127.0.0.1:8081', session, csrf, fetchImpl: async (url, opts) => {
    calls.push({ url: String(url), opts })
    return new Response(JSON.stringify(url.pathname.endsWith('/me') ? { id: 'employee', csrf } : { ok: true }))
  } })
  assert.deepEqual(await client.me(), { id: 'employee' })
  await client.createRun(order, { version: 1, workflowId: 'workflow', fileIds: [] })
  assert.equal(calls[1].opts.headers.cookie, `zy_session=${session}`)
  assert.equal(calls[1].opts.headers['x-csrf-token'], csrf)
  assert.equal(calls[1].opts.redirect, 'error')
  assert.throws(() => client.order('../other'), /编号格式/)
})

test('team client preserves authorization failures without retrying with elevated credentials', async () => {
  let calls = 0
  const client = createTeamClient({ baseUrl: 'https://team.example', session, csrf, fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ error: '无权访问' }), { status: 403 })
  } })
  await assert.rejects(client.order(order), e => e.status === 403 && e.message === '无权访问')
  assert.equal(calls, 1)
})

test('command dispatcher uses only explicit operations and cannot access review actions', async () => {
  const client = { order: async id => ({ id }) }
  assert.deepEqual(await executeTeamCommand(client, 'order', { orderId: order }), { id: order })
  await assert.rejects(executeTeamCommand(client, 'approve', {}), /未知团队命令/)
  await assert.rejects(executeTeamCommand(client, 'request', { path: '/api/v1/orders' }), /未知团队命令/)
})

test('file handoff stays inside the selected workspace and never overwrites an existing file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'team-handoff-'))
  const old = process.env.ZY_TEAM_WORKSPACE
  process.env.ZY_TEAM_WORKSPACE = root
  try {
    await writeFile(path.join(root, 'result.txt'), 'synthetic result')
    let received
    const client = { uploadRunResult: async (_, data) => { received = data; return { id: 'file' } }, downloadJob: async () => Buffer.from('synthetic package') }
    await executeTeamCommand(client, 'upload-result', { runId: order, version: 1, filePath: 'result.txt' })
    assert.equal(received.bytes.toString(), 'synthetic result')
    await assert.rejects(executeTeamCommand(client, 'upload-result', { runId: order, version: 1, filePath: '../outside.txt' }))
    await executeTeamCommand(client, 'download-package', { jobId: order, filePath: 'package.zip' })
    assert.equal((await readFile(path.join(root, 'package.zip'))).toString(), 'synthetic package')
    await assert.rejects(executeTeamCommand(client, 'download-package', { jobId: order, filePath: 'package.zip' }), /EEXIST/)
    await unlink(path.join(root, 'package.zip')); await unlink(path.join(root, 'result.txt'))
  } finally {
    if (old === undefined) delete process.env.ZY_TEAM_WORKSPACE; else process.env.ZY_TEAM_WORKSPACE = old
    await rmdir(root)
  }
})

test('Windows employee authorization is encrypted at rest and removable', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'team-session-'))
  const old = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = root
  const credential = { baseUrl: 'https://team.example', session, csrf, workspace: root }
  try {
    await saveTeamSession(credential)
    const encrypted = await readFile(path.join(root, 'ZYFinance', 'workbuddy-session.dat'))
    assert.equal(encrypted.includes(Buffer.from(session)), false)
    assert.equal(encrypted.includes(Buffer.from(csrf)), false)
    assert.deepEqual(await loadTeamSession(), credential)
    await clearTeamSession()
    await assert.rejects(loadTeamSession(), /尚未授权/)
    await rmdir(path.join(root, 'ZYFinance'))
  } finally {
    if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old
    await rmdir(root)
  }
})
