// Local execution contracts. Never infer accounting policy or execute uploaded code.
export type Field = {
  key: string;
  label: string;
  type: "text" | "money" | "quantity" | "date";
  optional?: boolean;
};
export type Table = { key: string; label: string; fields: Field[] };
export type Contract = {
  tables: Table[];
  parameters: string[];
  scope: string;
  manual: string[];
};
const f = (
  key: string,
  label: string,
  type: Field["type"] = "text",
  optional = false,
): Field => ({ key, label, type, optional });
const t = (key: string, label: string, fields: Field[]): Table => ({
  key,
  label,
  fields,
});
const id = f("id", "业务唯一编号"),
  amount = f("amount", "金额（明确正负方向）", "money"),
  date = f("date", "业务日期", "date"),
  currency = f("currency", "币种"),
  party = f("party", "往来单位"),
  department = f("department", "部门");
const expense = t("expenses", "报销明细", [
  id,
  date,
  currency,
  amount,
  department,
  f("employee", "员工编号"),
  f("category", "标准费用类别"),
  f("project", "项目"),
  f("invoiceId", "发票唯一号"),
  f("approval", "审批状态：approved/pending/rejected"),
  f("merchant", "商户"),
  f("budget", "对应预算", "money", true),
]);
const movement = (key: string, label: string) =>
  t(key, label, [
    id,
    date,
    currency,
    amount,
    f("account", "账户编号"),
    f("reference", "双方共同的流水/结算编号"),
    party,
  ]);
const linked = (key: string, label: string) =>
  t(key, label, [
    id,
    date,
    currency,
    amount,
    party,
    f("contract", "合同或订单号"),
  ]);
