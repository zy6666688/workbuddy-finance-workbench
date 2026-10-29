import {Decimal} from 'decimal.js';
import {accountingInput,accountingReport} from './accounting.js';
import {statementCatalog} from './statement-mapping.js';

// This is a traceable preview; policy, completeness and statutory disclosure
// still require professional review. Missing months are never treated as zero.
export async function statementDraft(db:any,cid:string,period:string,raw:unknown,report:any,comparative:any){
 const input=accountingInput.parse(raw),mapping=report.statementMapping;
 if(!input.statementMappings){if(input.comparativeAdjustments?.length)report.issues.push({type:'comparative_adjustment',reference:'报表映射',message:'比较调整需要本期报表映射和已复核比较底稿'});return {status:'未提供映射',missing:[],balance:[],income:[],cashFlowYtd:null};}
 const [year,monthText]=period.split('-'),month=Number(monthText);
 const expected=Array.from({length:month-1},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`);
 const rows=expected.length?(await db.query("SELECT s.id,s.period,s.version,s.payload FROM accounting_snapshots s JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.company_id=$1 AND s.period=ANY($2::text[]) AND w.status IN ('delivery','archived') AND w.submission->'accounting'->>'id'=s.id::text",[cid,expected])).rows:[];
 const byPeriod=new Map<string,any>(rows.map((x:any)=>[x.period,x])),missing:string[]=[],previousReports:any[]=[],sources:any[]=[];
 for(const p of expected){const row=byPeriod.get(p);if(!row){missing.push(`${p} 无已复核底稿`);continue}
  const data=accountingInput.parse(row.payload),source=accountingReport(data,p);
  if(data.reportingBasis!==input.reportingBasis||!data.statementMappings||source.issues.length){missing.push(`${p} 口径、映射或核对未完成`);continue}
  previousReports.push(source);
  sources.push({id:row.id,period:row.period,version:row.version});
 }
 const mapValues=(arr:any[])=>new Map<string,string>((arr||[]).map((x:any)=>[x.item,x.amount]));
 const yearMapping=comparative.yearEnd?.statementMapping,priorMapping=comparative.priorPeriod?.statementMapping;
 const yearEnd=yearMapping&&yearMapping.status!=='未提供'&&!yearMapping.issues.length?mapValues(yearMapping.balance):null;
 const previous=priorMapping&&priorMapping.status!=='未提供'&&!priorMapping.issues.length?mapValues(priorMapping.income):null;
 const adjustments=new Map<string,Decimal>(),groupBalances=new Map<string,Decimal>(),catalog=statementCatalog(input.reportingBasis||'');
 for(const row of input.comparativeAdjustments||[]){
  const source=row.target==='yearEnd'?yearEnd:previous;
  if(!source?.has(row.item)){report.issues.push({type:'comparative_adjustment',reference:row.item,message:'已复核比较底稿缺少此项目，不能假定原数为零'});continue}
  const key=JSON.stringify([row.target,row.item]),amount=new Decimal(row.amount);
  adjustments.set(key,(adjustments.get(key)||new Decimal(0)).plus(amount));
  if(row.target==='yearEnd'&&catalog){
   const factor=catalog.assets.includes(row.item)?1:catalog.liabilities.includes(row.item)?-1:catalog.equity.includes(row.item)?(row.item==='库存股'?1:-1):0;
   groupBalances.set(row.group,(groupBalances.get(row.group)||new Decimal(0)).plus(amount.mul(factor)));
  }
 }
 for(const [group,amount] of groupBalances)if(!amount.isZero())report.issues.push({type:'comparative_adjustment',reference:group,message:`该组资产负债调整不平衡，差额 ${amount.toFixed(2)} 元`});
 if(report.issues.length)missing.push('本期存在未处理差异');
 const currentBalance=mapValues(mapping.balance),currentIncome=mapValues(mapping.income);
 const adjusted=(original:string|undefined,target:string,item:string)=>original===undefined?null:new Decimal(original).plus(adjustments.get(JSON.stringify([target,item]))||0).toFixed(2);
 const balance=[...new Set([...currentBalance.keys(),...(yearEnd?[...yearEnd.keys()]:[])])].map(item=>({item,current:currentBalance.get(item)??null,yearEnd:yearEnd?.get(item)??null,yearEndAdjusted:adjusted(yearEnd?.get(item),'yearEnd',item)}));
 const income=[...new Set([...currentIncome.keys(),...(previous?[...previous.keys()]:[])])].map(item=>({item,current:currentIncome.get(item)??null,priorPeriod:previous?.get(item)??null,priorPeriodAdjusted:adjusted(previous?.get(item),'priorPeriod',item),ytd:null as string|null}));
 let cashFlowYtd:any=null;
 if(!missing.length){
  const all=[...previousReports,report];const totals=new Map<string,Decimal>();
  for(const r of all)for(const x of r.statementMapping.income)totals.set(x.item,(totals.get(x.item)||new Decimal(0)).plus(x.amount));
  for(const item of totals.keys())if(!income.some(x=>x.item===item))income.push({item,current:null,priorPeriod:previous?.get(item)??null,priorPeriodAdjusted:adjusted(previous?.get(item),'priorPeriod',item),ytd:null});
  for(const row of income)row.ytd=totals.get(row.item)?.toFixed(2)??null;
  if(all.every(r=>r.cashFlow.status==='已分类，待复核'))cashFlowYtd=Object.fromEntries(['operating','investing','financing','exchange','classifiedNet'].map(key=>[key,all.reduce((s,r)=>s.plus(r.cashFlow[key]),new Decimal(0)).toFixed(2)]));
 }
 return {status:'映射核对底稿，尚非正式报表',missing,sources,balance,income,cashFlowYtd,adjustments:input.comparativeAdjustments,limitations:'仅列示已映射项目；比较调整仅作人工底稿，不自动修改历史数据，适用性和完整性须独立复核。'};
}
