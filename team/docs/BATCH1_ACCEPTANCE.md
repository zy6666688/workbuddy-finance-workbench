# 第一批：客户档案与 WorkBuddy 查询

验收日期：2026-10-28（America/New_York）。范围是固定虚构样本、完整客户档案、档案查询与草稿准备。候选功能先在隔离测试服务中验收，随后按用户要求备份并部署到正式服务；当时已应用第 13、14 号迁移，未推送远程仓库。本机部署明细与桌面证据单独留存，不随公开 PR 发布；本轮新增流程检查见 `WORKFLOW_HEALTH_REVIEW.md`。

## 可使用的功能

客户公司 → 客户档案 → 完整客户档案：补充企业身份、行业、联系人、会计准则、启用期间、纳税人类型、地区、服务项目及多个银行账户。经办与复核来自公司／月份授权，停用或撤权会显示分工缺项。旧客户未知信息保持待补。

接账清单包括历史账簿、期初余额、往来、资产、存货和未处理事项。已收到须关联原件并说明依据；不适用须解释。长期档案独立上传，也可引用原属月度的附件，不改变原文件归属。资料登记完整不等于会计已复核。

编辑先保存待确认草稿，审阅字段差异与依据后由负责人或复核人员确认。已确认版本不可覆盖；已有月份使用固定版本，新版本不隐式改写历史。重新固定月份要求权限、最新工作单版本和理由，并使依赖旧资料的结果失效。送审或归档月份受状态限制。

本批另修复了编辑过程中刷新档案的并发缺陷：保存始终携带开始编辑时的版本，不能借刷新得到的新版本覆盖别人已确认的修改。

## WorkBuddy 使用示例

“查看这个客户 2026 年 1 月的会计口径、经办复核人员和接账资料，列出缺项、影响、适用档案版本和原件入口。本月尚未固定时明确提示，不要推断空白字段。”

“把联系人变更准备成档案草稿，保留其他字段，列出修改前后差异和依据，交由员工在网页确认。”

工具为 `team_client_dossier`、`team_client_dossier_revision`、`team_client_dossier_draft`、`team_prepare_client_dossier`。CLI 有对应命令。查询返回客户、期间、版本、分工、缺项及证据链接。MCP 不提供确认、绑定月份、审核或过账工具。

## 验收证据

| 检查 | 结果 |
|---|---|
| 团队类型检查、构建、纯测试 | 通过；49 项通过，9 项数据库测试在纯测试模式跳过 |
| 隔离 PostgreSQL 完整回归 | 66 项通过，0 失败，0 跳过 |
| 固定样本 HTTP 建档链路 | 4 套客户全部通过；草稿不生效、另一员工确认、月度绑定、依据关联和缺项列表已验证 |
| CLI／MCP 真实传输 | 查询身份、档案／历史／草稿、重复请求、草稿不自动生效、撤权立即拒绝均通过；使用临时加密授权目录，不覆盖用户授权 |
| 桌面及 390px 浏览器 | 编辑、保存草稿、展示差异、确认版本通过；手机页面内容宽度 390px，无横向溢出 |
| 浏览器并发回归 | 编辑期间另一请求确认新版本，再刷新并保存旧编辑，返回预期 409 并保留错误提示；没有静默覆盖 |
| 浏览器控制台 | 正常档案流程无错误；刻意制造版本冲突时出现预期 409。初始未登录时的 401 和 favicon 404不属于档案操作错误 |
| 重建容器、备份及独立恢复 | 通过；档案四张表、其余业务表摘要及 30,827 个文件摘要一致，授权隔离和队列所有权保持 |
| 个人版发布检查 | 在 Linux 验证环境完成 npm ci 与 verify:release，63 项测试及构建、安装卸载、资料包、安全扫描通过 |

真实浏览器截图及恢复结果保存于本机 `.test/results/`。CLI/MCP 测试是协议及服务端链路验收，未冒充 WorkBuddy 桌面 AI 的实际业务作答。完整法定报表、真实客户生产验收仍属后续阶段。依赖安装另报告现有一项 moderate 审计提示，本批没有开展依赖版本升级。

## 复现

从仓库根目录构建候选镜像：`docker build -t zy-finance-candidate:local -f team/Dockerfile .`。Windows 中文路径若触发 Docker 会话头错误，使用临时 ASCII 路径的源码副本构建，不改变原工作目录或正式服务。

进入 team 后，使用显式隔离配置（不要使用正式服务的 compose.override.yaml）：

```sh
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml -f compose.candidate.yaml up -d --no-build db migrate app worker gateway
docker compose -p zy-finance-test -f compose.yaml -f compose.test.yaml -f compose.candidate.yaml --profile test run --rm acceptance
```

PowerShell 运行样本、接入及恢复验收：

```powershell
$env:ZY_BRIDGE_SYNTHETIC_TEST='1'
node test/batch1-acceptance.mjs
node test/bridge-acceptance.mjs
$env:TEAM_TEST_CANDIDATE='1'
node ops/test-recovery.mjs
```

样本说明见 `test/fixtures/batch1/README.md`。样本测试只读固定文件；HTTP 测试在隔离数据库创建新的虚构机构，保留以便浏览器复核。浏览器授权状态只写入被 Git 忽略的 `.test/`，不得提交。
