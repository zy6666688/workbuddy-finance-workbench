import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountingReport} from '../src/accounting.js';
import {cashflowDraft} from '../src/cashflow-context.js';

function month(period:string,opening:number,amount:number,basis:string){
 const item=basis==='small_2011'?'吸收投资者投资收到的现金':'吸收投资收到的现金';
 return {reportingBasis:basis,accounts:[{code:'bank',name:'银行',category:'asset',opening:String(opening)},{code:'capital',name:'权益',category:'equity',opening:String(-opening)}],
  vouchers:[{number:'V1',date:period+'-05',lines:[{account:'bank',debit:String(amount),credit:'0'},{account:'capital',debit:'0',credit:String(amount)}]}],
  invoices:[],cashFlow:{accounts:['bank'],allocations:[{voucher:'V1',line:1,category:'financing_in',amount:String(amount),item}]}};
}
test('cashflow cumulative and comparison require all approved months and matching balances',async()=>{
 for(const basis of ['small_2011','enterprise_2019_new']){
  const rows=[
   {id:'a',period:'2025-01',version:1,payload:month('2025-01',80,5,basis)},
   {id:'b',period:'2025-02',version:1,payload:month('2025-02',85,7,basis)},
   {id:'c',period:'2026-01',version:1,payload:month('2026-01',100,10,basis)}
  ];
  const current=month('2026-02',110,20,basis);
  const db={query:async()=>({rows})};
  let result=await cashflowDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
  let line=result.items.find(x=>x.category==='financing_in'&&x.current==='20.00')!;
  assert.equal(line.ytd,'30.00');assert.equal(line.priorPeriod,'7.00');assert.equal(line.priorYtd,'12.00');assert.deepEqual(result.missing,[]);
  rows.splice(0,1);
  result=await cashflowDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
  line=result.items.find(x=>x.category==='financing_in'&&x.current==='20.00')!;
  assert.equal(line.priorYtd,null);assert.equal(line.priorPeriod,'7.00');assert.ok(result.missing.some(x=>x.includes('2025-01')));
  rows.find(x=>x.period==='2026-01')!.payload.cashFlow.allocations[0].item='';
  result=await cashflowDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
  assert.equal(result.items.find(x=>x.current==='20.00')!.ytd,null);
 }
});
test('cashflow cumulative rejects a broken month-to-month cash balance',async()=>{
 const basis='small_2011',first=month('2026-01',100,10,basis),current=month('2026-02',111,20,basis);
 const db={query:async()=>({rows:[{id:'c',period:'2026-01',version:1,payload:first}]})};
 const result=await cashflowDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
 assert.ok(result.missing.some(x=>x.includes('不衔接')));assert.equal(result.items.find(x=>x.current==='20.00')!.ytd,null);
});
