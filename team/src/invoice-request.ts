import { Decimal } from "decimal.js";
import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).default("");
const amount = z
  .union([z.string().regex(/^\d{1,12}(\.\d{1,2})?$/), z.literal("")])
  .default("");
// Missing values remain missing. No default rate, buyer tax ID or tax classification.
export const invoicePayload = z
  .object({
    sellerName: text(200),
    sellerTaxId: text(30),
    buyerName: text(200),
    buyerTaxId: text(30),
    buyerKind: z
      .enum(["enterprise", "individual", "unknown"])
      .default("unknown"),
    invoiceType: z.enum(["ordinary", "special", "unknown"]).default("unknown"),
    businessDescription: text(2000),
    remark: text(1000),
    lines: z
      .array(
        z
          .object({
            name: text(200),
            specification: text(100),
            unit: text(30),
            quantity: z
              .union([
                z.string().regex(/^\d{1,12}(\.\d{1,8})?$/),
                z.literal(""),
              ])
              .default(""),
            taxCode: text(30),
            taxRate: z
              .union([
                z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/),
                z.literal(""),
              ])
              .default(""),
            net: amount,
            tax: amount,
            gross: amount,
            evidenceNote: text(500),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export function checkInvoice(raw: unknown) {
  const payload = invoicePayload.parse(raw);
  const issues: { field: string; message: string }[] = [];
  const required = (field: string, value: string, name: string) => {
    if (!value) issues.push({ field, message: `缺少${name}` });
  };
  required("sellerName", payload.sellerName, "销方名称");
  required("sellerTaxId", payload.sellerTaxId, "销方税号");
  required("buyerName", payload.buyerName, "购方名称");
  required("businessDescription", payload.businessDescription, "真实业务说明");
  if (payload.buyerKind === "unknown")
    issues.push({ field: "buyerKind", message: "须明确购方类型" });
  if (payload.invoiceType === "unknown")
    issues.push({ field: "invoiceType", message: "须明确发票类型" });
  if (payload.buyerKind === "enterprise")
    required("buyerTaxId", payload.buyerTaxId, "购方税号");
  if (payload.buyerKind === "individual" && payload.invoiceType === "special")
    issues.push({
      field: "invoiceType",
      message: "个人购方的专票申请需要单独核实，本接入不自动处理",
    });
  let net = new Decimal(0),
    tax = new Decimal(0),
    gross = new Decimal(0),
    complete = true;
  payload.lines.forEach((line, index) => {
    const prefix = `lines.${index}`;
    for (const [field, name] of [
      ["name", "商品名称"],
      ["taxCode", "已核验税收分类编码"],
      ["taxRate", "税率"],
      ["net", "不含税金额"],
      ["tax", "税额"],
      ["gross", "价税合计"],
      ["evidenceNote", "明细依据及原件位置"],
    ] as const)
      required(`${prefix}.${field}`, line[field], `第 ${index + 1} 行${name}`);
    if ([line.net, line.tax, line.gross].some((x) => x === "")) {
      complete = false;
      return;
    }
    const n = new Decimal(line.net),
      t = new Decimal(line.tax),
      g = new Decimal(line.gross);
    net = net.plus(n);
    tax = tax.plus(t);
    gross = gross.plus(g);
    if (!n.plus(t).equals(g))
      issues.push({
        field: prefix,
        message: `第 ${index + 1} 行不含税金额加税额不等于价税合计`,
      });
    if (g.lte(0))
      issues.push({
        field: prefix,
        message: `第 ${index + 1} 行金额须大于零；红字、折扣和特殊计税另行办理`,
      });
    if (
      line.taxRate !== "" &&
      !n.mul(line.taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).equals(t)
    )
      issues.push({
        field: `${prefix}.tax`,
        message: `第 ${index + 1} 行税额与所填税率的计算不一致，请核实口径`,
      });
  });
  return {
    payload,
    issues,
    totals: complete
      ? { net: net.toFixed(2), tax: tax.toFixed(2), gross: gross.toFixed(2) }
      : null,
    complete,
    requiresHumanReview: true,
    policyValidated: false,
  };
}

export const invoiceConnection = {
  provider: null,
  applicationManagement: true,
  agencyAuthorizations: true,
  batchApplications: true,
  offlineResultRecording: true,
  batchContinuation: true,
  accountingLedger: true,
  accountingDrafts: true,
  accountingRuleManagement: true,
  canPost: false,
  taxAuthorityVerification: false,
  connected: false,
  canIssue: false,
  state: "channel_not_selected",
  reason: "当前提供平台无关的申请、核验和进度管理；尚未选择实际开票渠道",
  nextAction: "在工作台完善申请并独立核验；开具渠道另行评估，不影响申请管理",
};
