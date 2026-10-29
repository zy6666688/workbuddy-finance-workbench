import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = new URL('../', import.meta.url)

test('WorkBuddy package contains a complete MCP App and one-click installers', async () => {
  const files = [
    '.codebuddy-plugin/plugin.json', '.mcp.json',
    'workbuddy/server.mjs', 'workbuddy/widget.html',
    'scripts/install-workbuddy-app.sh', 'scripts/uninstall-workbuddy-app.sh',
    'scripts/install-workbuddy-app.ps1', 'scripts/uninstall-workbuddy-app.ps1',
    '安装 WorkBuddy 财务工作台.command', '卸载 WorkBuddy 财务工作台.command',
  ]
  await Promise.all(files.map(file => access(new URL(file, root))))
  const html = await readFile(new URL('workbuddy/widget.html', root), 'utf8')
  assert.ok(Buffer.byteLength(html) < 256 * 1024, 'MCP App Widget must stay below the WorkBuddy prefetch limit')
  assert.match(html, /WorkBuddy 财务工作台/)
  assert.match(html, /DecompressionStream/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('WorkBuddy MCP server exposes and serves the interactive dashboard', async () => {
  // Never reuse the developer's real employee authorization for package tests.
  const sessionHome = await mkdtemp(join(tmpdir(), 'finance-no-session-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('workbuddy/server.mjs', root))],
    stderr: 'pipe',
    env: { LOCALAPPDATA: sessionHome },
  })
  const client = new Client({ name: 'finance-workbench-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.ok(tools.tools.some(tool => tool.name === 'show_finance_workbench'))
    assert.ok(tools.tools.some(tool => tool.name === 'team_order'))
    assert.ok(tools.tools.some(tool => tool.name === 'team_return_run'))
    assert.ok(tools.tools.find(tool => tool.name === 'team_start_workflow').inputSchema.required.includes('key'))
    assert.equal(tools.tools.find(tool => tool.name === 'team_workflow_status').annotations.readOnlyHint, true)
    assert.ok(!tools.tools.some(tool => /approve|review/.test(tool.name)))
    assert.equal(tools.tools.find(tool => tool.name === 'show_finance_workbench')._meta.ui.resourceUri, 'ui://workbuddy-finance-workbench/dashboard')
    const resources = await client.listResources()
    assert.equal(resources.resources[0].mimeType, 'text/html;profile=mcp-app')
    const resource = await client.readResource({ uri: 'ui://workbuddy-finance-workbench/dashboard' })
    assert.ok(resource.contents[0].text.length > 100000)
    const result = await client.callTool({ name: 'show_finance_workbench', arguments: {} })
    assert.equal(result.structuredContent.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
    assert.equal(result.structuredContent.modules, 20)
    assert.equal(result.structuredContent.workflows, 25)
    assert.equal(result.structuredContent.prompts, 25)
    const noSession = await client.callTool({ name: 'team_whoami', arguments: {} })
    assert.equal(noSession.isError, true)
    assert.match(noSession.content[0].text, /尚未授权|员工会话/)
  } finally {
    await client.close()
    await rmdir(sessionHome)
  }
})
