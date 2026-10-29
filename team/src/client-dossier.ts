import { z } from "zod";

const text = z.string().trim().max(200);
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const evidenceRef = z.object({ kind: z.enum(["monthly", "archive"]), id: z.uuid() }).strict();
export const intakeTopics = [
  { key: "books", name: "历史账簿", impact: "无法核对历史发生额和接账范围" },
  { key: "opening", name: "期初余额", impact: "无法确定正式账套起点及期初平衡" },
  { key: "parties", name: "往来明细", impact: "无法核对客户、供应商及其他往来余额" },
  { key: "assets", name: "资产清单", impact: "无法核对资产原值、折旧及期初净值" },
  { key: "inventory", name: "存货明细", impact: "无法核对数量、金额及后续成本结转" },
  { key: "unresolved", name: "未处理事项", impact: "无法确认跨期及待更正事项是否完整交接" },
] as const;
const intakeItem = z.object({
  key: z.enum(["books", "opening", "parties", "assets", "inventory", "unresolved"]),
  status: z.enum(["missing", "provided", "not_applicable"]),
  note: z.string().trim().max(2000),
  evidence: z.array(evidenceRef).max(20),
}).strict().superRefine((v, ctx) => {
  if (v.status !== "missing" && !v.note) ctx.addIssue({ code: "custom", message: "已收到或不适用须填写依据说明", path: ["note"] });
  if (v.status === "provided" && !v.evidence.length) ctx.addIssue({ code: "custom", message: "已收到须关联依据附件", path: ["evidence"] });
});
export const dossierPayload = z.object({
  legalName: text, creditCode: z.string().trim().toUpperCase().regex(/^$|^[0-9A-HJ-NPQRTUWXY]{18}$/),
  industry: z.enum(["", "trade", "services"]), contactName: text, contactPhone: text,
  reportingBasis: z.enum(["", "small_2011", "enterprise"]), activationPeriod: z.union([month, z.literal("")]),
  taxpayerType: z.enum(["", "small", "general"]), taxRegion: text,
  services: z.array(text.min(1)).max(30),
  bankStatus: z.enum(["unknown", "none", "listed"]), bankNote: z.string().trim().max(2000),
  banks: z.array(z.object({ bankName: text.min(1), accountName: text.min(1), accountNumber: z.string().trim().regex(/^[0-9A-Za-z -]{4,64}$/) }).strict()).max(30),
  intake: z.array(intakeItem).length(6), evidence: z.array(evidenceRef).max(50),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.intake.map(i => i.key)).size !== 6) ctx.addIssue({ code: "custom", message: "接账清单须包含六个不同项目", path: ["intake"] });
  if (v.bankStatus === "none" && !v.bankNote) ctx.addIssue({ code: "custom", message: "无银行账户须说明依据", path: ["bankNote"] });
  if ((v.bankStatus === "listed") !== (v.banks.length > 0)) ctx.addIssue({ code: "custom", message: "银行账户状态与明细不一致", path: ["banks"] });
  if (new Set(v.banks.map(b => b.accountNumber.replaceAll(" ", ""))).size !== v.banks.length) ctx.addIssue({ code: "custom", message: "银行账户重复", path: ["banks"] });
});
export type DossierPayload = z.infer<typeof dossierPayload>;
export function emptyDossier(c: any): DossierPayload {
  return { legalName: c.name || "", creditCode: "", industry: "", contactName: c.profile?.contactName || "", contactPhone: c.profile?.contactPhone || "", reportingBasis: "", activationPeriod: "", taxpayerType: "", taxRegion: "", services: [], bankStatus: "unknown", bankNote: "", banks: [], evidence: [], intake: intakeTopics.map(t => ({ key: t.key, status: "missing", note: "", evidence: [] })) };
}
export function dossierGaps(p: DossierPayload, staffed: boolean) {
  const gaps: { key: string; name: string; impact: string }[] = [];
  for (const [key, name, impact] of [
    ["legalName", "企业名称", "无法确认账套主体"], ["creditCode", "统一社会信用代码", "无法核对企业身份"],
    ["industry", "行业", "无法确认业务核对范围"], ["contactName", "联系人", "缺件无法落实对接人"],
    ["contactPhone", "联系方式", "缺少补件联系渠道"], ["reportingBasis", "会计准则", "无法选择账务和报表口径"],
    ["activationPeriod", "启用期间", "无法确定接账起点"], ["taxpayerType", "纳税人类型", "无法确认涉税核对口径"],
    ["taxRegion", "纳税地区", "无法确定后续地区适配范围"],
  ]) if (!p[key as keyof DossierPayload]) gaps.push({ key, name, impact });
  if (!p.services.length) gaps.push({ key: "services", name: "服务项目", impact: "无法确定本团队承担的工作范围" });
  if (p.bankStatus === "unknown") gaps.push({ key: "banks", name: "银行账户", impact: "无法确认流水收集范围" });
  if (!staffed) gaps.push({ key: "staffing", name: "经办与复核分工", impact: "缺少有效授权且不同人的经办与复核" });
  for (const t of intakeTopics) if (p.intake.find(i => i.key === t.key)?.status === "missing") gaps.push({ key: t.key, name: t.name, impact: t.impact });
  return gaps;
}
export function dossierDiff(before: DossierPayload, after: DossierPayload) {
  return Object.keys(after).filter(k => JSON.stringify(before[k as keyof DossierPayload]) !== JSON.stringify(after[k as keyof DossierPayload]));
}
