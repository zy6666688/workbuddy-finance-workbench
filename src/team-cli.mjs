#!/usr/bin/env node
import { executeTeamCommand, teamClientFromEnvironment } from './team-adapter.mjs'
import { authorizeEmployee, clearTeamSession } from './team-credentials.mjs'

async function parseParameters(values, command) {
  if (values.length === 0) return {}
  if (values.length === 1 && values[0] === '--json-stdin') {
    if (command === 'login') throw new Error('员工登录密码只能从本机交互终端输入')
    let data = ''
    for await (const chunk of process.stdin) { data += chunk; if (data.length > 128 * 1024) throw new Error('参数过大') }
    return JSON.parse(data)
  }
  if (values.every(value => value.startsWith('--') && value.includes('='))) {
    return Object.fromEntries(values.map(value => { const i = value.indexOf('='); return [value.slice(2, i), value.slice(i + 1)] }))
  }
  if (values.length === 1) return JSON.parse(values[0])
  throw new Error('请使用 --字段=值 或 --json-stdin 输入参数')
}

async function passwordPrompt() {
  if (!process.stdin.isTTY) throw new Error('员工登录必须在本机交互式终端中输入密码，不能由 AI 传入')
  process.stderr.write('团队账号密码（不显示）：')
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
  return await new Promise((resolve, reject) => {
    let password = ''
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', input); process.stderr.write('\n') }
    const input = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { done(); reject(new Error('已取消登录')); return }
        if (char === '\r' || char === '\n') { done(); resolve(password); return }
        if (char === '\u007f' || char === '\b') password = password.slice(0, -1)
        else if (char >= ' ' && password.length < 128) password += char
      }
    }
    process.stdin.on('data', input)
  })
}

async function login(args) {
  const baseUrl = args.url || 'http://127.0.0.1:8080'
  const password = await passwordPrompt()
  console.log(JSON.stringify(await authorizeEmployee({ baseUrl, username: args.username, password, workspace: args.workspace })))
}

try {
  const [command, ...values] = process.argv.slice(2)
  if (!command || command === '--help') {
    console.log('团队版：login、logout、local-logout、me、companies、orders、order、files、workflows、jobs、create-run、package、download-package、upload-result、return-run。参数可由 --字段=值 或 --json-stdin 输入。')
  } else if (command === 'login') {
    await login(await parseParameters(values, command))
  } else if (command === 'local-logout') {
    await clearTeamSession()
    console.log('本机授权已清除；要撤销服务端会话，请在团队版网页退出登录。')
  } else if (command === 'logout') {
    const client = await teamClientFromEnvironment()
    try { await client.logoutCurrent() } catch (error) { if (error.status !== 401) throw error }
    await clearTeamSession()
    console.log('本机授权已清除，当前设备会话已撤销或已过期。')
  } else {
    const result = await executeTeamCommand(await teamClientFromEnvironment(), command, await parseParameters(values, command))
    console.log(JSON.stringify(result))
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
