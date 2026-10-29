import {Decimal} from 'decimal.js';

const smallAssets=['货币资金','短期投资','应收票据','应收账款','预付账款','应收股利','应收利息','其他应收款','存货','其他流动资产','长期债券投资','长期股权投资','固定资产原价','累计折旧','在建工程','工程物资','固定资产清理','生产性生物资产','无形资产','开发支出','长期待摊费用','其他非流动资产'];
const generalAssets=['货币资金','交易性金融资产','衍生金融资产','应收票据','应收账款','应收款项融资','预付款项','其他应收款','存货','合同资产','持有待售资产','一年内到期的非流动资产','其他流动资产','债权投资','其他债权投资','长期应收款','长期股权投资','其他权益工具投资','其他非流动金融资产','投资性房地产','固定资产','在建工程','生产性生物资产','油气资产','使用权资产','无形资产','开发支出','商誉','长期待摊费用','递延所得税资产','其他非流动资产'];
const smallLiabilities=['短期借款','应付票据','应付账款','预收账款','应付职工薪酬','应交税费','应付利息','应付利润','其他应付款','其他流动负债','长期借款','长期应付款','递延收益','其他非流动负债'];
const generalLiabilities=['短期借款','交易性金融负债','衍生金融负债','应付票据','应付账款','预收款项','合同负债','应付职工薪酬','应交税费','其他应付款','持有待售负债','一年内到期的非流动负债','其他流动负债','长期借款','应付债券','租赁负债','长期应付款','预计负债','递延收益','递延所得税负债','其他非流动负债'];
const smallEquity=['实收资本（或股本）','资本公积','盈余公积','未分配利润'];
const generalEquity=['实收资本（或股本）','其他权益工具','资本公积','库存股','其他综合收益','专项储备','盈余公积','未分配利润'];
const smallGains=['营业收入','投资收益','营业外收入'];
const smallCosts=['营业成本','营业税金及附加','销售费用','管理费用','财务费用','营业外支出','所得税费用'];
const generalGains=['营业收入','其他收益','投资收益','净敞口套期收益','公允价值变动收益','信用减值损失','资产减值损失','资产处置收益','营业外收入'];
const generalCosts=['营业成本','税金及附加','销售费用','管理费用','研发费用','财务费用','营业外支出','所得税费用'];
export function statementCatalog(basis:string){
 if(!['small_2011','enterprise_2019_new'].includes(basis))return null;
 const small=basis==='small_2011';
 return {assets:small?smallAssets:generalAssets,liabilities:small?smallLiabilities:generalLiabilities,equity:small?smallEquity:generalEquity,gains:small?smallGains:generalGains,costs:small?smallCosts:generalCosts};
}
const zero=()=>new Decimal(0);const add=(m:Map<string,Decimal>,key:string,value:Decimal)=>m.set(key,(m.get(key)||zero()).plus(value));
/** Internal mapping preview. It is not a statutory statement or a filing. */
export function statementMappingPreview(input:any,trial:any[]){
 const rows=input.statementMappings;if(!rows)return {status:'未提供',issues:[],balance:[],income:[]};
 const issues:{type:string;reference:string;message:string}[]=[];
 const issue=(reference:string,message:string)=>issues.push({type:'statement_mapping',reference,message});
 const catalog=statementCatalog(input.reportingBasis);if(!catalog){issue('准则口径','逐项映射需明确适用的报表口径');return {status:'待处理',issues,balance:[],income:[]}}
 const byAccount=new Map(trial.map(a=>[a.code,a])),coverage=new Map<string,Decimal>(),items=new Map<string,Decimal>(),detail=new Map<string,Decimal>();
 for(const row of rows){
  const account=byAccount.get(row.account);if(!account){issue(row.account,'映射科目不存在');continue}
  const groups=row.table==='balance'?[catalog.assets,catalog.liabilities,catalog.equity]:[catalog.gains,catalog.costs];
  const group=groups.findIndex(g=>g.includes(row.item));if(group<0){issue(row.item,'该项目不属于所选准则的可映射项目');continue}
  if(row.table==='income'&&!['revenue','expense'].includes(account.category)){issue(row.account,'利润项目只能映射损益类科目');continue}
  if(row.table==='balance'&&['revenue','expense'].includes(account.category)&&row.item!=='未分配利润'){issue(row.account,'未结转损益只能映射到未分配利润');continue}
  const amount=new Decimal(row.amount), accountKey=JSON.stringify([row.table,row.account]), itemKey=JSON.stringify([row.table,row.item]), detailKey=JSON.stringify([row.account,row.item]);
  add(coverage,accountKey,amount);add(detail,detailKey,amount);
  const factor=row.table==='income'?(group===0?-1:1):(row.item==='累计折旧'?-1:row.item==='库存股'?1:group===0?1:-1);
  add(items,itemKey,amount.mul(factor));
 }
 for(const a of trial){for(const table of ['balance','income']){
  if(table==='income'&&!['revenue','expense'].includes(a.category))continue;
  const expected=new Decimal(table==='balance'?a.closing:a.operating),actual=coverage.get(JSON.stringify([table,a.code]))||zero();
  if(!expected.equals(actual))issue(a.code,`${table==='balance'?'资产负债':'利润'}映射合计 ${actual.toFixed(2)} 元，与账簿 ${expected.toFixed(2)} 元不一致`);
 }}
 const targetItems:any={receivable:'应收账款',prepayment:input.reportingBasis==='small_2011'?'预付账款':'预付款项',payable:'应付账款',advance:input.reportingBasis==='small_2011'?'预收账款':'预收款项',contract_asset:'合同资产',contract_liability:'合同负债',other_noncurrent_asset:'其他非流动资产',other_noncurrent_liability:'其他非流动负债'};
 const cp=new Map<string,Decimal>();for(const r of input.counterparties?.rows||[])add(cp,JSON.stringify([r.account,targetItems[r.target]]),new Decimal(r.amount));
 for(const [key,value] of cp)if(!(detail.get(key)||zero()).equals(value))issue(JSON.parse(key)[0],`往来明细与 ${JSON.parse(key)[1]} 项目映射不一致`);
 const output=(table:string)=>[...items].map(([key,value])=>{const [kind,item]=JSON.parse(key);return {table:kind,item,amount:value.toFixed(2)}}).filter(x=>x.table===table).map(({item,amount})=>({item,amount}));
 return {status:'映射底稿，需人工复核',issues,balance:output('balance'),income:output('income')};
}
