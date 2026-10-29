import { Decimal } from "decimal.js";
import { z } from "zod";
import { date, period } from "./core.js";
import { statementMappingPreview } from "./statement-mapping.js";
import { cashflowCatalog } from "./cashflow-catalog.js";
import { disclosureReview } from "./disclosure-review.js";
import { statementTotals } from "./statement-totals.js";

const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/);
const positive = money.refine((x) => new Decimal(x).gte(0));
const code = z.string().trim().min(1).max(60);
export const accountingInput = z.object({
 bankImportId:z.union([z.uuid(),z.literal("")]).default(""),
 bankAccounts:z.array(code).max(100).default([]),
 previousSnapshotId:z.union([z.uuid(),z.literal("")]).default(""),
 comparative:z.object({yearEndSnapshotId:z.union([z.uuid(),z.literal("")]).default(""),priorPeriodSnapshotId:z.union([z.uuid(),z.literal("")]).default("")}).nullable().default(null),
 comparativeAdjustments:z.array(z.object({group:code,target:z.enum(["yearEnd","priorPeriod"]),item:code,amount:money,reason:z.string().trim().min(1).max(1000),evidence:z.string().trim().min(1).max(500)})).max(5000).nullable().default(null),
 reclassification:z.array(z.object({account:code,target:z.enum(["asset","liability","equity"]),amount:money,evidence:z.string().trim().min(1).max(500)})).max(10000).nullable().default(null),
 disclosures:z.array(z.object({title:z.string().trim().min(1).max(200),content:z.string().trim().min(1).max(4000),evidence:z.string().trim().min(1).max(500)})).max(200).nullable().default(null),
 disclosureReview:z.array(z.object({topic:z.string().trim().min(1).max(200),status:z.enum(["provided","not_applicable","pending"]),content:z.string().trim().max(4000),evidence:z.string().trim().max(500)})).max(200).nullable().default(null),
 reportingBasis:z.enum(["small_2011","enterprise_2019_new"]).nullable().default(null),
 statementMappings:z.array(z.object({account:code,table:z.enum(["balance","income"]),item:z.string().trim().min(1).max(100),amount:money,evidence:z.string().trim().min(1).max(500)})).max(20000).nullable().default(null),
 statementZeros:z.array(z.object({table:z.enum(["balance","income"]),item:z.string().trim().min(1).max(100),evidence:z.string().trim().min(1).max(500)})).max(2000).nullable().default(null),
 counterparties:z.object({accounts:z.array(z.object({account:code,kind:z.enum(["receivable","prepayment","payable","advance","contract"])})).max(2000),rows:z.array(z.object({account:code,party:z.string().trim().min(1).max(200),detail:z.string().trim().min(1).max(200),amount:money,target:z.enum(["receivable","prepayment","payable","advance","contract_asset","contract_liability","other_noncurrent_asset","other_noncurrent_liability"]),evidence:z.string().trim().min(1).max(500)})).max(20000)}).nullable().default(null),
 cashFlow:z.object({accounts:z.array(code).max(100),allocations:z.array(z.object({voucher:code,line:z.number().int().min(1).max(200),category:z.enum(["operating_in","operating_out","investing_in","investing_out","financing_in","financing_out","exchange","internal"]),amount:money,item:z.string().trim().max(100).default("")})).max(20000)}).nullable().default(null),
 equityMovement:z.array(z.object({account:code,category:z.enum(["profit","capital","distribution","reserve","other_comprehensive","other"]),amount:money,evidence:z.string().trim().min(1).max(500)})).max(20000).nullable().default(null),
 accounts:z.array(z.object({code,name:z.string().trim().min(1).max(200),category:z.enum(["asset","liability","equity","revenue","expense"]),opening:money})).min(1).max(2000),
 vouchers:z.array(z.object({number:code,date,closing:z.boolean().default(false),lines:z.array(z.object({account:code,debit:positive,credit:positive,description:z.string().max(500).default("")})).min(2).max(200)})).max(10000),
 invoices:z.array(z.object({number:code,date,kind:z.enum(["sale","purchase"]),color:z.enum(["blue","red"]).default("blue"),originalPeriod:z.union([period,z.literal("")]).default(""),originalNumber:z.string().trim().max(60).default(""),originalSnapshotId:z.union([z.uuid(),z.literal("")]).default(""),net:money,tax:money,gross:money,voucher:code,account:code,taxAccount:z.string().trim().max(60).default("")})).max(10000)
});
type Input=z.infer<typeof accountingInput>;
const zero=()=>new Decimal(0), fmt=(v:Decimal)=>v.toFixed(2);
const add=(m:Map<string,Decimal>,k:string,v:Decimal)=>m.set(k,(m.get(k)??zero()).plus(v));
export function accountingReport(raw:unknown, targetPeriod:string){
 period.parse(targetPeriod); const input:Input=accountingInput.parse(raw);
 const issues:{type:string;reference:string;message:string}[]=[];
 const issue=(type:string,reference:string,message:string)=>issues.push({type,reference,message});
 if(input.comparativeAdjustments?.length&&input.reportingBasis!=='enterprise_2019_new')issue('comparative_adjustment','准则口径','该比较数调整底稿仅用于一般企业口径；小企业处理方式须另行判断');
 const accounts=new Map<string,Input["accounts"][number]>(), movements=new Map<string,Decimal>(), operations=new Map<string,Decimal>();
 for(const a of input.accounts){
  if(accounts.has(a.code)) issue("account",a.code,"科目编号重复"); else accounts.set(a.code,a);
  if(["revenue","expense"].includes(a.category)&&!new Decimal(a.opening).isZero()) issue("opening",a.code,"损益科目期初不为零，需要人工处理");
 }
 if(new Set(input.bankAccounts).size!==input.bankAccounts.length) issue("bank","银行账户","银行科目重复");
 for(const code of input.bankAccounts) if(accounts.get(code)?.category!=="asset")issue("bank",code,"银行科目不存在或不是资产类");
 if(Boolean(input.bankImportId)!==Boolean(input.bankAccounts.length))issue("bank","银行流水","流水编号与银行科目需同时填写");
 const opening=[...accounts.values()].reduce((s,a)=>s.plus(a.opening),zero());
 if(!opening.isZero()) issue("opening","期初",`期初借贷差额 ${fmt(opening)} 元`);
 const vouchers=new Map<string,Input["vouchers"][number]>();
 for(const v of input.vouchers){
  if(vouchers.has(v.number)) issue("voucher",v.number,"凭证编号重复"); else vouchers.set(v.number,v);
  if(!v.date.startsWith(targetPeriod+"-")) issue("period",v.number,"凭证日期不在本期");
  if(v.closing){
   const categories=v.lines.map(l=>accounts.get(l.account)?.category);
   if(!categories.some(c=>c==='revenue'||c==='expense'))issue("closing",v.number,"损益结转凭证必须包含损益科目");
   if(categories.some(c=>c==='asset'||c==='liability'))issue("closing",v.number,"损益结转凭证包含资产或负债科目，请人工核对");
  }
  let debit=zero(),credit=zero();
  for(const l of v.lines){const d=new Decimal(l.debit), c=new Decimal(l.credit);
   if((d.gt(0)&&c.gt(0))||(d.isZero()&&c.isZero())) issue("line",v.number,`科目 ${l.account} 借贷方向无效`);
   if(!accounts.has(l.account)) issue("account",v.number,`科目 ${l.account} 不存在`); else {add(movements,l.account,d.minus(c));if(!v.closing)add(operations,l.account,d.minus(c));}
   debit=debit.plus(d);credit=credit.plus(c);
  }
  if(!debit.equals(credit)) issue("voucher",v.number,`借方 ${fmt(debit)} 元，贷方 ${fmt(credit)} 元`);
 }
 const seen=new Set<string>(),expected=new Map<string,Decimal>();
 for(const i of input.invoices){
  const key=`${i.kind}|${i.number}`;if(seen.has(key)) issue("invoice",i.number,"发票编号重复");else seen.add(key);
  if(!i.date.startsWith(targetPeriod+"-")) issue("period",i.number,"发票日期不在本期，需人工核对跨期情况");
  if(!new Decimal(i.net).plus(i.tax).equals(i.gross)) issue("invoice",i.number,"不含税金额与税额之和不等于价税合计");
  const amounts=[i.net,i.tax,i.gross].map(x=>new Decimal(x));
  if(i.color==="blue"&&(amounts.some(x=>x.lt(0))||amounts[2].isZero()))issue("invoice",i.number,"蓝字发票金额须非负且价税合计大于零");
  if(i.color==="red"&&(amounts.some(x=>x.gt(0))||amounts[2].isZero()))issue("invoice",i.number,"红字发票金额须为负数，税额可为零");
  if(i.color==="red"&&(!i.originalPeriod||!i.originalNumber))issue("invoice",i.number,"红字发票必须明确填写原蓝字发票期间和编号");
  if(i.color==="red"&&i.originalPeriod&&i.originalPeriod!==targetPeriod&&!i.originalSnapshotId)issue("invoice",i.number,"跨期红字发票必须明确填写原蓝字底稿编号");
  if(i.color==="red"&&i.originalPeriod===targetPeriod&&i.originalSnapshotId)issue("invoice",i.number,"本期蓝字发票请直接关联本期明细，不填写其他底稿编号");
  if(i.color==="blue"&&(i.originalPeriod||i.originalNumber||i.originalSnapshotId))issue("invoice",i.number,"蓝字发票不得填写红冲关联");
  if(i.color==="red"&&i.originalPeriod>targetPeriod)issue("invoice",i.number,"原蓝字发票期间不能晚于红字发票期间");
  if(!vouchers.has(i.voucher)){issue("invoice",i.number,"关联凭证不存在");continue}
  const a=accounts.get(i.account);
  if(!a||(i.kind==="sale"?a.category!=="revenue":!["expense","asset"].includes(a.category))) issue("invoice",i.number,"发票关联科目不存在或分类不匹配");
  if(!new Decimal(i.tax).isZero()&&!accounts.has(i.taxAccount)) issue("invoice",i.number,"税额关联科目不存在");
  const sign=i.kind==="sale"?-1:1;add(expected,`${i.voucher}\u0000${i.account}`,new Decimal(i.net).mul(sign));
  if(!new Decimal(i.tax).isZero()&&i.taxAccount) add(expected,`${i.voucher}\u0000${i.taxAccount}`,new Decimal(i.tax).mul(sign));
 }
 for(const [key,amount] of expected){const [number,account]=key.split("\u0000");
  const actual=vouchers.get(number)!.lines.filter(x=>x.account===account).reduce((s,x)=>s.plus(x.debit).minus(x.credit),zero());
  if(!actual.equals(amount))issue("invoice_voucher",number,`科目 ${account} 发票合计 ${fmt(amount)} 元，凭证净借方 ${fmt(actual)} 元`);
 }
 const trial=[...accounts.values()].map(a=>({...a,opening:fmt(new Decimal(a.opening)),movement:fmt(movements.get(a.code)??zero()),operating:fmt(operations.get(a.code)??zero()),closing:fmt(new Decimal(a.opening).plus(movements.get(a.code)??zero()))}));
 const sum=(category:string)=>trial.filter(a=>a.category===category).reduce((s,a)=>s.plus(a.closing),zero());
 const assets=sum("asset"),liabilities=sum("liability").negated(),equity=sum("equity").negated();
 const opSum=(category:string)=>[...accounts.values()].filter(a=>a.category===category).reduce((s,a)=>s.plus(operations.get(a.code)??zero()),zero());
 const revenue=opSum("revenue").negated(),expenses=opSum("expense"),profit=revenue.minus(expenses);
 const unsettled=sum("revenue").negated().minus(sum("expense"));
 const difference=assets.minus(liabilities).minus(equity).minus(unsettled);
 if(!difference.isZero())issue("balance","汇总",`资产减负债、权益及本期损益差额 ${fmt(difference)} 元`);
 let counterparties:any={status:'未提供'};
 if(input.counterparties){
  const selected=new Map<string,string>(),byAccount=new Map<string,Decimal>(),byTarget=new Map<string,Decimal>(),byAccountSide=new Map<string,Decimal>(),manualBySide=new Map<string,Decimal>(),duplicates=new Set<string>();
  const assetTargets=['receivable','prepayment','contract_asset','other_noncurrent_asset'];
  const liabilityTargets=['payable','advance','contract_liability','other_noncurrent_liability'];
  if(!input.reportingBasis)issue('counterparty','准则口径','往来重分类必须先明确适用口径');
  for(const s of input.counterparties.accounts){if(selected.has(s.account))issue('counterparty',s.account,'往来科目重复');selected.set(s.account,s.kind);const a=accounts.get(s.account);if(!a||!['asset','liability'].includes(a.category))issue('counterparty',s.account,'往来科目不存在或不是资产、负债类');if(input.reportingBasis==='small_2011'&&s.kind==='contract')issue('counterparty',s.account,'小企业口径不自动支持合同资产或合同负债分类');}
  if(!selected.size)issue('counterparty','往来科目','请明确选择待核对的往来科目');
  for(const row of input.counterparties.rows){
   const kind=selected.get(row.account),amount=new Decimal(row.amount),key=JSON.stringify([row.account,row.party,row.detail]);
   if(duplicates.has(key))issue('counterparty',row.account,`${row.party} 的同一往来明细重复`);duplicates.add(key);
   if(!kind){issue('counterparty',row.account,'该明细没有对应的往来科目配置');continue}
   if(amount.isZero())issue('counterparty',row.account,'往来明细金额不能为零');
   if(assetTargets.includes(row.target)&&amount.lt(0)||liabilityTargets.includes(row.target)&&amount.gt(0))issue('counterparty',row.account,`${row.party} 的借贷方向与目标项目不一致`);
   if(input.reportingBasis==='small_2011'){
    const allowed=kind==='receivable'||kind==='advance'?['receivable','advance','other_noncurrent_asset','other_noncurrent_liability']:['prepayment','payable','other_noncurrent_asset','other_noncurrent_liability'];
    if(!allowed.includes(row.target))issue('counterparty',row.account,`${row.party} 的目标项目不适用于所选小企业往来科目`);
   }
   add(byAccount,row.account,amount);add(byTarget,row.target,amount);add(byAccountSide,JSON.stringify([row.account,assetTargets.includes(row.target)?'asset':'liability']),amount);
  }
  for(const row of input.reclassification||[])add(manualBySide,JSON.stringify([row.account,row.target]),new Decimal(row.amount));
  const trialByCode=new Map(trial.map(t=>[t.code,t]));
  for(const account of selected.keys()){
   const a=trialByCode.get(account),amount=byAccount.get(account)??zero();
   if(a&&!amount.equals(a.closing))issue('counterparty',account,`往来明细借减贷 ${fmt(amount)} 元，与科目期末 ${a.closing} 元不一致`);
   if(input.reclassification){for(const target of ['asset','liability'] as const){const key=JSON.stringify([account,target]),manual=manualBySide.get(key)??zero(),detail=byAccountSide.get(key)??zero();if(!manual.equals(detail))issue('counterparty',account,`${target==='asset'?'资产':'负债'}重分类与往来明细不一致`);}}
  }
  counterparties={status:'已提供，待复核',rows:input.counterparties.rows.length,items:Object.fromEntries([...byTarget].map(([k,v])=>[k,fmt(liabilityTargets.includes(k)?v.negated():v)]))};
 }
 let reclassification:any={status:'未提供'};
 if(input.reclassification){
  const classified=new Map<string,Decimal>(), totals=new Map<string,Decimal>();
  for(const row of input.reclassification){
   const a=accounts.get(row.account);
   if(!a||!['asset','liability','equity'].includes(a.category)){issue('reclassification',row.account,'重分类来源须是有效的资产、负债或权益科目');continue}
   add(classified,row.account,new Decimal(row.amount));add(totals,row.target,new Decimal(row.amount));
  }
  for(const a of trial.filter(a=>['asset','liability','equity'].includes(a.category))){
   const assigned=classified.get(a.code)??zero();
   if(!assigned.equals(a.closing))issue('reclassification',a.code,`科目期末借减贷 ${a.closing} 元，重分类合计 ${fmt(assigned)} 元`);
  }
  const ra=totals.get('asset')??zero(),rl=(totals.get('liability')??zero()).negated(),re=(totals.get('equity')??zero()).negated();
  const gap=ra.minus(rl).minus(re).minus(unsettled);
  if(!gap.isZero())issue('reclassification','汇总',`重分类后平衡差额 ${fmt(gap)} 元`);
  reclassification={status:'已提供，待复核',assets:fmt(ra),liabilities:fmt(rl),equity:fmt(re),balanceDifference:fmt(gap)};
 }
 const bankMovement=input.bankAccounts.reduce((s,code)=>s.plus(movements.get(code)??zero()),zero());
 let cashFlow:any={status:"未编制"};
 if(input.cashFlow){
  const cash=new Set(input.cashFlow.accounts), allocations=new Map<string,Decimal>(), internal=new Map<string,Decimal>(),groups=new Map<string,Decimal>(),details=new Map<string,Decimal>(), unique=new Set<string>();
  let missingItems=0;
  if(!cash.size||cash.size!==input.cashFlow.accounts.length)issue("cashflow","现金范围","请选择不重复的现金及现金等价物科目");
  for(const id of cash)if(accounts.get(id)?.category!=='asset')issue("cashflow",id,"现金科目不存在或不是资产类");
  for(const a of input.cashFlow.allocations){
   const v=vouchers.get(a.voucher),line=v?.lines[a.line-1],key=`${a.voucher}\u0000${a.line}`,uniqueKey=`${key}\u0000${a.category}\u0000${a.item}`;
   if(unique.has(uniqueKey))issue("cashflow",a.voucher,`第 ${a.line} 行分类重复`);unique.add(uniqueKey);
   if(!line||!cash.has(line.account)){issue("cashflow",a.voucher,`第 ${a.line} 行不是所选现金科目`);continue}
   const amount=new Decimal(a.amount),movement=new Decimal(line.debit).minus(line.credit);
   if(amount.isZero()||(!movement.isZero()&&amount.isPositive()!==movement.isPositive()))issue("cashflow",a.voucher,`第 ${a.line} 行分类金额方向不符`);
   if(a.category.endsWith('_in')&&amount.lte(0)||a.category.endsWith('_out')&&amount.gte(0))issue("cashflow",a.voucher,`第 ${a.line} 行流入或流出方向不符`);
   if(a.item&&!(cashflowCatalog(input.reportingBasis)[a.category]||[]).includes(a.item))issue("cashflow",a.voucher,`第 ${a.line} 行现金流项目与适用准则或分类不匹配`);
   if(a.category!=='internal'&&!a.item)missingItems++;
   if(a.item)add(details,`${a.category}\u0000${a.item}`,amount);
   add(allocations,key,amount);add(groups,a.category,amount);if(a.category==='internal')add(internal,a.voucher,amount);
  }
  for(const v of input.vouchers)for(const [index,line] of v.lines.entries())if(cash.has(line.account)){
   const key=`${v.number}\u0000${index+1}`,movement=new Decimal(line.debit).minus(line.credit),allocated=allocations.get(key)??zero();
   if(!allocated.equals(movement))issue("cashflow",v.number,`第 ${index+1} 行现金发生额 ${fmt(movement)} 元，分类合计 ${fmt(allocated)} 元`);
  }
  for(const [voucher,amount] of internal)if(!amount.isZero())issue("cashflow",voucher,"内部现金调拨在同一凭证中必须流入流出相抵");
  const openingCash=[...cash].reduce((s,id)=>s.plus(accounts.get(id)?.opening??0),zero());
  const closingCash=[...cash].reduce((s,id)=>s.plus(accounts.get(id)?.opening??0).plus(movements.get(id)??0),zero());
  const subtotal=(k:string)=>fmt((groups.get(k+'_in')??zero()).plus(groups.get(k+'_out')??zero()));
  cashFlow={status:'已分类，待复核',detailStatus:missingItems?'项目未完整':'明细已填写，待复核',missingItems,items:[...details].map(([key,value])=>{const [category,item]=key.split('\u0000');return {category,item,amount:fmt(category.endsWith('_out')?value.negated():value)}}),operating:subtotal('operating'),investing:subtotal('investing'),financing:subtotal('financing'),exchange:fmt(groups.get('exchange')??zero()),opening:fmt(openingCash),closing:fmt(closingCash),classifiedNet:fmt([...groups.entries()].filter(([k])=>k!=='internal').reduce((s,[,v])=>s.plus(v),zero()))};
  if(!new Decimal(cashFlow.classifiedNet).equals(closingCash.minus(openingCash)))issue("cashflow","现金合计","分类净额与现金及现金等价物余额变动不一致");
 }
 let equityMovement:any={status:"未编制",rows:[]};
 if(input.equityMovement){
  const totals=new Map<string,Decimal>();
  for(const row of input.equityMovement){
   if(accounts.get(row.account)?.category!=='equity')issue('equity',row.account,'权益变动科目不存在或不是权益类');
   add(totals,row.account,new Decimal(row.amount));
  }
  const rows=trial.filter(a=>a.category==='equity').map(a=>{
   const expected=new Decimal(a.closing).minus(a.opening).negated(),actual=totals.get(a.code)??zero();
   if(!expected.equals(actual))issue('equity',a.code,`权益变动合计 ${fmt(actual)} 元，与科目余额变动 ${fmt(expected)} 元不一致`);
   return {account:a.code,opening:fmt(new Decimal(a.opening).negated()),closing:fmt(new Decimal(a.closing).negated()),movement:fmt(actual)};
  });
  equityMovement={status:'科目变动已填写，待复核',rows};
 }
 const statementMapping=statementMappingPreview(input,trial);issues.push(...statementMapping.issues);
 const totals=statementTotals(input,{statementMapping,summary:{profit:fmt(profit)}});issues.push(...totals.issues||[]);
 const disclosuresCheck=disclosureReview(input);issues.push(...disclosuresCheck.issues);
 return {issues,trial,summary:{assets:fmt(assets),liabilities:fmt(liabilities),equity:fmt(equity),revenue:fmt(revenue),expenses:fmt(expenses),profit:fmt(profit),balanceDifference:fmt(difference)},bankMovement:fmt(bankMovement),cashFlow,equityMovement,disclosuresCheck,reclassification,counterparties,statementMapping,statementTotals:totals,limits:"仅按人工指定科目分类及明确的发票凭证关联核对；不验证发票真伪、不生成或提交正式报表。"};
}