const analysis = t("analysis", "同口径分析数据", [
  id,
  currency,
  department,
  f("project", "项目"),
  f("category", "科目/指标"),
  f("budgetVersion", "预算版本"),
  f("basis", "指标口径及依据"),
  f("budget", "预算金额", "money"),
  f("actual", "本期金额", "money"),
  f("previous", "上期金额", "money"),
  f("cause", "业务确认原因", "text", true),
]);
const general = t("data", "标准明细（名称映射须先明确）", [
  id,
  date,
  currency,
  amount,
  f("name", "标准名称"),
  department,
  f("sourceNote", "原文件/表/行映射依据"),
]);
const invoices = t("invoices", "发票明细（已识别且核对字段）", [
  id,
  date,
  currency,
  party,
  f("taxId", "对方税号"),
  f("expectedTaxId", "档案税号"),
  f("net", "不含税金额", "money"),
  f("tax", "税额", "money"),
  f("gross", "价税合计", "money"),
  f("status", "blue/red/void/unknown"),
  f("originalId", "红字关联原票号", "text", true),
]);
const c = (
  tables: Table[],
  scope: string,
  parameters: string[] = [],
  manual: string[] = [],
): Contract => ({ tables, scope, parameters, manual });
export const workflowContracts: Record<string, Contract> = {
  "excel-cleaning": c(
    [general],
    "按明确字段整理文本、校验日期金额、保留每行来源；不猜测字段映射、不删除重复行",
  ),
  "excel-merge": c(
    [general],
    "按同名工作表和固定列合并，列出缺字段与重复编号，按币种核对金额",
  ),
  "expense-summary": c(
    [expense],
    "只汇总审批标记 approved 且关键字段完整的明细，按部门/项目/类型及币种汇总",
    ["largeAmount"],
  ),
  "expense-duplicate-check": c(
    [expense],
    "重复发票及员工/金额/日期候选检测，保留原始记录，不认定违规",
    ["dateToleranceDays", "largeAmount"],
  ),
  "bank-reconcile": c(
    [movement("bank", "银行流水"), movement("ledger", "账务流水")],
    "相同账户、币种、方向、金额及共同业务编号的唯一精确匹配；其余保留候选",
    ["dateToleranceDays"],
  ),
  "order-cash-invoice": c(
    [
      linked("orders", "订单"),
      linked("receipts", "回款"),
      linked("invoices", "开票金额"),
    ],
    "按合同/订单、往来单位、币种分别汇总三方金额；金额一致只作为勾稽结果",
    [],
    ["退款、折扣、预收及多合同合并须拆分并提供依据"],
  ),
  "ar-aging": c(
    [
      t("receivables", "应收明细", [
        id,
        currency,
        party,
        f("dueDate", "到期日", "date"),
        amount,
        f("owner", "责任人"),
        f("dispute", "争议：yes/no"),
      ]),
    ],
    "按明确统计日、到期日计算逾期天数和固定账龄区间，争议款单列",
    ["asOfDate"],
  ),
  "ap-schedule": c(
    [
      t("payables", "应付明细", [
        id,
        currency,
        party,
        f("dueDate", "到期日", "date"),
        amount,
        f("invoiceId", "发票唯一号"),
        f("contract", "合同号"),
        f("approval", "审批：approved/pending/rejected"),
        f("documents", "资料：complete/missing"),
      ]),
    ],
    "检查重复和缺件，按到期日输出建议排期；只在同币种已给定余额下累计测算，不付款",
    ["asOfDate", "cashCurrency", "availableCash"],
  ),
  "invoice-ledger": c(
    [invoices],
    "整理已识别票面明细，校验唯一号、税号和金额关系；不做OCR、验真或开具",
  ),
  "invoice-payment-match": c(
    [linked("invoices", "发票应付"), linked("payments", "付款流水")],
    "按明确合同、供应商、币种汇总对应关系，列出未付/超付及复杂匹配待确认",
  ),
  "fixed-assets": c(
    [
      t("assets", "资产台账", [
        id,
        department,
        currency,
        f("activationDate", "启用日", "date"),
        f("cost", "原值", "money"),
        f("residual", "残值金额", "money"),
        f("months", "政策折旧月数", "quantity"),
        f("priorDepreciation", "累计已提折旧", "money"),
        f("bookDepreciation", "本期账面折旧", "money"),
        f("method", "方法：straight_line/other"),
        f("eligible", "本期应计提：yes/no"),
        f("policyEvidence", "折旧政策依据"),
        f("status", "active/disposed/transferred"),
      ]),
    ],
    "仅按明确直线法参数及本期计提标记测算单月折旧并与账面比较；不更新正式资产账",
    ["asOfDate"],
  ),
  "inventory-check": c(
    [
      t("inventory", "进销存汇总", [
        id,
        f("sku", "SKU"),
        f("warehouse", "仓库"),
        f("unit", "单位"),
        currency,
        ...["opening", "inbound", "outbound", "closing", "counted"].map(
          (k, i) =>
            f(
              k,
              ["期初数量", "入库数量", "出库数量", "系统期末数量", "实盘数量"][
                i
              ],
              "quantity",
            ),
        ),
        ...[
          "openingValue",
          "inboundValue",
          "outboundValue",
          "closingValue",
        ].map((k, i) =>
          f(
            k,
            ["期初金额", "入库金额", "出库金额", "系统期末金额"][i],
            "money",
          ),
        ),
      ]),
    ],
    "逐 SKU/仓库/单位计算理论期末，分别核对数量、实盘与金额；不推定计价法或成本",
  ),
  "payroll-check": c(
    [
      t("payroll", "工资", [
        id,
        currency,
        department,
        f("gross", "应发", "money"),
        f("social", "个人社保公积金扣款", "money"),
        f("tax", "个税扣款", "money"),
        f("other", "其他扣款", "money"),
        f("net", "实发", "money"),
      ]),
      t("social", "社保公积金", [id, currency, amount]),
      t("tax", "个税明细", [id, currency, amount]),
      t("roster", "本期人员范围", [
        id,
        f("status", "本期应计薪：yes/no"),
        f("evidence", "入离职生效与范围依据"),
      ]),
    ],
    "按员工编号核对人员覆盖和已给定扣款、实发金额；不计算法定税率或社保基数",
  ),
  "month-close-completeness": c(
    [
      t("close", "月结检查清单", [
        id,
        f("task", "任务"),
        f("owner", "责任人"),
        f("status", "done/pending/not_applicable"),
        f("evidenceFileId", "本次所选依据附件编号", "text", true),
        f("note", "完成/不适用依据"),
        f("dueDate", "预计完成日期", "date", true),
      ]),
    ],
    "结合工作单必需材料和明确月结清单检查证据、责任人、未完成事项；不自动结账",
  ),
  "budget-variance": c(
    [analysis],
    "按预算版本、口径和币种计算本期预算差、差异率和上期变化",
    ["varianceThreshold"],
  ),
  "cost-reduction": c(
    [analysis],
    "按部门/项目/科目识别费用增加与超预算，列出待业务解释项，不推定可削减金额",
    ["varianceThreshold"],
  ),
  "cashflow-forecast": c(
    [
      t("cash", "资金计划", [
        id,
        date,
        currency,
        amount,
        f("direction", "in/out"),
        f("scenario", "base/optimistic/stress"),
        f("status", "confirmed/estimated"),
        f("evidence", "计划依据"),
      ]),
    ],
    "按指定期初余额、币种和情景逐日滚动测算，不把预测当实际流水",
    ["asOfDate", "cashCurrency", "openingBalance"],
  ),
  "management-summary": c(
    [analysis],
    "生成有来源的指标事实、预算差和上期变化摘要；业务原因与决策建议待确认",
    ["varianceThreshold"],
  ),
  "full-table-anomaly": c(
    [general],
    "按固定字段检查空值、格式、重复编号和明确金额阈值，不做无依据的统计异常认定",
    ["largeAmount"],
  ),
  "voucher-archive": c(
    [
      t("archive", "附件归档索引", [
        id,
        f("voucherId", "凭证编号"),
        f("fileId", "本次所选附件编号"),
        f("category", "附件类别"),
        f("targetName", "建议归档名称"),
        f("evidence", "对应关系依据"),
      ]),
    ],
    "核实附件属于本次固定输入、生成摘要索引和缺件表；不移动删除原件、不改变正式归档状态",
  ),
  "contract-terms": c(
    [
      t("clauses", "合同条款原文及位置", [
        id,
        f("contract", "合同号"),
        f("sourceFileId", "本次所选合同附件编号"),
        f("location", "页码/条款号"),
        f("quote", "原文引述"),
        f("paymentDate", "明确付款日", "date", true),
        f("amount", "明确金额", "money", true),
        f("currency", "币种", "text", true),
        f("condition", "付款条件", "text", true),
      ]),
    ],
    "将有原件定位的摘录转为付款条件核验草稿；不读取扫描件、不自动解释条件或认定合同效力",
    [],
    ["原文摘录、条件解释、日期与金额须人工逐项核实"],
  ),
  "local-automation": c(
    [
      t("automation", "周期任务配置草稿", [
        id,
        f("workflowId", "工作流编号"),
        f("frequency", "daily/weekly/monthly"),
        f("timezone", "IANA时区"),
        f("sourceFileId", "固定输入附件编号"),
        f("owner", "负责人"),
        f("action", "draft/read_only"),
        f("enabled", "本阶段必须 no"),
      ]),
    ],
    "内置任务配置与范围校验，生成禁用的调度草稿；不启动定时器或外部调用",
    [],
    ["调度须在后续验收后单独启用；本次不是试运行记录"],
  ),
  "policy-knowledge": c(
    [
      t("policies", "制度条款索引", [
        id,
        f("sourceFileId", "本次所选制度附件编号"),
        f("version", "制度版本"),
        f("clause", "条款号"),
        f("text", "原文"),
        f("status", "current/expired/conflicting"),
        f("scope", "适用范围"),
      ]),
      t("questions", "问答请求", [
        id,
        f("question", "问题"),
        f("keyword", "明确检索词"),
      ]),
    ],
    "按明确检索词返回有效制度原文及出处，冲突或无依据时标记待确认；不生成无出处答案或对外发送",
    [],
    ["条款版本、适用范围与原文准确性仍需员工核实"],
  ),
};
export const parameterHelp: Record<string, string> = {
  asOfDate: "统计日 YYYY-MM-DD",
  dateToleranceDays: "日期容差整数 0–31 天",
  largeAmount: "大额提示阈值（按每条记录原币金额）",
  varianceThreshold: "差异率阈值，例如 0.1 表示 10%",
  cashCurrency: "余额对应币种",
  availableCash: "可用余额，十进制字符串",
  openingBalance: "期初余额，十进制字符串",
};
