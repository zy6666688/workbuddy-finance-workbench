import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

// Windows DPAPI ties the stored session to the current Windows account. It is
// not a security boundary between apps running as the same Windows user.
function crypt(input, operation) {
  if (process.platform !== 'win32') throw new Error('本机授权目前仅支持 Windows；请使用独立 Windows 账号')
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $x=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[System.Security.Cryptography.ProtectedData]::${operation}($x,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($v))`
  const p = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: Buffer.from(input).toString('base64'), encoding: 'utf8', windowsHide: true, maxBuffer: 65536 })
  if (p.error || p.status !== 0) throw new Error('Windows 用户凭据保护不可用，未保存授权')
  return Buffer.from(p.stdout.trim(), 'base64')
}

function sessionFile() {
  if (!process.env.LOCALAPPDATA) throw new Error('无法找到当前 Windows 用户目录')
  return path.join(process.env.LOCALAPPDATA, 'ZYFinance', 'workbuddy-session.dat')
}

export async function saveTeamSession(value) {
  const file = sessionFile(), dir = path.dirname(file)
  const encrypted = crypt(Buffer.from(JSON.stringify(value)), 'Protect')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `session-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

export async function loadTeamSession() {
  if (process.platform !== 'win32') throw new Error('尚未授权：本机员工授权目前仅支持 Windows')
  let encrypted
  try { encrypted = await readFile(sessionFile()) } catch (e) {
    if (e.code === 'ENOENT') throw new Error('尚未授权：请在本人 Windows 账号中运行 zy-finance-team login')
    throw new Error('无法读取本机员工授权')
  }
  try {
    const value = JSON.parse(crypt(encrypted, 'Unprotect').toString('utf8'))
    if (!value || typeof value !== 'object' || !value.baseUrl || !value.session || !value.csrf) throw new Error('invalid')
    return value
  } catch { throw new Error('本机员工授权无效，请重新登录') }
}

export async function clearTeamSession() {
  await unlink(sessionFile()).catch(e => { if (e.code !== 'ENOENT') throw e })
}

export function defaultWorkspace() { return path.join(os.homedir(), 'Documents', 'ZY-Finance-WorkBuddy') }

export async function authorizeEmployee({ baseUrl, username, password, workspace }) {
  const { createTeamClient } = await import('./team-api-client.mjs')
  createTeamClient({ baseUrl, session: '0'.repeat(64), csrf: '0'.repeat(64) })
  if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(username || '')) throw new Error('请输入有效的团队账号')
  if (typeof password !== 'string' || password.length > 128) throw new Error('密码格式不正确')
  const response = await fetch(new URL('/api/v1/auth/login', baseUrl), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30000) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || '登录失败')
  if (result.user?.must_change_password) throw new Error('请先在团队版网页修改初始密码，再进行授权')
  const session = response.headers.get('set-cookie')?.match(/(?:^|,\s*)zy_session=([a-f0-9]{64})/i)?.[1]
  if (!session || !/^[a-f0-9]{64}$/.test(result.csrf || '')) throw new Error('团队服务未返回有效员工会话')
  workspace = path.resolve(workspace || defaultWorkspace())
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await saveTeamSession({ baseUrl, session, csrf: result.csrf, workspace })
  return { ok: true, name: result.user.name, role: result.user.role, workspace }
}
