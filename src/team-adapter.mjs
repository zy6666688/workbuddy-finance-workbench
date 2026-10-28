import { createTeamClient } from './team-api-client.mjs'
import { realpath, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { loadTeamSession, defaultWorkspace } from './team-credentials.mjs'

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

export async function executeTeamCommand(client, command, args = {}) {
  switch (command) {
    case 'me': return client.me()
    case 'companies': return client.companies(args)
    case 'orders': return client.orders(args)
    case 'order': return client.order(args.orderId)
    case 'files': { const { orderId, ...query } = args; return client.files(orderId, query) }
    case 'workflows': return client.workflows()
    case 'jobs': return client.jobs()
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
    case 'return-run': { const { runId, ...body } = args; return client.returnRun(runId, body) }
    default: throw new Error('未知团队命令')
  }
}
