import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountingReport} from '../src/accounting.js';
import {contextualAccountingReport} from '../src/accounting-context.js';
import {statementDraft} from '../src/statement-context.js';
import {statementCatalog} from '../src/statement-mapping.js';
const sample=()=>({accounts:[{code:'bank',name:'银行',category:'asset',opening:'1000'},{code:'tax',name:'税',category:'liability',opening:'0'},{code:'equity',name:'权益',category:'equity',opening:'-1000'},{code:'income',name:'收入',category:'revenue',opening:'0'},{code:'expense',name:'费用',category:'expense',opening:'0'}],vouchers:[{number:'V1',date:'2026-10-05',lines:[{account:'bank',debit:'113',credit:'0'},{account:'income',debit:'0',credit:'100'},{account:'tax',debit:'0',credit:'13'}]},{number:'V2',date:'2026-10-06',lines:[{account:'expense',debit:'20',credit:'0'},{account:'bank',debit:'0',credit:'20'}]}],invoices:[{number:'B1',date:'2026-10-05',kind:'sale',net:'100',tax:'13',gross:'113',voucher:'V1',account:'income',taxAccount:'tax'}]});
test('explicit closing retains period profit while closing balances to equity',()=>{
 const x=sample();x.vouchers.push({number:'C1',date:'2026-10-31',closing:true,lines:[{account:'income',debit:'100',credit:'0'},{account:'expense',debit:'0',credit:'20'},{account:'equity',debit:'0',credit:'80'}]} as any);
 const r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.summary.profit,'80.00');assert.equal(r.summary.equity,'1080.00');assert.equal(r.summary.balanceDifference,'0.00');assert.equal(r.trial.find(a=>a.code==='income')!.closing,'0.00');
});
test('red invoice compares signed reversal and rejects cumulative over-red',async()=>{
 const x:any=sample();x.vouchers.push({number:'R1',date:'2026-10-10',lines:[{account:'bank',debit:'0',credit:'45.20'},{account:'income',debit:'40',credit:'0'},{account:'tax',debit:'5.20',credit:'0'}]});x.invoices.push({number:'R1',date:'2026-10-10',kind:'sale',color:'red',originalPeriod:'2026-10',originalNumber:'B1',net:'-40',tax:'-5.20',gross:'-45.20',voucher:'R1',account:'income',taxAccount:'tax'});
 const db={query:async()=>({rows:[]})};let r=await contextualAccountingReport(db,'fake','2026-10',x);assert.deepEqual(r.issues,[]);assert.equal(r.summary.revenue,'60.00');
 x.invoices.push({...x.invoices[1],number:'R2',net:'-70',tax:'-9.1',gross:'-79.1'});r=await contextualAccountingReport(db,'fake','2026-10',x);assert.ok(r.issues.some(i=>i.type==='red_invoice'&&i.message.includes('超过')));
});

