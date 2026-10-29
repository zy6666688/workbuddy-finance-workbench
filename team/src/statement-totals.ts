import {Decimal} from 'decimal.js';
import {statementCatalog} from './statement-mapping.js';

// Explicit absent-item confirmations are distinct from data not supplied.
export function statementTotals(input:any,report:any){
 const catalog=statementCatalog(input.reportingBasis||'');
 if(!catalog||!input.statementMappings)return {status:'未提供映射',rows:[],missing:[],issues:input.statementZeros?.length?[{type:'statement_zero',reference:'报表映射',message:'确认零项前须先指定准则并提供账簿映射'}]:[]};
 const issues:{type:string;reference:string;message:string}[]=[], values=new Map<string,Decimal>(),seen=new Set<string>();
 const key=(table:string,item:string)=>JSON.stringify([table,item]);
 for(const table of ['balance','income'])for(const row of report.statementMapping[table])values.set(key(table,row.item),new Decimal(row.amount));
 for(const row of input.statementZeros||[]){
  const k=key(row.table,row.item),allowed=row.table==='balance'?[...catalog.assets,...catalog.liabilities,...catalog.equity]:[...catalog.gains,...catalog.costs];
  if(!allowed.includes(row.item))issues.push({type:'statement_zero',reference:row.item,message:'该项目不属于所选准则和报表类型'});
  else if(seen.has(k)||values.has(k))issues.push({type:'statement_zero',reference:row.item,message:'重复确认或已由账簿映射，不能再声明为零'});
  else values.set(k,new Decimal(0));
  seen.add(k);
 }
 const get=(table:string,item:string)=>values.get(key(table,item));
 const calc=(table:string,parts:[string,number][])=>parts.some(([item])=>get(table,item)===undefined)?null:parts.reduce((total,[item,sign])=>total.plus(get(table,item)!.mul(sign)),new Decimal(0));
 const small=input.reportingBasis==='small_2011',assetCut=small?10:14,liabilityCut=small?10:13;
 const all=(names:string[],sign=1):[string,number][]=>names.map(x=>[x,sign]);
 const currentAssets=calc('balance',all(catalog.assets.slice(0,assetCut)));
 const longAssets=calc('balance',catalog.assets.slice(assetCut).map(x=>[x,x==='累计折旧'?-1:1]));
 const currentLiabilities=calc('balance',all(catalog.liabilities.slice(0,liabilityCut)));
 const longLiabilities=calc('balance',all(catalog.liabilities.slice(liabilityCut)));
 const equities=calc('balance',catalog.equity.map(x=>[x,x==='库存股'?-1:1]));
 const plus=(...x:(Decimal|null)[])=>x.some(v=>v===null)?null:x.reduce((s,v)=>s!.plus(v!),new Decimal(0));
 const assets=plus(currentAssets,longAssets),liabilities=plus(currentLiabilities,longLiabilities),liabilityAndEquity=plus(liabilities,equities);
 const gainNames=catalog.gains.filter(x=>!['营业外收入'].includes(x)),costNames=catalog.costs.filter(x=>!['营业外支出','所得税费用'].includes(x));
 const operating=calc('income',[...all(gainNames),...all(costNames,-1)]);
 const income=(name:string)=>get('income',name)??null;
 const beforeTax=operating===null||income('营业外收入')===null||income('营业外支出')===null?null:operating.plus(income('营业外收入')!).minus(income('营业外支出')!);
 const profit=beforeTax===null||income('所得税费用')===null?null:beforeTax.minus(income('所得税费用')!);
 const results=[['流动资产合计',currentAssets],['非流动资产合计',longAssets],['资产总计',assets],['流动负债合计',currentLiabilities],['非流动负债合计',longLiabilities],['负债合计',liabilities],['所有者权益合计',equities],['负债和所有者权益合计',liabilityAndEquity],['营业利润',operating],['利润总额',beforeTax],['净利润',profit]] as const;
 if(assets!==null&&liabilityAndEquity!==null&&!assets.equals(liabilityAndEquity))issues.push({type:'statement_total',reference:'资产负债表',message:`资产与负债权益合计差额 ${assets.minus(liabilityAndEquity).toFixed(2)} 元`});
 if(profit!==null&&!profit.equals(report.summary.profit))issues.push({type:'statement_total',reference:'利润表',message:`净利润与账簿损益差额 ${profit.minus(report.summary.profit).toFixed(2)} 元`});
 const missing=[...catalog.assets,...catalog.liabilities,...catalog.equity].filter(item=>get('balance',item)===undefined).map(item=>`资产负债：${item}`)
  .concat([...catalog.gains,...catalog.costs].filter(item=>get('income',item)===undefined).map(item=>`利润：${item}`));
 return {status:'报表汇总核对底稿，待复核',rows:results.map(([item,value])=>({item,amount:value?.toFixed(2)??null})),missing,issues,
  limitations:'未提供的项目不按零计算；明确确认的零仍需复核。此汇总不包括全部法定行次、比较数、附注或权益变动。'};
}
