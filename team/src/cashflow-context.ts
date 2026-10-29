import { Decimal } from 'decimal.js';
import { accountingInput, accountingReport } from './accounting.js';
import { cashflowCatalog } from './cashflow-catalog.js';

// Cumulative amounts only use pinned, independently reviewed monthly snapshots.
// A complete classification supports a zero for an absent line; a missing month never does.
export async function cashflowDraft(db:any, companyId:string, period:string, raw:unknown, current:any) {
 const input=accountingInput.parse(raw);
 if(!input.cashFlow||!input.reportingBasis)return {status:'未提供现金流分类',missing:[],items:[]};
 const [year,month]=period.split('-').map(Number);
 const periods=(y:number,last:number)=>Array.from({length:last},(_,i)=>`${y}-${String(i+1).padStart(2,'0')}`);
 const thisYear=periods(year,month),priorYear=periods(year-1,month);
 const requested=[...thisYear.slice(0,-1),...priorYear];
 const rows=requested.length?(await db.query("SELECT s.id,s.period,s.version,s.payload FROM accounting_snapshots s JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.company_id=$1 AND s.period=ANY($2::text[]) AND w.status IN ('delivery','archived') AND w.submission->'accounting'->>'id'=s.id::text",[companyId,requested])).rows:[];
 const byPeriod=new Map<string,any>(rows.map((row:any)=>[row.period,row]));
 const missing:string[]=[],sources:any[]=[];
 const read=(p:string):any=>{
  const row=p===period?{period:p,payload:input}:byPeriod.get(p);
  if(!row){missing.push(`${p} 缺少已复核底稿`);return null}
  const data=accountingInput.parse(row.payload), result=p===period?current:accountingReport(data,p);
  if(data.reportingBasis!==input.reportingBasis||!data.cashFlow||result.issues.length||result.cashFlow.missingItems!==0){
   missing.push(`${p} 口径或现金流明细未完成`);return null;
  }
  if(row.id)sources.push({id:row.id,period:p,version:row.version});
  return {data,result};
 };
 const currentPeriods=thisYear.map(read),priorPeriods=priorYear.map(read);
 const continuous=(values:any[],label:string)=>{
  if(values.some(x=>!x))return false;
  for(let i=1;i<values.length;i++){
   const prev=values[i-1],next=values[i];
   const before=[...prev.data.cashFlow.accounts].sort().join('\u0000'),after=[...next.data.cashFlow.accounts].sort().join('\u0000');
   if(before!==after||!new Decimal(prev.result.cashFlow.closing).equals(next.result.cashFlow.opening)){
    missing.push(`${label} 现金范围或月间余额不衔接（第 ${i+1} 月）`);return false;
   }
  }
  return true;
 };
 const currentComplete=continuous(currentPeriods,'本年'),priorComplete=continuous(priorPeriods,'上年同期');
 const sum=(values:any[],category:string,item:string)=>values.reduce((total,x)=>total.plus(x.result.cashFlow.items.find((r:any)=>r.category===category&&r.item===item)?.amount??0),new Decimal(0)).toFixed(2);
 const itemRows=Object.entries(cashflowCatalog(input.reportingBasis)).flatMap(([category,items])=>items.map(item=>({
  category,item,
  current:currentPeriods.at(-1)?sum([currentPeriods.at(-1)],category,item):null,
  ytd:currentComplete?sum(currentPeriods,category,item):null,
  priorPeriod:priorPeriods.at(-1)?sum([priorPeriods.at(-1)],category,item):null,
  priorYtd:priorComplete?sum(priorPeriods,category,item):null
 })));
 return {status:'现金流明细核对底稿，待复核',missing,sources,items:itemRows,
  limitations:'按逐笔分类汇总；现金范围和业务分类须独立复核。累计和比较期缺少已复核月份或余额不衔接时不生成。'};
}