test('reviewed prior closing balances must agree with the next month',async()=>{
 const old=sample();old.vouchers.push({number:'C1',date:'2026-10-31',closing:true,lines:[{account:'income',debit:'100',credit:'0'},{account:'expense',debit:'0',credit:'20'},{account:'equity',debit:'0',credit:'80'}]} as any);
 const id='8f480b0c-e5ee-40f2-9bcc-763f8671f1d0';const prior={id,period:'2026-10',version:3,payload:old,status:'archived',submission:{accounting:{id}}};
 const db={query:async(sql:string)=>({rows:sql.includes('s.id=$1')?[prior]:[]})};
 const next:any={accounts:[{code:'bank',name:'银行',category:'asset',opening:'1093'},{code:'tax',name:'税',category:'liability',opening:'-13'},{code:'equity',name:'权益',category:'equity',opening:'-1080'},{code:'income',name:'收入',category:'revenue',opening:'0'},{code:'expense',name:'费用',category:'expense',opening:'0'}],vouchers:[],invoices:[],previousSnapshotId:id};
 let r=await contextualAccountingReport(db,'fake','2026-11',next);assert.equal(r.previous.status,'已比较');assert.deepEqual(r.issues,[]);
 next.accounts[0].opening='1092';r=await contextualAccountingReport(db,'fake','2026-11',next);assert.ok(r.issues.some(i=>i.type==='previous'));
 prior.status='processing';r=await contextualAccountingReport(db,'fake','2026-11',next);assert.equal(r.previous.status,'关联失败');
});
test('red invoice is anchored to the reviewed prior snapshot and checks other months',async()=>{
 const old=sample(),id='8f480b0c-e5ee-40f2-9bcc-763f8671f1d0';const source={id,period:'2026-10',payload:old,status:'archived',submission:{accounting:{id}}};
 const next:any={accounts:old.accounts.map(a=>({...a,opening:'0'})),vouchers:[{number:'R1',date:'2026-11-05',lines:[{account:'income',debit:'40',credit:'0'},{account:'tax',debit:'5.2',credit:'0'},{account:'bank',debit:'0',credit:'45.2'}]}],invoices:[{number:'R1',date:'2026-11-05',kind:'sale',color:'red',originalPeriod:'2026-10',originalNumber:'B1',originalSnapshotId:id,net:'-40',tax:'-5.2',gross:'-45.2',voucher:'R1',account:'income',taxAccount:'tax'}]};
 const previousRed={...next.invoices[0],number:'R2',net:'-70',tax:'-9.10',gross:'-79.10'};
 const db={query:async(sql:string)=>({rows:sql.includes('id=ANY')?[source]:sql.includes("s.period<>")?[{period:'2026-12',invoices:[previousRed]}]:[]})};
 let r=await contextualAccountingReport(db,'fake','2026-11',next);assert.ok(r.issues.some(i=>i.type==='red_invoice'&&i.message.includes('超过')));
 source.status='processing';r=await contextualAccountingReport(db,'fake','2026-11',next);assert.ok(r.issues.some(i=>i.type==='red_invoice'&&i.message.includes('复核')));
});

test('cash-flow classifications reconcile each cash line with the ledger',()=>{
 const x:any=sample();x.cashFlow={accounts:['bank'],allocations:[{voucher:'V1',line:1,category:'operating_in',amount:'113'},{voucher:'V2',line:2,category:'operating_out',amount:'-20'}]};
 const r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.cashFlow.operating,'93.00');assert.equal(r.cashFlow.opening,'1000.00');assert.equal(r.cashFlow.closing,'1093.00');assert.equal(r.cashFlow.classifiedNet,'93.00');
 x.cashFlow.allocations.pop();const missing=accountingReport(x,'2026-10');assert.ok(missing.issues.some(i=>i.type==='cashflow'&&i.message.includes('分类合计')));
 x.cashFlow.allocations.push({voucher:'V2',line:2,category:'investing_in',amount:'-20'});assert.ok(accountingReport(x,'2026-10').issues.some(i=>i.type==='cashflow'&&i.message.includes('方向')));
});
test('internal cash transfers are excluded and must balance in the voucher',()=>{
 const x:any=sample();x.accounts.push({code:'cash',name:'现金',category:'asset',opening:'0'});x.vouchers.push({number:'T1',date:'2026-10-07',lines:[{account:'bank',debit:'0',credit:'10'},{account:'cash',debit:'10',credit:'0'}]});
 x.cashFlow={accounts:['bank','cash'],allocations:[{voucher:'V1',line:1,category:'operating_in',amount:'113'},{voucher:'V2',line:2,category:'operating_out',amount:'-20'},{voucher:'T1',line:1,category:'internal',amount:'-10'},{voucher:'T1',line:2,category:'internal',amount:'10'}]};
 let r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.cashFlow.classifiedNet,'93.00');x.cashFlow.allocations.pop();r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.message.includes('内部现金调拨')));
});

test('comparison data is pinned to an approved same-company period and missing is not zero',async()=>{
 const old=sample(),id='8f480b0c-e5ee-40f2-9bcc-763f8671f1d0';old.vouchers.forEach(v=>v.date=v.date.replace('2026-10','2025-10'));old.invoices[0].date='2025-10-05';
 const prior={id,period:'2025-10',version:2,payload:old,status:'archived',submission:{accounting:{id}}};
 const db={query:async(sql:string)=>({rows:sql.includes('s.id=$1')?[prior]:[]})};
 const current:any=sample();current.comparative={yearEndSnapshotId:'',priorPeriodSnapshotId:id};
 let r=await contextualAccountingReport(db,'fake','2026-10',current);assert.equal(r.comparative.yearEnd.status,'未提供');assert.equal(r.comparative.priorPeriod.summary.revenue,'100.00');assert.equal(r.comparative.priorPeriod.period,'2025-10');
 prior.period='2025-09';r=await contextualAccountingReport(db,'fake','2026-10',current);assert.ok(r.issues.some(i=>i.type==='comparative'));assert.equal(r.comparative.priorPeriod.status,'关联失败');
 prior.period='2025-10';current.reportingBasis='small_2011';r=await contextualAccountingReport(db,'fake','2026-10',current);assert.ok(r.issues.some(i=>i.message.includes('准则口径')));
});

