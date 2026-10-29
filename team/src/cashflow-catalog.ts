// Items are selected by the accountant; voucher text alone cannot determine classification.
const common = {
 operating_in: ["销售商品、提供劳务收到的现金", "收到的税费返还", "收到其他与经营活动有关的现金"],
 operating_out: ["购买商品、接受劳务支付的现金", "支付给职工以及为职工支付的现金", "支付的各项税费", "支付其他与经营活动有关的现金"],
 investing_in: ["收回投资收到的现金", "取得投资收益收到的现金", "处置固定资产、无形资产和其他长期资产收回的现金净额", "处置子公司及其他营业单位收到的现金净额", "收到其他与投资活动有关的现金"],
 investing_out: ["购建固定资产、无形资产和其他长期资产支付的现金", "投资支付的现金", "取得子公司及其他营业单位支付的现金净额", "支付其他与投资活动有关的现金"],
 financing_in: ["吸收投资收到的现金", "取得借款收到的现金", "收到其他与筹资活动有关的现金"],
 financing_out: ["偿还债务支付的现金", "分配股利、利润或偿付利息支付的现金", "支付其他与筹资活动有关的现金"],
 exchange: ["汇率变动对现金及现金等价物的影响"]
};
const small = {
 operating_in: ["销售产成品、商品、提供劳务收到的现金", "收到其他与经营活动有关的现金"],
 operating_out: ["购买原材料、商品、接受劳务支付的现金", "支付的职工薪酬", "支付的税费", "支付其他与经营活动有关的现金"],
 investing_in: ["收回短期投资、长期债券投资和长期股权投资收到的现金", "取得投资收益收到的现金", "处置固定资产、无形资产和其他非流动资产收回的现金净额"],
 investing_out: ["短期投资、长期债券投资和长期股权投资支付的现金", "购建固定资产、无形资产和其他非流动资产支付的现金"],
 financing_in: ["取得借款收到的现金", "吸收投资者投资收到的现金"],
 financing_out: ["偿还借款本金支付的现金", "偿还借款利息支付的现金", "分配利润支付的现金"]
};
export function cashflowCatalog(basis: string | null): Record<string, string[]> {
 return basis === "small_2011" ? small : basis === "enterprise_2019_new" ? common : {};
}
