---
name: finance-workbench
description: 面向财务人员的受控自动化工作流。用于收入、应收应付、报销、资金预算、资产、税务发票、工资、对账、成本、报表分析、投资、月结、审计与财务归档；要求字段口径、异常清单、结果校验、人工复核和处理留痕。
license: MIT
metadata:
  version: "2.7.1"
  repository: "https://github.com/zy6666688/workbuddy-finance-workbench"
---

# Finance Workbench Skill

## 何时使用

用户要求处理财务表格、票据、对账、往来、资金、预算、经营分析、月结检查或财务归档时使用。仅讨论一般财务知识、且不涉及文件或流程执行时，可以直接回答。

## 开始前必须完成

1. 阅读 `references/safety.md`。
2. 从 `references/workflows.json` 选择最匹配的工作流；不确定时先列出 2–3 个候选及差异。
3. 明确主体、期间、币种、单位、数据版本和输出目录。
4. 盘点输入文件，不修改原件。

## 标准执行闭环

1. **选场景**：范围缩小到一张表、一次核对或一个固定输出。
2. **备样本**：保留正常、缺失、重复、异常和特殊业务样本。
3. **定字段**：写清主键、字段类型、单位、口径、来源和必填项。
4. **写规则**：把经验改成可判断的条件，并区分确定、疑似和无法判断。
5. **先方案**：先给字段映射、公式、异常边界、拟输出和保存位置。
6. **小样本**：先跑 20–50 行，与人工结果逐条核对。
7. **补边界**：记录误判、漏项、权限限制和复杂关系。
8. **固化 SOP**：固定目录、命名、复核人、频率和日志。

## 执行要求

- 优先读取用户明确引用的文件，再读取任务目录内相关资料。
- 金额精确到分；日期统一为 `YYYY-MM-DD`；百分比保留两位小数。
- 每条结果保留源文件、工作表和原始行号，无法追溯时说明原因。
- 只处理副本；输出到单独目录；不覆盖、移动或删除原件。
- 疑似匹配只能列为候选，不得强行核销。
- 输出主结果、异常明细、行数/金额校验、处理日志和未完成项。
- 资料不足时集中询问一次必需缺项，不要反复零散追问。

## 团队版一句话任务

用户说“处理某客户某月资料，并告诉我进度”时，通过团队 MCP 完成下列步骤，不让用户手工拼接工具参数：

1. 查询当前身份、客户、期间、工作单、标准工作流和输入附件。遇到同名客户、缺期间或目的不明时集中澄清；只选择用户任务范围内的最新资料。工作单必须已进入经办处理阶段。
2. 先用 `team_workflow` 读取 `recommendedExecutionMode`、`inputContract`、`scope` 和 `manual`。25 个目录工作流均有程序内入口，但只有明确的机械规则和草稿准备已封装；不得把合同解释、制度适用判断或调度启用说成自动完成。
3. 两项账务计算沿用 `team_accounting_template`；其余工作流用 `team_workflow_template` 下载专用 XLSX。WorkBuddy 将原始资料映射到明确字段，保留来源，不猜税率、折旧政策、预算口径和缺失数值。模板的 `parameters` 要逐项按依据填写；金额、币种、日期和编号不得混用。优先用 `team_start_prepared_workflow` 一次上传整理主表、固定依据并安排本地执行，记录 `workflow.runId`，不要再次创建同一任务。已有标准输入时用 `team_start_workflow`，执行方式按推荐值选择 `embedded_accounting` 或 `embedded_rules`。原始图片/OCR、未映射复杂文件仍可用 `workbuddy` 处理方式。保存新输入会使旧任务失效，先保留需要的旧成果；失效任务不得默认为已完成。
4. 使用 `team_workflow_status` 按 runId 查询；可在当前会话有限次数查询（例如间隔 2、5、10 秒，最多 6 次），未就绪时回报任务编号和下一步。停止会话后不能承诺仍在运行模型或自动通知；下次凭任务编号恢复查询。
5. `ready` 仅表示任务包就绪，下载后按原工作流处理；`calculated` 只说明规则处理/草稿生成完毕。先用 `team_calculation(section=summary)` 读摘要，再分页读完 `section=issues`；规则工作流用 `section=rows` 读取明细，账务计算可用 `section=trial` 读试算。保留计算值及源行依据，不凭模型重算覆盖确定性结果。需要完整文件时下载 package.id 对应包。
6. WorkBuddy 文件处理任务按原上传/回传工具提交；内嵌计算使用 `team_return_calculation` 提交 jobId、当前 runVersion 和经办说明，由服务器一次归集计算原件与说明。不再把计算文件重复上传到普通回传入口。保留相同 jobId 和说明重试。`returned_with_issues` 表示已回传但异常未解决，不能送审；`returned` 仍待网页送审与独立复核，零差异不代表资料完整或已入账。
7. `failed` 时读取错误，以 `team_retry_job` 重试原后台任务，不重复新建。`stale` 时刷新工作单，按最新输入用 `team_revise_workflow` 修订（整理主表发生替换且存在多份 XLSX 时明确 preparedWorkbookId），保留原 key 重试；修订会自动沿用执行方式重新排队。`cancelled`、`blocked` 时停止沿用旧资料。`review` 等待独立复核，`delivery` 等待实际交付证据，`archived` 已归档。