test('reclassification covers each balance and retains evidence without changing the ledger',()=>{
 const x:any=sample();x.reclassification=[{account:'bank',target:'asset',amount:'1098',evidence:'应收明细借方合计'},{account:'bank',target:'liability',amount:'-5',evidence:'应收明细贷方合计'},{account:'tax',target:'liability',amount:'-13',evidence:'账簿'},{account:'equity',target:'equity',amount:'-1000',evidence:'账簿'}];
 let r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.reclassification.assets,'1098.00');assert.equal(r.reclassification.liabilities,'18.00');assert.equal(r.reclassification.balanceDifference,'0.00');assert.equal(r.trial.find(a=>a.code==='bank')!.closing,'1093.00');
 x.reclassification[0].amount='1097';r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='reclassification'&&i.reference==='bank'));
 x.reclassification[0].evidence='';assert.throws(()=>accountingReport(x,'2026-10'));
});

test('counterparty details split debit and credit before netting and reconcile to ledger',()=>{
 const x:any=sample();x.reportingBasis='small_2011';x.accounts.push({code:'ar',name:'应收账款',category:'asset',opening:'0'});
 x.vouchers.push({number:'AR',date:'2026-10-08',lines:[{account:'ar',debit:'80',credit:'0'},{account:'bank',debit:'0',credit:'80'}]});
 x.reclassification=[{account:'bank',target:'asset',amount:'1013',evidence:'银行'},{account:'ar',target:'asset',amount:'100',evidence:'往来借方'},{account:'ar',target:'liability',amount:'-20',evidence:'往来贷方'},{account:'tax',target:'liability',amount:'-13',evidence:'税额'},{account:'equity',target:'equity',amount:'-1000',evidence:'权益'}];
 x.counterparties={accounts:[{account:'ar',kind:'receivable'}],rows:[{account:'ar',party:'虚构甲',detail:'合同A',amount:'100',target:'receivable',evidence:'明细A'},{account:'ar',party:'虚构乙',detail:'合同B',amount:'-20',target:'advance',evidence:'明细B'}]};
 let r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.counterparties.items.receivable,'100.00');assert.equal(r.counterparties.items.advance,'20.00');assert.equal(r.reclassification.balanceDifference,'0.00');
 x.statementMappings=[{account:'bank',table:'balance',item:'货币资金',amount:'1013',evidence:'银行'},{account:'ar',table:'balance',item:'应收账款',amount:'100',evidence:'明细A'},{account:'ar',table:'balance',item:'预收账款',amount:'-20',evidence:'明细B'},{account:'tax',table:'balance',item:'应交税费',amount:'-13',evidence:'税额'},{account:'equity',table:'balance',item:'实收资本（或股本）',amount:'-1000',evidence:'权益'},{account:'income',table:'balance',item:'未分配利润',amount:'-100',evidence:'损益'},{account:'expense',table:'balance',item:'未分配利润',amount:'20',evidence:'损益'},{account:'income',table:'income',item:'营业收入',amount:'-100',evidence:'收入'},{account:'expense',table:'income',item:'管理费用',amount:'20',evidence:'费用'}];
 r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.statementMapping.balance.find(y=>y.item==='应收账款')?.amount,'100.00');assert.equal(r.statementMapping.balance.find(y=>y.item==='预收账款')?.amount,'20.00');
 x.counterparties.rows[1].amount='-19';r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='counterparty'&&i.message.includes('不一致')));
 x.counterparties.rows.push({...x.counterparties.rows[0]});r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='counterparty'&&i.message.includes('重复')));
});
test('classification refuses incompatible small-enterprise targets and missing evidence',()=>{
 const x:any=sample();x.reportingBasis='small_2011';x.counterparties={accounts:[{account:'bank',kind:'receivable'}],rows:[{account:'bank',party:'虚构客户',detail:'合同1',amount:'1093',target:'contract_asset',evidence:'测试底稿'}]};
 let r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='counterparty'&&i.message.includes('不适用')));
 x.counterparties.rows[0].evidence='';assert.throws(()=>accountingReport(x,'2026-10'));
});

