import { test } from "node:test";
import assert from "node:assert/strict";
import { accountingReport } from "../src/accounting.js";
import { accountingExport,readAccountingWorkbook } from "../src/accounting-workbook.js";
const base=()=>({accounts:[
 {code:"1001",name:"银行存款",category:"asset",opening:"1000.00"},
 {code:"2001",name:"税款",category:"liability",opening:"0.00"},
 {code:"3001",name:"实收资本",category:"equity",opening:"-1000.00"},
 {code:"4001",name:"收入",category:"revenue",opening:"0.00"},
 {code:"5001",name:"费用",category:"expense",opening:"0.00"}],
 vouchers:[{number:"V1",date:"2026-10-05",lines:[{account:"1001",debit:"113.00",credit:"0"},{account:"4001",debit:"0",credit:"100.00"},{account:"2001",debit:"0",credit:"13.00"}]},{number:"V2",date:"2026-10-06",lines:[{account:"5001",debit:"20.00",credit:"0"},{account:"1001",debit:"0",credit:"20.00"}]}],
 invoices:[{number:"I1",date:"2026-10-05",kind:"sale",net:"100.00",tax:"13.00",gross:"113.00",voucher:"V1",account:"4001",taxAccount:"2001"}]});
test("synthetic account, vouchers and invoice reconcile with derived trial balance",()=>{
 const r=accountingReport(base(),"2026-10");assert.deepEqual(r.issues,[]);assert.deepEqual(r.summary,{assets:"1093.00",liabilities:"13.00",equity:"1000.00",revenue:"100.00",expenses:"20.00",profit:"80.00",balanceDifference:"0.00"});
});
test("detects unbalanced vouchers, invoice mismatches, dates and duplicate records",()=>{
 const x=base();x.invoices[0].gross="112.00";x.invoices[0].net="99.00";x.vouchers[1].lines[0].debit="21.00";x.vouchers[0].date="2026-09-30";x.invoices.push({...x.invoices[0]});
 const issues=accountingReport(x,"2026-10").issues;for(const t of ["period","voucher","invoice","invoice_voucher","balance"])assert.ok(issues.some(i=>i.type===t),t);
});
test("rejects invalid amounts and marks unknown account and missing voucher",()=>{
 const x=base();x.invoices[0].voucher="none";x.vouchers[0].lines[0].account="missing";
 assert.ok(accountingReport(x,"2026-10").issues.some(i=>i.message.includes("不存在")));
 x.invoices[0].net="1e3";assert.throws(()=>accountingReport(x,"2026-10"));
});
test("cash-flow items follow the chosen basis and round-trip through workbook",async()=>{
 for(const [basis,inItem,outItem] of [
  ["small_2011","销售产成品、商品、提供劳务收到的现金","支付的职工薪酬"],
  ["enterprise_2019_new","销售商品、提供劳务收到的现金","支付给职工以及为职工支付的现金"]
 ]){
  const x:any=base();x.reportingBasis=basis;
  x.cashFlow={accounts:["1001"],allocations:[
   {voucher:"V1",line:1,category:"operating_in",amount:"113",item:inItem},
   {voucher:"V2",line:2,category:"operating_out",amount:"-20",item:outItem}
  ]};
  x.equityMovement=[{account:"3001",category:"capital",amount:"0",evidence:"虚构数据"}];
  const report:any=accountingReport(x,"2026-10");assert.deepEqual(report.issues,[]);
  assert.equal(report.cashFlow.missingItems,0);assert.equal(report.cashFlow.items[1].amount,"20.00");
  const restored=await readAccountingWorkbook(await accountingExport(x,{...report,bank:{status:"未编制"}}),"example.xlsx");
  assert.deepEqual(restored.cashFlow?.allocations.map(a=>a.item),[inItem,outItem]);assert.equal(restored.equityMovement?.[0].evidence,"虚构数据");
  x.cashFlow.allocations[0].item=outItem;assert.ok(accountingReport(x,"2026-10").issues.some(i=>i.type==="cashflow"&&i.message.includes("不匹配")));
  x.cashFlow.allocations[0].item="";assert.equal(accountingReport(x,"2026-10").cashFlow.missingItems,1);
 }
});
test("equity changes reconcile per account and reject non-equity classifications",()=>{
 const x:any=base();x.equityMovement=[{account:"3001",category:"capital",amount:"1",evidence:"虚构依据"}];
 assert.ok(accountingReport(x,"2026-10").issues.some(i=>i.type==="equity"&&i.message.includes("不一致")));
 x.equityMovement=[{account:"1001",category:"other",amount:"0",evidence:"虚构依据"}];
 assert.ok(accountingReport(x,"2026-10").issues.some(i=>i.type==="equity"&&i.message.includes("不是权益类")));
});
test("comparative adjustments survive workbook round trip with reason and evidence",async()=>{
 const x:any=base();x.reportingBasis='enterprise_2019_new';
 x.comparativeAdjustments=[{group:'A',target:'yearEnd',item:'货币资金',amount:'10',reason:'虚构差错',evidence:'虚构凭证'}];
 const report:any=accountingReport(x,'2026-10');
 const restored=await readAccountingWorkbook(await accountingExport(x,{...report,bank:{status:'未编制'}}),'example.xlsx');
 assert.deepEqual(restored.comparativeAdjustments,x.comparativeAdjustments);
});
test("disclosure checklist tracks unanswered items and requires support for exceptions",async()=>{
 const x:any=base();x.reportingBasis='small_2011';
 x.disclosureReview=[{topic:'利润分配说明',status:'not_applicable',content:'虚构客户本期无分配',evidence:'虚构决议'}];
 let report:any=accountingReport(x,'2026-10');assert.equal(report.disclosuresCheck.pending,7);assert.deepEqual(report.issues,[]);
 const restored=await readAccountingWorkbook(await accountingExport(x,{...report,bank:{status:'未编制'}}),'example.xlsx');
 assert.deepEqual(restored.disclosureReview,x.disclosureReview);
 x.disclosureReview[0].evidence='';report=accountingReport(x,'2026-10');assert.ok(report.issues.some((i:any)=>i.type==='disclosure'));
 x.disclosureReview[0].evidence='虚构决议';x.disclosureReview.push({...x.disclosureReview[0]});report=accountingReport(x,'2026-10');
 assert.ok(report.issues.some((i:any)=>i.message.includes('重复')));
 x.reportingBasis='enterprise_2019_new';report=accountingReport(x,'2026-10');assert.ok(report.issues.some((i:any)=>i.message.includes('不属于')));
});
test("statement zero confirmations preserve evidence in workbook",async()=>{
 const x:any=base();x.reportingBasis='small_2011';x.statementZeros=[{table:'balance',item:'短期投资',evidence:'虚构账簿'}];
 const report:any=accountingReport(x,'2026-10');
 const restored=await readAccountingWorkbook(await accountingExport(x,{...report,bank:{status:'未编制'}}),'example.xlsx');
 assert.deepEqual(restored.statementZeros,x.statementZeros);
});