## 开票申请

先调用 `team_invoicing_capabilities` 核实连接状态。对接尚未完成时，只能从当前工作单的真实业务原件准备申请。查询 `team_invoice_requests` 后按唯一业务编号调用 `team_prepare_invoice`，再用 `team_invoice_request` 查看缺项。源资料、销方、购方、商品、税号、税率、分类编码和金额必须有依据；不清楚的字段留空，汇总一次缺项。对已有申请用 `team_revise_invoice` 修改并记录原因；历史可用 `team_invoice_revisions` 分页读取。已核验申请修改后重新待核验。`ready` 是内部申请已核验，`issued=false` 表示本工作台未执行开具；未选择渠道不阻止本地申请管理。白居E仅是竞品调研对象，不是默认接入厂商。实际开票必须接入经核验的官方渠道，不能抓取内部接口、绕过认证或自动代替人工核验。此工具不提供确认、开具或红冲动作。

## 代账逐户授权、批量申请与结果回录

这些入口只调用本工作台，不连接外部开票平台。先读 `team_invoicing_capabilities`，功能未部署或接口不存在时明确报告，不使用旧工具假装完成。

1. 按用户明确的客户、期间和业务范围查询工作单、固定客户档案及 `team_invoice_authorizations`，逐户核对主体、有效期、操作范围和版本。`effective` 只表示本地凭证经人工核验且有效，不表示税务平台授权成功。没有凭证不得假定已授权，不询问或保存税务密码。
2. 用户提供实际委托凭证时，用 `team_upload_invoice_evidence(purpose=authorization)` 上传授权交接目录里的 PDF/图片原件，随后 `team_prepare_invoice_authorization` 保存草稿。另一名人员在网页核验后才能使用；不可代替该确认。授权范围只支持准备申请、回录结果，不能扩大为实际开具。
3. 批量申请先查询已有业务编号；刷新工作单版本。使用 `team_prepare_invoice_batch` 一次提交最多 50 项，每项带工作单、原始资料、授权 id/版本和不同的 itemKey、key。批次 key 与原参数保持稳定，超时原样重试或查询，不换 key 重建；返回批次编号。prepared 是草稿保存成功，仍须读取缺项和核验状态。只补办 blocked 项，不能重做成功项。单张仍用原申请/修订工具。
4. `team_invoice_batch` 跟踪逐户当前阶段，`team_invoice_request` 查看具体缺项。区分待授权、待补件、申请待核验、回录待核验及回录已核验；不可将不可见客户当作已完成。批次准备在调用内完成，没有后台自动开具或会话外持续通知。
5. 已有真实开票结果时，先 `team_invoice_results` 查询防重；`team_upload_invoice_evidence(purpose=receipt)` 上传实际回执，再用 `team_prepare_invoice_result` 保存草稿。成功数据必须读取实际回执，与原申请逐项核对，不能拿预期字段冒充实际号码、日期、身份和金额。失败/结果不明时票号、开票日期和金额留空，保留说明与凭证。结果不明禁止重复开票，先由实际办理渠道查清，再补录结果。
6. 回录须独立人员网页核验；驳回后另存修正草稿，保留历史。`recordedIssued=true` 仅表示已有成功回执被人工核验，`taxAuthorityVerified=false` 表示未在线查验。工作台不自动开具、验真、红冲、部分开票或入账。报告批次编号、各户状态、凭证归属和下一步人工事项。

## 批次续办和回录后的账务准备

用户说“把这批剩下的接着办”时，先用 `team_invoice_batch_actions` 读取逐项待办、最新尝试、申请和草稿版本，只选择用户明确范围内的项目。不得把缺少访问权限的项目报告为完成。

读取每项 `feedback` 汇总缺项，按 `nextStep` 报告下一步与对应工作单。`requiresHumanReview=true` 时提供待核验的申请／回录／草稿编号，交由独立人员在工作台处理；不调用自动通过。人工完成后再次查询同批 actions，继续具备依据的明确选中项。续办回执中的 `progressQuery` 指向当前进度查询，原回执不代表最新状态。