test('statement mapping preserves ledger coverage, polarity and basis-specific line items',()=>{
 const x:any=sample();x.reportingBasis='small_2011';x.statementMappings=[
  {account:'bank',table:'balance',item:'货币资金',amount:'1093',evidence:'银行'},
  {account:'tax',table:'balance',item:'应交税费',amount:'-13',evidence:'税额'},
  {account:'equity',table:'balance',item:'实收资本（或股本）',amount:'-1000',evidence:'权益'},
  {account:'income',table:'balance',item:'未分配利润',amount:'-100',evidence:'未结转损益'},
  {account:'expense',table:'balance',item:'未分配利润',amount:'20',evidence:'未结转损益'},
  {account:'income',table:'income',item:'营业收入',amount:'-100',evidence:'收入明细'},
  {account:'expense',table:'income',item:'管理费用',amount:'20',evidence:'费用明细'}];
 let r=accountingReport(x,'2026-10');assert.deepEqual(r.issues,[]);assert.equal(r.statementMapping.balance.find(y=>y.item==='货币资金')?.amount,'1093.00');assert.equal(r.statementMapping.balance.find(y=>y.item==='未分配利润')?.amount,'80.00');assert.equal(r.statementMapping.income.find(y=>y.item==='营业收入')?.amount,'100.00');
 x.statementMappings[0].amount='1092';r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='statement_mapping'&&i.reference==='bank'));
 x.statementMappings[0].amount='1093';x.statementMappings[0].item='合同资产';r=accountingReport(x,'2026-10');assert.ok(r.issues.some(i=>i.type==='statement_mapping'&&i.message.includes('不属于')));
 x.reportingBasis='enterprise_2019_new';r=accountingReport(x,'2026-10');assert.ok(!r.issues.some(i=>i.message.includes('不属于')));
});

test('year-to-date mapping requires each approved month instead of silently filling gaps',async()=>{
 const current:any=sample();current.reportingBasis='small_2011';current.vouchers.forEach((v:any)=>v.date=v.date.replace('2026-10','2026-02'));current.invoices[0].date='2026-02-05';
 current.statementMappings=[{account:'bank',table:'balance',item:'货币资金',amount:'1093',evidence:'银行'},{account:'tax',table:'balance',item:'应交税费',amount:'-13',evidence:'税额'},{account:'equity',table:'balance',item:'实收资本（或股本）',amount:'-1000',evidence:'权益'},{account:'income',table:'balance',item:'未分配利润',amount:'-100',evidence:'损益'},{account:'expense',table:'balance',item:'未分配利润',amount:'20',evidence:'损益'},{account:'income',table:'income',item:'营业收入',amount:'-100',evidence:'收入'},{account:'expense',table:'income',item:'管理费用',amount:'20',evidence:'费用'}];
 const jan=structuredClone(current);jan.vouchers.forEach((v:any)=>v.date=v.date.replace('2026-02','2026-01'));jan.invoices[0].date='2026-01-05';
 let db={query:async(sql:string)=>({rows:sql.includes('s.period=ANY')?[{period:'2026-01',payload:jan}]:[]})};let r=await contextualAccountingReport(db,'fake','2026-02',current);assert.equal(r.statements.income.find((i:any)=>i.item==='营业收入')!.ytd,'200.00');assert.equal(r.statements.cashFlowYtd,null);assert.deepEqual(r.statements.missing,[]);
 db={query:async()=>({rows:[]})};r=await contextualAccountingReport(db,'fake','2026-02',current);assert.equal(r.statements.income.find((i:any)=>i.item==='营业收入')!.ytd,null);assert.ok(r.statements.missing.some((m:string)=>m.includes('2026-01')));
});

