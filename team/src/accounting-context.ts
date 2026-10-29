import { Decimal } from "decimal.js";
import { accountingInput,accountingReport } from "./accounting.js";
import { statementDraft } from "./statement-context.js";
import { cashflowDraft } from "./cashflow-context.js";
import { equityDraft } from "./equity-context.js";
export async function contextualAccountingReport(db:any,cid:string,period:string,raw:unknown){
 const input=accountingInput.parse(raw),report=accountingReport(input,period);
 const comparative:any={yearEnd:{status:'未提供'},priorPeriod:{status:'未提供'}};
 if(input.comparative){
  const [year,month]=period.split('-');
  for(const [key,id,expected] of [['yearEnd',input.comparative.yearEndSnapshotId,`${Number(year)-1}-12`],['priorPeriod',input.comparative.priorPeriodSnapshotId,`${Number(year)-1}-${month}`]] as const){
   if(!id)continue;
   const row=(await db.query("SELECT s.id,s.period,s.version,s.payload,w.status,w.submission FROM accounting_snapshots s LEFT JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.id=$1 AND s.company_id=$2",[id,cid])).rows[0];
   if(!row||row.period!==expected||!['delivery','archived'].includes(row.status)||row.submission?.accounting?.id!==row.id){report.issues.push({type:'comparative',reference:key==='yearEnd'?'上年末':'上年同期',message:'比较底稿不存在、期间不符或不是已独立复核的版本'});comparative[key]={status:'关联失败'};continue}
   const source=accountingReport(row.payload,row.period);
   const historicalBasis=accountingInput.parse(row.payload).reportingBasis;
   if((input.reportingBasis||historicalBasis)&&input.reportingBasis!==historicalBasis)report.issues.push({type:'comparative',reference:row.period,message:'比较底稿与当前底稿准则口径不一致或未明确，需人工核对调整'});
   if(source.issues.length)report.issues.push({type:'comparative',reference:row.period,message:'比较底稿存在未解决的核对差异'});
   comparative[key]={status:'已关联',id:row.id,period:row.period,version:row.version,summary:source.summary,trial:source.trial,cashFlow:source.cashFlow,statementMapping:source.statementMapping};
  }
 }
 let previous:any={status:"未关联上期"};
 if(input.previousSnapshotId){
  const [year,month]=period.split("-").map(Number), prior=month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,"0")}`;
  const row=(await db.query("SELECT s.id,s.period,s.version,s.payload,w.status,w.submission FROM accounting_snapshots s LEFT JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.id=$1 AND s.company_id=$2",[input.previousSnapshotId,cid])).rows[0];
  if(!row||row.period!==prior||!['delivery','archived'].includes(row.status)||row.submission?.accounting?.id!==row.id){report.issues.push({type:'previous',reference:'上期底稿',message:'上期底稿不存在、期间不符或不是已独立复核的版本'});previous={status:'关联失败'}}
  else{
   const old=accountingReport(row.payload,prior), current=new Map(report.trial.map(a=>[a.code,a])), historical=new Map(old.trial.map(a=>[a.code,a]));
   const historicalBasis=accountingInput.parse(row.payload).reportingBasis;
   if((input.reportingBasis||historicalBasis)&&input.reportingBasis!==historicalBasis)report.issues.push({type:'previous',reference:prior,message:'上期与本期准则口径不一致或未明确，需人工核对衔接'});
   if(old.issues.length)report.issues.push({type:'previous',reference:prior,message:'上期底稿本身存在差异，不能确认衔接'});
   for(const a of old.trial.filter(a=>['revenue','expense'].includes(a.category)))if(!new Decimal(a.closing).isZero())report.issues.push({type:'closing',reference:a.code,message:'上期损益科目尚未结转至零，请核对结转凭证'});
   for(const code of new Set([...historical.keys(),...current.keys()])){
    const a=historical.get(code),b=current.get(code);if(a&&['revenue','expense'].includes(a.category)||b&&['revenue','expense'].includes(b.category))continue;
    if(a&&b&&a.category!==b.category)report.issues.push({type:'previous',reference:code,message:'上期与本期科目分类不同，需人工核对'});
    if(!new Decimal(a?.closing||0).equals(b?.opening||0))report.issues.push({type:'previous',reference:code,message:`上期期末 ${a?.closing||'0.00'} 元，本期期初 ${b?.opening||'0.00'} 元`});
   }
   previous={status:'已比较',period:prior,version:row.version,id:row.id};
  }
 }
 const reds=input.invoices.filter(i=>i.color==='red'&&i.originalPeriod&&i.originalNumber);
 if(reds.length){
  const referenced=[...new Set(reds.map(i=>i.originalSnapshotId).filter(Boolean))];
  const rows=referenced.length?(await db.query("SELECT s.id,s.period,s.payload,w.status,w.submission FROM accounting_snapshots s LEFT JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.company_id=$1 AND s.id=ANY($2::uuid[])",[cid,referenced])).rows:[];
  const sources=new Map<string,any>(rows.map((row:any)=>[row.id,row]));
  // Reserve red amounts only when another month is actually submitted or
  // approved. Unsubmitted drafts must not change an archived report.
  const others=(await db.query("SELECT s.period,s.payload->'invoices' AS invoices FROM accounting_snapshots s JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.company_id=$1 AND s.period<>$2 AND w.status IN ('review','delivery','archived') AND w.submission->'accounting'->>'id'=s.id::text",[cid,period])).rows;
  for(const red of reds){
   const source=red.originalPeriod===period?{period,payload:input}:sources.get(red.originalSnapshotId);
   if(!source||source.period!==red.originalPeriod){report.issues.push({type:'red_invoice',reference:red.number,message:'原蓝字底稿不存在、公司或期间不匹配'});continue}
   if(red.originalPeriod!==period&&(!['delivery','archived'].includes(source.status)||source.submission?.accounting?.id!==source.id)){report.issues.push({type:'red_invoice',reference:red.number,message:'原蓝字底稿不是已独立复核的版本'});continue}
   const blues=accountingInput.parse(source.payload).invoices.filter((i:any)=>i.color==='blue'&&i.kind===red.kind&&i.number===red.originalNumber);
   if(blues.length!==1){report.issues.push({type:'red_invoice',reference:red.number,message:'未找到唯一的原蓝字发票'});continue}
   const related=[...input.invoices,...others.flatMap((row:any)=>Array.isArray(row.invoices)?row.invoices:[])].filter((i:any)=>i.color==='red'&&i.kind===red.kind&&i.originalPeriod===red.originalPeriod&&i.originalNumber===red.originalNumber);
   for(const key of ['net','tax','gross'] as const){const total=related.reduce((s:any,i:any)=>s.plus(i[key]),new Decimal(0));if(total.negated().gt(blues[0][key]))report.issues.push({type:'red_invoice',reference:red.number,message:`多张红字发票的${key==='net'?'金额':key==='tax'?'税额':'价税合计'}超过原蓝字金额`})}
  }
 }
 let bank:any={status:"未关联银行流水"};
 if(input.bankImportId&&input.bankAccounts.length){
  const row=(await db.query("SELECT payload FROM import_previews WHERE id=$1 AND company_id=$2 AND kind='bank' AND committed_at IS NOT NULL",[input.bankImportId,cid])).rows[0];
  if(!row||row.payload.period!==period){report.issues.push({type:"bank",reference:"银行流水",message:"已确认流水不存在、无权访问或期间不一致"});bank={status:"关联失败"}}
  else {const total=new Decimal(row.payload.total),movement=new Decimal(report.bankMovement),difference=total.minus(movement);bank={status:"已比较",total:total.toFixed(2),movement:movement.toFixed(2),difference:difference.toFixed(2)};if(!difference.isZero())report.issues.push({type:"bank",reference:"银行流水",message:`流水合计 ${bank.total} 元，凭证银行净发生额 ${bank.movement} 元，差额 ${bank.difference} 元`})}
 }
 const workspace=(await db.query("SELECT state FROM finance_workspaces WHERE company_id=$1 AND period=$2",[cid,period])).rows[0];
 const snapshot=workspace?.state?.snapshots?.find((s:any)=>s.period===period);
 const compare=(key:string,total:string)=>{const value=snapshot?.[key];if(value===null||value===undefined||value==="")return null;return {manual:new Decimal(value).toFixed(2),book:total,difference:new Decimal(value).minus(total).toFixed(2)}};
 const statements=await statementDraft(db,cid,period,input,report,comparative);
 const cashFlowStatement=await cashflowDraft(db,cid,period,input,report);
 const equityStatement=await equityDraft(db,cid,period,input,report);
 return {...report,statements,cashFlowStatement,equityStatement,comparative,previous,bank,snapshotComparison:{income:compare("income",report.summary.revenue),expense:compare("expense",report.summary.expenses)}};
}
