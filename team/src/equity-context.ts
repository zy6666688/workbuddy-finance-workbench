import {Decimal} from 'decimal.js';
import {accountingInput,accountingReport} from './accounting.js';
import {statementCatalog} from './statement-mapping.js';

// A checked matrix, not a statutory owners' equity statement: classification
// and completeness are supplied by an accountant and require review.
export async function equityDraft(db:any,companyId:string,period:string,raw:unknown,current:any){
 const input=accountingInput.parse(raw);
 if(!input.equityMovement)return {status:'未提供权益变动',missing:[],columns:[],rows:[]};
 const [year,month]=period.split('-').map(Number);
 const periods=Array.from({length:month},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`);
 const expected=periods.slice(0,-1);
 const rows=expected.length?(await db.query("SELECT s.id,s.period,s.version,s.payload FROM accounting_snapshots s JOIN work_orders w ON w.company_id=s.company_id AND w.period=s.period WHERE s.company_id=$1 AND s.period=ANY($2::text[]) AND w.status IN ('delivery','archived') AND w.submission->'accounting'->>'id'=s.id::text",[companyId,expected])).rows:[];
 const byPeriod=new Map<string,any>(rows.map((r:any)=>[r.period,r])),missing:string[]=[],sources:any[]=[];
 const catalog=statementCatalog(input.reportingBasis||'');
 const parts=periods.map(p=>{
  const row=p===period?{period:p,payload:input}:byPeriod.get(p);
  if(!row){missing.push(`${p} 缺少已复核底稿`);return null}
  const data=accountingInput.parse(row.payload),report=p===period?current:accountingReport(data,p);
  if(data.reportingBasis!==input.reportingBasis||!catalog||!data.statementMappings||!data.equityMovement||report.issues.length){
   missing.push(`${p} 口径、权益变动或报表映射未完成`);return null;
  }
  const mapped=new Map<string,string>();
  for(const account of data.accounts.filter(a=>a.category==='equity')){
   const links=data.statementMappings.filter(x=>x.account===account.code&&x.table==='balance');
   if(links.length!==1||!catalog.equity.includes(links[0].item)){missing.push(`${p} 科目 ${account.code} 未唯一映射至权益项目`);return null}
   mapped.set(account.code,links[0].item);
  }
  if(row.id)sources.push({id:row.id,period:p,version:row.version});
  return {data,report,mapped};
 });
 if(parts.some(p=>!p))return {status:'权益变动底稿待补',missing,sources,columns:[],rows:[]};
 const values=parts as any[],first=values[0],last=values[values.length-1],accounts=[...first.mapped.keys()] as string[];
 for(let i=1;i<values.length;i++){
  const previous=values[i-1],next=values[i];
  if(previous.mapped.size!==next.mapped.size){missing.push(`${periods[i]} 权益科目范围变化，须人工衔接`);continue}
  for(const code of accounts){
   const before=previous.report.trial.find((a:any)=>a.code===code),after=next.report.trial.find((a:any)=>a.code===code);
   if(!before||!after||previous.mapped.get(code)!==next.mapped.get(code)||!new Decimal(before.closing).equals(after.opening)){
    missing.push(`${periods[i]} 科目 ${code} 余额或权益项目不衔接`);
   }
  }
 }
 if(missing.length)return {status:'权益变动底稿待补',missing,sources,columns:[],rows:[]};
 const categories=['profit','capital','distribution','reserve','other_comprehensive','other'];
 const columns=[...new Set(accounts.map(code=>first.mapped.get(code))) ] as string[];
 const sums=new Map<string,Decimal>(),add=(row:string,col:string,value:Decimal)=>{const key=JSON.stringify([row,col]);sums.set(key,(sums.get(key)||new Decimal(0)).plus(value))};
 for(const code of accounts){
  const col=first.mapped.get(code)!,factor=col==='库存股'?-1:1;
  const begin=first.report.trial.find((a:any)=>a.code===code),end=last.report.trial.find((a:any)=>a.code===code);
  add('opening',col,new Decimal(begin.opening).negated().mul(factor));
  add('closing',col,new Decimal(end.closing).negated().mul(factor));
  for(const part of values)for(const move of part.data.equityMovement.filter((x:any)=>x.account===code))add(move.category,col,new Decimal(move.amount).mul(factor));
 }
 const output=['opening',...categories,'closing'].map(row=>({row,values:Object.fromEntries(columns.map(col=>[col,(sums.get(JSON.stringify([row,col]))||new Decimal(0)).toFixed(2)]))}));
 return {status:'权益变动矩阵底稿，待复核',missing,sources,columns,rows:output,
  limitations:'按会计填写的科目和变动类型汇总，暂不包含完整法定行次或调整后比较数；变动性质和披露须独立复核。'};
}