test('comparative adjustment keeps approved originals and refuses missing and unbalanced lines',async()=>{
 const x:any=sample();x.reportingBasis='enterprise_2019_new';x.statementMappings=[];
 x.comparativeAdjustments=[
  {group:'A',target:'yearEnd',item:'货币资金',amount:'10',reason:'虚构调整',evidence:'虚构凭证'},
  {group:'A',target:'yearEnd',item:'实收资本（或股本）',amount:'10',reason:'虚构调整',evidence:'虚构凭证'},
  {group:'B',target:'priorPeriod',item:'营业收入',amount:'3',reason:'虚构调整',evidence:'虚构凭证'}
 ];
 const historical={yearEnd:{statementMapping:{status:'已提供',issues:[],balance:[{item:'货币资金',amount:'100'},{item:'实收资本（或股本）',amount:'100'}]}},priorPeriod:{statementMapping:{status:'已提供',issues:[],income:[{item:'营业收入',amount:'50'}]}}};
 const sourceCopy=structuredClone(historical);
 const report:any={issues:[],statementMapping:{balance:[],income:[]},cashFlow:{status:'未编制'}};
 const db={query:async()=>({rows:[]})};
 let result=await statementDraft(db,'fake','2026-01',x,report,historical);
 assert.equal(result.balance.find((r:any)=>r.item==='货币资金')!.yearEnd,'100');assert.equal(result.balance.find((r:any)=>r.item==='货币资金')!.yearEndAdjusted,'110.00');
 assert.equal(result.income.find((r:any)=>r.item==='营业收入')!.priorPeriodAdjusted,'53.00');assert.deepEqual(historical,sourceCopy);assert.deepEqual(report.issues,[]);
 x.comparativeAdjustments[0].amount='9';x.comparativeAdjustments.push({group:'C',target:'priorPeriod',item:'营业成本',amount:'1',reason:'虚构调整',evidence:'虚构凭证'});
 report.issues=[];result=await statementDraft(db,'fake','2026-01',x,report,historical);
 assert.ok(report.issues.some((i:any)=>i.message.includes('不平衡')));assert.ok(report.issues.some((i:any)=>i.message.includes('不能假定原数为零')));
 x.reportingBasis='small_2011';assert.ok(accountingReport(x,'2026-10').issues.some(i=>i.type==='comparative_adjustment'));
});

test('both accounting bases compute totals only after explicit zero confirmation',()=>{
 for(const basis of ['small_2011','enterprise_2019_new']){
  const x:any=sample();x.reportingBasis=basis;x.statementMappings=[
   {account:'bank',table:'balance',item:'货币资金',amount:'1093',evidence:'银行'},
   {account:'tax',table:'balance',item:'应交税费',amount:'-13',evidence:'税费'},
   {account:'equity',table:'balance',item:'实收资本（或股本）',amount:'-1000',evidence:'资本'},
   {account:'income',table:'balance',item:'未分配利润',amount:'-100',evidence:'本期损益'},
   {account:'expense',table:'balance',item:'未分配利润',amount:'20',evidence:'本期损益'},
   {account:'income',table:'income',item:'营业收入',amount:'-100',evidence:'收入'},
   {account:'expense',table:'income',item:'管理费用',amount:'20',evidence:'费用'}];
  const catalog=statementCatalog(basis)!;
  x.statementZeros=[...['assets','liabilities','equity'].flatMap(group=>(catalog as any)[group].map((item:string)=>({table:'balance',item,evidence:'虚构账簿'}))),...['gains','costs'].flatMap(group=>(catalog as any)[group].map((item:string)=>({table:'income',item,evidence:'虚构账簿'})))].filter(z=>!x.statementMappings.some((m:any)=>m.table===z.table&&m.item===z.item));
  let report:any=accountingReport(x,'2026-10');assert.deepEqual(report.issues,[]);
  const total=(item:string)=>report.statementTotals.rows.find((r:any)=>r.item===item).amount;
  assert.equal(total('资产总计'),'1093.00');assert.equal(total('负债合计'),'13.00');assert.equal(total('所有者权益合计'),'1080.00');assert.equal(total('净利润'),'80.00');
  x.statementZeros=x.statementZeros.filter((z:any)=>z.item!=='短期借款');
  report=accountingReport(x,'2026-10');assert.equal(report.statementTotals.rows.find((r:any)=>r.item==='负债合计').amount,null);
  x.statementZeros.push({table:'balance',item:'货币资金',evidence:'虚构依据'});
  report=accountingReport(x,'2026-10');assert.ok(report.issues.some((i:any)=>i.type==='statement_zero'));
 }
});