恢复失败项时先读取 `resume`：`canPrefill=true` 可沿用上次 changes/context/reason，只向用户确认缺项或变化部分，不能让用户从头再报已有资料。补件后重新读取 expected；`canPrefill=false` 表示申请或草稿已更换版本，旧输入仅供对照，先核对最新记录。账务驳回沿用当前 context 按 review_reason 修订；回录驳回用 `team_invoice_results` 读取原 payload、evidence、授权和核验意见，仅更正有依据的内容，再以新 key 保存回录草稿。原样超时重试沿用旧 key；已明确驳回后另存修正草稿才用新 key。这些操作不重新开票、不代替人工复核。

- `team_continue_invoice_batch` 一次提交最多 50 项：`repair` 修订已有缺项申请；`retry` 补办原未保存项；`ledger` 登记已核验成功回执；`accounting` 登记台账并准备记账草稿。每项携带 actions 返回的 `expected.attemptId`、工作单版本，以及操作需要的申请/草稿版本。保留批次 key 和原内容重试；网络结果不明时先查回执或原样重试，不换 key 盲目重建。修正业务失败后先刷新再用新 key。
- 读取 `team_invoice_continuation` 的每项 outcome 和 issues。completed 只表示该操作执行完毕；可能仍有 blocked 账务草稿。申请保存失败与实际开票失败不同，后者只核实原渠道并继续回录，不能自动重新申请或开具。
- 检查回执的 `scopeComplete`、`visibleItems` 和 `totalItems`。权限变化导致 `scopeComplete=false` 时，只报告可见结果与“部分项目当前无权访问”，不能推断整批完成，也不能为不可见项目新建申请。
- 账务先用 `team_invoice_accounting_context` 读取客户本期科目表、档案及现有凭证。用 `team_invoice_accounting_rules` / `team_invoice_accounting_rule` 查明确业务类型的规则；没有科目或规则不能编造。根据用户确认口径可用 `team_prepare_invoice_accounting_rule` / `team_revise_invoice_accounting_rule` 保存规则草稿，等待网页另一名人员核验。
- 实际成功回执经独立核验后，用 `team_register_invoice_ledger` 或批次 ledger/accounting 入口登记唯一台账。缺项、失败、不明或待核验回录不能进入记账准备。`team_invoice_ledger` / `team_invoice_ledger_entry` 查询台账及草稿版本。
- `team_prepare_invoice_accounting` / `team_revise_invoice_accounting` 仅准备草稿。明确处理日期、CNY 口径、普通蓝字销项业务、是否已入账、确认依据和附件对应关系。不得仅凭开票确认收入。new_entry 必须读取并绑定实际 `ruleId` 和 `ruleVersion`，确认适用条件；规则版本变化后重新核实，不沿用旧的 conditionsConfirmed。已入账使用 link_existing 关联本期原凭证；hold 保留不确定事项。跨期、外币、合并/拆分及复杂调整转人工处理。
- `team_invoice_accounting_draft` 查询分录、缺项、依据变化和独立复核状态。补件后修订成新版本；已核验历史成果不重复生成。stale 表示当前依据已有变化，历史核验不能当作按新依据又核验了一次。
- 独立复核后通过 `team_download_invoice_accounting` 下载 XLSX/JSON 至授权目录。`posted=false`，不改现有核对底稿、不写正式账套、不自动导入其他软件。报告每户当前状态、续办编号、草稿编号、成果位置及待人工事项。
- 下载回执只有 `state=downloaded` 才表示文件已保存；使用返回的草稿编号、格式、`absolutePath` 和摘要交接。文件已存在时核实原下载或换输出文件名，不覆盖；不将交接成果重新上传成原始资料。
- 工具错误返回 `outcomeUnknown=true` 时，提交结果仍不明。先查原任务；重试必须保留原 key 和全部参数，不凭超时报告失败或新建另一份任务。内嵌计算／WorkBuddy 成果回传后读取返回的 `progress.state/nextAction`，区分有异常、待送审、待独立复核和已归档。

## 人工复核要求

付款、入账、纳税申报、违规认定、会计政策和重大估计必须由授权人员最终确认。OCR、模型推断和异常标记不能直接作为正式结论。

## 完成回报

按 `templates/task-brief.md` 的结构报告：实际读取文件、实际生成文件、关键合计、勾稽结果、异常/待复核项、未完成事项及原因。不要只给操作建议。

## 工作流目录

`references/workflows.json` 是机器可读的完整目录，`references/workflows.md` 是便于人工查看的版本，`references/prompts/` 包含 01–25 号工作流各自独立、可直接复制的完整提示词。这些文件由仓库脚本生成，不要手工制造与目录不一致的编号。
