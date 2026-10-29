# 代账逐户授权、批量申请与结果回录

状态：开发源码，未业务测试、未应用迁移、未部署或安装到 WorkBuddy。没有接入外部开票平台。

## 业务链路

1. 在客户月度工作单的「工作流处理、开票申请与成果回传」中登记授权。填写客户法定主体、代账机构、被授权经办、地区、适用渠道、起止日期和操作范围，选择或上传实际委托凭证。销方身份须与本月固定档案一致。
2. 另一名具有复核权限的人员查看原始凭证并核验。有效期按北京时间判断；授权只有「准备申请」「回录结果」两种本地范围。此登记不建立税务平台授权、不存密码、不代表该经办已获得平台开票权限。变更内容通过撤销旧授权、新建记录保留历史。
3. 单张申请在原界面选择授权；批量由 WorkBuddy 调用工作台统一入口。每批 1–50 项，必须明确每项工作单、版本、业务唯一编号、原始资料及有效授权版本。工作台复用单张申请规则保存草稿，人工核验仍独立完成。
4. 「批量开票申请」页面显示逐户缺项、授权、核验和回录状态，可进入对应工作单处理。批次标题限发起人及负责人读取；各项仍受客户权限隔离。其他复核人员可在有权访问的月度工作单中核验，不通过批次头扩大权限。
5. 用户已有真实开票渠道结果时，上传原始 PDF/图片回执，回录成功、明确失败或结果不明。成功必须有实际号码、日期、购销方、金额及附件，身份和金额逐项匹配已核验申请。不会用申请预期金额生成“成功回执”。失败和不明状态的票号、开票日期及金额留空，保留说明和凭证。
6. 未参与经办的人员核验回录；驳回保留原记录，修正另存草稿。结果不明、待核验或已有成功回录时禁止修改/撤回申请；结果不明可补充实际查明的结果，但不可重复开具。回录不会自动记账、交付或归档工作单。

## 一句话入口

- “按这些客户的实际委托凭证登记开票授权，列出等待人工核验的客户。”
- “为甲、乙客户准备这批开票申请，缺项逐户列出，并给我批次编号。”
- “查这批申请的进度，分别列出待授权、待补件、待核验和已有回录的项目。”
- “把这些真实发票和失败回执回录到原申请，保存草稿并列出待核验项。”

WorkBuddy 自行查询客户、期间、固定档案、工作单和附件，组织结构化参数；无法确定客户或实际业务信息时集中询问，不能扩大范围、猜测税率/授权或伪造回执。

| 目的 | WorkBuddy 工具 |
| --- | --- |
| 查看实际连接能力 | `team_invoicing_capabilities` |
| 上传凭证原件 | `team_upload_invoice_evidence` |
| 登记/查询授权 | `team_prepare_invoice_authorization`、`team_invoice_authorizations`、`team_invoice_authorization` |
| 单张申请/修订 | `team_prepare_invoice`、`team_revise_invoice` |
| 批量准备/查进度 | `team_prepare_invoice_batch`、`team_invoice_batches`、`team_invoice_batch` |
| 保存实际结果/查回录 | `team_prepare_invoice_result`、`team_invoice_results`、`team_invoice_request` |

MCP 不提供授权核验、申请核验、回录核验/驳回、开具或红冲动作。核验操作在工作台按员工权限和独立复核规则执行。

## 接口与恢复

- `POST /orders/:id/invoice-authorizations`：`key,payload,evidenceFileIds`。查询 `/companies/:id/invoice-authorizations` 和 `/invoice-authorizations/:id`；网页核验/撤销 `/invoice-authorizations/:id/verify|revoke`。
- 单张申请及修订增加可选 `authorization:{id,version}`。无授权可保留单张草稿，但不能确认。过期或撤销授权需选择新的有效记录；已有核验随修订失效。
- `POST /invoice-batches`：`key,title,items[]`。每项沿用单张申请参数，加 `orderId,itemKey`，且授权必填。相同工作单多项使用提交前的同一工作单版本，不会因本批前一项保存导致后一项误报版本冲突。
- 批量接口在一次有限事务内完成准备，业务校验失败按项回滚并保存 `blocked`；技术故障整体回滚。不是后台持续开票任务。批次与每项 key 稳定重放，超时后先查询或原样重试。修正 `blocked` 项使用新补办批次；成功项不重复提交。格式错误或包含无访问权限工作单时整体拒绝，不能借失败记录读取其他客户。
- `GET /invoice-batches` 和 `GET /invoice-batches/:id`：读取原始批次及每项申请最新状态。列表和回录/授权列表支持 `limit`、`offset`；批次详情最多 50 项。统计仅包含当前仍可访问客户。
- `POST /invoice-requests/:id/result-records`：`key,version,authorization,payload,evidenceFileIds`。`version` 是申请版本。回录固定原申请快照、授权版本、附件摘要；按请求标识防重，成功票号按组织/销方/代码/号码去重。一个申请最多一个待核验回录、一个核验通过的成功结果。
- `GET /invoice-requests/:id/result-records` 查询历史；网页 `/invoice-result-records/:id/verify|reject` 要求回录版本和说明，核验时再次检查资料、授权、身份、金额及凭证版本。
- 凭证上传复用 `/orders/:id/files?kind=evidence`。MCP 只接受员工授权交接目录内 50 MB 以内的 PDF/PNG/JPG 原件，返回文件编号。此类上传不改变业务输入版本；文件不在授权目录时不能代读。文件内容尚未做 OCR 或自动验真。

`prepared` 表示申请已保存；`ready` 表示申请已人工核验；`recordedIssued=true` 表示成功回执已人工核验。`issued=false`、`canIssue=false`、`taxAuthorityVerified=false` 始终保留，分别说明本工作台未执行开具、不能开具、未做税务平台在线查验。

## 交付边界

新增迁移 `018_invoice_agency.sql`，后续需连同前置迁移评审后再应用。当前未执行数据库迁移或业务验收。尚未实现跨平台实际开具、在线验真、红冲、部分开票/差额处理、自动识别回执、自动入账或定时提醒。现有 8096 和已安装 WorkBuddy 保持原版本。


## 后续源码扩展

已新增原批次项续办关联、客户记账规则、独立回录台账及记账草稿，详见 [批次续办与账务准备](INVOICE_CONTINUATION_ACCOUNTING.md)。原文“失败项新建补办批次”的手动方式仍可用于旧记录；新开发入口优先直接续办原项，保留原始失败原因与后续尝试。新增代码仍未测试上线，不代表已经可在当前部署使用。
