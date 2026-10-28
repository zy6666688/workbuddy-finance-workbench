import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { executeTeamCommand, teamClientFromEnvironment } from './team-adapter.mjs'

import { VERSION } from './version.js'

const APP_URI = 'ui://workbuddy-finance-workbench/dashboard'
const APP_MIME = 'text/html;profile=mcp-app'
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const widgetHtml = readFileSync(join(currentDirectory, 'widget.html'), 'utf8')

const server = new McpServer({ name: 'workbuddy-finance-workbench', version: VERSION })

// Calls go through the existing employee session and the normal team API.
// Deliberately do not expose an arbitrary HTTP tool or review/approval actions.
const teamTool = (name, description, inputSchema, command, readOnlyHint = true) => {
  server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint, destructiveHint: false, openWorldHint: true },
  }, async args => {
    try {
      const data = await executeTeamCommand(await teamClientFromEnvironment(), command, args)
      return { content: [{ type: 'text', text: JSON.stringify(data) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.status ? `团队服务拒绝请求 (${error.status})：${error.message}` : error.message }] }
    }
  })
}
const orderId = z.string().uuid().describe('团队版月度工作单编号')
const runId = z.string().uuid().describe('团队版工作流执行编号')
teamTool('team_whoami', '查看当前团队版员工身份，使用已经授权的员工会话。', {}, 'me')
teamTool('team_companies', '搜索当前员工有权访问的客户公司。', { search: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, 'companies')
teamTool('team_orders', '查询当前员工有权访问的月度工作单。', { companyId: z.string().uuid().optional(), period: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional(), search: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, 'orders')
teamTool('team_order', '读取授权工作单详情及执行记录。', { orderId }, 'order')
teamTool('team_files', '分页查询工作单附件；翻页需携带首次查询返回的 pageVersion。', { orderId, search: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), pageVersion: z.string().optional() }, 'files')
teamTool('team_workflows', '列出团队版标准工作流。', {}, 'workflows')
teamTool('team_jobs', '查看当前授权范围内的后台任务状态。', {}, 'jobs')
teamTool('team_create_run', '按输入文件版本创建任务；只会在已有经办工作单上创建，不代表 AI 已经处理。', { orderId, version: z.number().int().positive(), workflowId: z.string().max(100), fileIds: z.array(z.string().uuid()).min(1).max(100), key: z.string().uuid().optional(), taskBrief: z.record(z.string(), z.string()).optional() }, 'create-run', false)
teamTool('team_create_package', '为指定任务创建任务包；须复用同一请求标识以便安全重试。', { companyId: z.string().uuid(), runId, key: z.string().min(8).max(100) }, 'package', false)
teamTool('team_download_package', '将已完成的任务包下载到授权交接目录内；不会覆盖现有文件。', { jobId: z.string().uuid(), filePath: z.string().min(1).max(500) }, 'download-package', false)
teamTool('team_upload_result', '上传授权交接目录中的成果到指定执行；不自动回传或复核。', { runId, version: z.number().int().positive(), key: z.string().uuid(), filePath: z.string().min(1).max(500) }, 'upload-result', false)
teamTool('team_return_run', '回传属于此执行的已上传成果，须提供原输入摘要；仍需独立复核。', { runId, version: z.number().int().positive(), resultFileIds: z.array(z.string().uuid()).min(1).max(100), inputHashes: z.record(z.string(), z.string()), summary: z.string().min(1).max(4000) }, 'return-run', false)

server.registerTool('show_finance_workbench', {
  title: '打开 ZY 财务工作台（WorkBuddy 财务工作台）',
  description: '打开完整的交互式财务工作台，包含总览、往来、核算、异常、月结、资料索引、备份和 25 个财务工作流。用户说“打开财务工作台”或需要财务控制面板时使用。',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: APP_URI } },
}, async () => ({
  content: [{ type: 'text', text: 'ZY 财务工作台（WorkBuddy 财务工作台）已打开。终端环境会自动降级为本段文字；Web UI 会渲染完整交互界面。' }],
  structuredContent: { version: VERSION, modules: 20, workflows: 25, prompts: 25, mode: 'interactive-widget' },
  _meta: { ui: { resourceUri: APP_URI } },
}))

server.registerResource('finance-workbench-dashboard', APP_URI, {
  title: 'ZY 财务工作台（WorkBuddy 财务工作台）',
  description: '本机运行的交互式财务工作台 Widget',
  mimeType: APP_MIME,
  _meta: {
    ui: {
      prefersBorder: false,
      permissions: {},
      csp: { resourceDomains: [], connectDomains: [] },
    },
  },
}, async () => ({
  contents: [{
    uri: APP_URI,
    text: widgetHtml,
    mimeType: APP_MIME,
    _meta: {
      ui: {
        prefersBorder: false,
        permissions: {},
        csp: { resourceDomains: [], connectDomains: [] },
      },
    },
  }],
}))

await server.connect(new StdioServerTransport())
