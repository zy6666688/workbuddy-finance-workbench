import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountingReport} from '../src/accounting.js';
import {equityDraft} from '../src/equity-context.js';
function fixture(period:string,opening:number,change:number,basis:string){
 return {reportingBasis:basis,accounts:[{code:'bank',name:'银行',category:'asset',opening:String(opening)},{code:'capital',name:'资本',category:'equity',opening:String(-opening)}],
  vouchers:[{number:'V',date:period+'-05',lines:[{account:'bank',debit:String(change),credit:'0'},{account:'capital',debit:'0',credit:String(change)}]}],invoices:[],
  equityMovement:[{account:'capital',category:'capital',amount:String(change),evidence:'虚构凭证'}],
  statementMappings:[{account:'bank',table:'balance',item:'货币资金',amount:String(opening+change),evidence:'银行'},{account:'capital',table:'balance',item:'实收资本（或股本）',amount:String(-opening-change),evidence:'资本'}]};
}
test('equity matrix is built from reviewed months and does not fill missing periods',async()=>{
 for(const basis of ['small_2011','enterprise_2019_new']){
  const first=fixture('2026-01',100,10,basis),current=fixture('2026-02',110,20,basis);
  const rows=[{id:'id',period:'2026-01',version:1,payload:first}],db={query:async()=>({rows})};
  let result=await equityDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
  assert.equal(result.status,'权益变动矩阵底稿，待复核');
  assert.equal(result.rows.find(r=>r.row==='opening')!.values['实收资本（或股本）'],'100.00');
  assert.equal(result.rows.find(r=>r.row==='capital')!.values['实收资本（或股本）'],'30.00');
  assert.equal(result.rows.find(r=>r.row==='closing')!.values['实收资本（或股本）'],'130.00');
  rows.length=0;result=await equityDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
  assert.equal(result.status,'权益变动底稿待补');assert.deepEqual(result.rows,[]);
 }
});
test('equity matrix rejects broken account continuity and classification',async()=>{
 const first=fixture('2026-01',100,10,'enterprise_2019_new'),current=fixture('2026-02',111,20,'enterprise_2019_new');
 const db={query:async()=>({rows:[{id:'id',period:'2026-01',version:1,payload:first}]})};
 let result=await equityDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
 assert.ok(result.missing.some(x=>x.includes('不衔接')));
 current.equityMovement[0].amount='19';
 result=await equityDraft(db,'synthetic','2026-02',current,accountingReport(current,'2026-02'));
 assert.ok(result.missing.some(x=>x.includes('未完成')));
});
