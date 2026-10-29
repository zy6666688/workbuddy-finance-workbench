import ExcelJS from "exceljs";
import AdmZip from "adm-zip";
import { fail } from "./core.js";
import { accountingInput } from "./accounting.js";
import { statementCatalog } from "./statement-mapping.js";
import { cashflowCatalog } from "./cashflow-catalog.js";
import { disclosureTopics } from "./disclosure-review.js";

const sheets = {
 "科目": ["科目编号","科目名称","分类","期初借方减贷方"],
 "凭证": ["凭证编号","日期","科目编号","借方","贷方","摘要","是否损益结转"],
 "发票": ["发票编号","日期","方向","不含税金额","税额","价税合计","凭证编号","收入或成本科目","税额科目","蓝红字","原蓝字期间","原蓝字编号","原蓝字底稿编号"],
 "银行关联": ["银行流水导入编号","银行科目编号（逗号分隔）"],
 "期间衔接": ["上期已复核底稿编号"],
 "比较信息": ["上年末底稿编号","上年同月底稿编号"],
 "比较调整": ["调整组","比较期","项目名称","调整金额（按报表列示方向）","原因","依据"],
 "科目重分类": ["原科目编号","目标类别","期末借减贷金额","明细及依据"],
 "往来科目": ["科目编号","往来科目类型"],
 "往来明细": ["科目编号","往来单位","明细或合同编号","期末借减贷金额","拟列报项目","明细依据"],
 "附注底稿": ["披露事项","说明","证据或依据"],
 "附注核对": ["主题","状态","说明","依据"],
 "报表口径": ["适用口径"],
 "报表映射": ["科目编号","报表类型","项目名称","借减贷金额","明细依据"],
 "报表零项确认": ["报表类型","项目名称","确认依据"],
 "现金范围": ["现金及现金等价物科目编号"],
 "现金流分类": ["凭证编号","凭证分录行号","分类","金额（流入正、流出负）","现金流项目"],
 "权益变动": ["科目编号","变动类型","金额（增加为正）","依据"],
};
export async function accountingTemplate() {
 const book=new ExcelJS.Workbook();
 for(const [name,headers] of Object.entries(sheets)){const sheet=book.addWorksheet(name);sheet.addRow(headers);sheet.columns.forEach(c=>c.width=22);sheet.getRow(1).font={bold:true};}
 const note=book.addWorksheet("填写说明");
 const catalogSheet=book.addWorksheet("报表项目");catalogSheet.addRow(["适用口径","报表类型","项目类别","项目名称"]);
 for(const basis of ['small_2011','enterprise_2019_new']){const catalog=statementCatalog(basis)!;for(const [group,values] of Object.entries(catalog))for(const item of values)catalogSheet.addRow([basis,['assets','liabilities','equity'].includes(group)?'balance':'income',group,item]);}catalogSheet.columns.forEach(c=>c.width=24);
 const cashItems=book.addWorksheet("现金流项目");cashItems.addRow(["适用口径","分类","项目名称"]);
 for(const basis of ['small_2011','enterprise_2019_new'])for(const [category,items] of Object.entries(cashflowCatalog(basis)))for(const item of items)cashItems.addRow([basis,category,item]);cashItems.columns.forEach(c=>c.width=35);
 const disclosureList=book.addWorksheet("附注主题");disclosureList.addRow(["适用口径","主题"]);
 for(const basis of ['small_2011','enterprise_2019_new'])for(const topic of disclosureTopics(basis))disclosureList.addRow([basis,topic]);disclosureList.columns.forEach(c=>c.width=38);
 for(const row of ["本表是内部核对底稿，不自动记账、验真或申报。", "科目分类填写 asset（资产）、liability（负债）、equity（权益）、revenue（收入）或 expense（费用），只填写括号前的英文。", "期初借方余额填正数，贷方余额填负数；损益科目期初应为零。", "日期使用 YYYY-MM-DD；金额最多两位小数。凭证每行一条分录，同一凭证的日期及损益结转标记须一致；结转填是，其他填否。", "发票方向填写 sale（销项）或 purchase（进项），只填写括号前的英文；凭证编号和科目必须由经办人员明确填写。", "蓝红字填 blue 或 red；红字金额填负数，明确填写原蓝字期间和编号；跨期红字还须填写原蓝字已复核底稿编号。", "期间衔接填写本客户上期已复核底稿编号；在上期底稿的历史版本中查找。", "可在银行关联页填写本客户本期已确认的银行流水导入编号和对应科目。流水须覆盖这些科目的全部账户；不填写则不核对银行。", "核对结果只比较明确关联的凭证和发票，零差异不代表资料完整或合规。"] ) note.addRow([row]);
 note.getColumn(1).width=110;
 note.addRow(["现金范围与现金流分类由会计确认；分录行号从同一凭证第一条分录开始计数。分类填 operating_in、operating_out、investing_in、investing_out、financing_in、financing_out、exchange 或 internal。金额为现金科目的借方减贷方。内部调拨须在同一凭证流入流出抵消。"]);
 note.addRow(["现金流项目参照现金流项目页，按适用准则与分类填写；缺失项目不会自动视为零。内部调拨不填项目。"]);
 note.addRow(["权益变动由会计按权益科目填写；增加为正、减少为负。类型填 profit、capital、distribution、reserve、other_comprehensive 或 other，并填写依据；逐科目合计与账簿期初期末变动核对。此页不是正式权益变动表。"]);
 note.addRow(["科目重分类由会计根据明细填写目标类别 asset、liability 或 equity，金额为借方减贷方并填写明细依据；同一科目的分类金额合计必须等于账簿期末余额。"]);
 note.addRow(["往来科目类型填写 receivable、prepayment、payable、advance 或 contract。往来明细填写单位、明细或合同编号及借减贷金额，由会计指定拟列报项目并提供依据；不得仅按净余额猜测。"]);
 note.addRow(["拟列报项目填写 receivable（应收）、prepayment（预付）、payable（应付）、advance（预收）、contract_asset（合同资产）、contract_liability（合同负债）、other_noncurrent_asset 或 other_noncurrent_liability，只填括号前英文。非流动项目和合同项目须由会计判断。"]);
 note.addRow(["比较信息填写上年末和上年同月已独立复核底稿编号；未提供的数据不按零填列。历史口径调整仍需人工处理。"]);
 note.addRow(["比较调整仅为一般企业人工核对底稿，比较期填 yearEnd（上年末资产负债项目）或 priorPeriod（上年同期利润项目），金额以报表列示增加为正；须填写调整组、原因和依据。系统保留原数，不修改历史底稿。平衡检查不能证明追溯处理完整或适用。"]);
 note.addRow(["附注底稿由经办填写披露事项、说明和证据；系统不会自动判断披露完整性或代替独立复核。"]);
 note.addRow(["附注核对参照附注主题页，由会计填写状态 provided（已填写）、not_applicable（不适用）或 pending（待处理）。已填写或不适用均须提供说明和依据。清单仅为提示，不能证明附注完整。"]);
 note.addRow(["报表口径可填写 small_2011（小企业）或 enterprise_2019_new（2019一般企业且已执行新金融、新收入、新租赁准则）；适用性由会计确认。当前尚不生成正式报表。"]);
 note.addRow(["报表映射请参照报表项目工作表。balance 表示资产负债项目，income 表示利润项目；金额均按借方减贷方，逐科目合计须与余额或未结转本期发生额一致。仅供核对，不是正式报表。"]);
 note.addRow(["没有账簿映射、经会计确认本期不存在的报表项目，可在报表零项确认页填写报表类型、项目名称和依据；系统不把未填写的项目视为零。汇总仅供核对，不能替代正式报表。"]);
 return Buffer.from(await book.xlsx.writeBuffer());
}
export async function accountingExport(raw:unknown,report:any){
 const input=accountingInput.parse(raw),book=new ExcelJS.Workbook();
 await book.xlsx.load(await accountingTemplate() as any);
 for(const a of input.accounts)book.getWorksheet("科目")!.addRow([a.code,a.name,a.category,a.opening]);
 for(const v of input.vouchers)for(const l of v.lines)book.getWorksheet("凭证")!.addRow([v.number,v.date,l.account,l.debit,l.credit,l.description,v.closing?"是":"否"]);
 for(const i of input.invoices)book.getWorksheet("发票")!.addRow([i.number,i.date,i.kind,i.net,i.tax,i.gross,i.voucher,i.account,i.taxAccount,i.color,i.originalPeriod,i.originalNumber,i.originalSnapshotId]);
 if(input.bankImportId)book.getWorksheet("银行关联")!.addRow([input.bankImportId,input.bankAccounts.join(",")]);
 if(input.previousSnapshotId)book.getWorksheet("期间衔接")!.addRow([input.previousSnapshotId]);
 if(input.comparative)book.getWorksheet("比较信息")!.addRow([input.comparative.yearEndSnapshotId,input.comparative.priorPeriodSnapshotId]);
 for(const a of input.comparativeAdjustments||[])book.getWorksheet("比较调整")!.addRow([a.group,a.target,a.item,a.amount,a.reason,a.evidence]);
 for(const a of input.reclassification||[])book.getWorksheet("科目重分类")!.addRow([a.account,a.target,a.amount,a.evidence]);
 for(const a of input.counterparties?.accounts||[])book.getWorksheet("往来科目")!.addRow([a.account,a.kind]);
 for(const a of input.counterparties?.rows||[])book.getWorksheet("往来明细")!.addRow([a.account,a.party,a.detail,a.amount,a.target,a.evidence]);
 for(const a of input.disclosures||[])book.getWorksheet("附注底稿")!.addRow([a.title,a.content,a.evidence]);
 for(const a of input.disclosureReview||[])book.getWorksheet("附注核对")!.addRow([a.topic,a.status,a.content,a.evidence]);
 if(input.reportingBasis)book.getWorksheet("报表口径")!.addRow([input.reportingBasis]);
 for(const a of input.statementMappings||[])book.getWorksheet("报表映射")!.addRow([a.account,a.table,a.item,a.amount,a.evidence]);
 for(const a of input.statementZeros||[])book.getWorksheet("报表零项确认")!.addRow([a.table,a.item,a.evidence]);
 for(const a of input.cashFlow?.accounts||[])book.getWorksheet("现金范围")!.addRow([a]);
 for(const a of input.cashFlow?.allocations||[])book.getWorksheet("现金流分类")!.addRow([a.voucher,a.line,a.category,a.amount,a.item]);
 for(const a of input.equityMovement||[])book.getWorksheet("权益变动")!.addRow([a.account,a.category,a.amount,a.evidence]);
 const result=book.addWorksheet("核对结果");result.addRow(["内部核对底稿，需独立复核；不代表正式报表或发票验真"]);
 for(const [label,value] of Object.entries(report.summary))result.addRow([label,String(value)]);
 result.addRow(["银行核对",report.bank.status]);for(const i of report.issues)result.addRow([i.type,i.reference,i.message]);
 if(report.comparative)for(const [key,value] of Object.entries(report.comparative))result.addRow([`比较底稿 ${key}`,(value as any).status,(value as any).period||""]);
 if(report.reclassification)for(const [key,value] of Object.entries(report.reclassification))result.addRow([`重分类 ${key}`,String(value)]);
 if(report.counterparties?.items)for(const [key,value] of Object.entries(report.counterparties.items))result.addRow([`往来项目 ${key}`,String(value)]);
 if(report.statementMapping)for(const table of ['balance','income'])for(const row of report.statementMapping[table]||[])result.addRow([`报表项目 ${table}`,row.item,row.amount]);
 if(report.statementTotals?.rows?.length){const totals=book.addWorksheet('报表汇总底稿');totals.addRow(['项目','金额']);for(const row of report.statementTotals.rows)totals.addRow([row.item,row.amount??'待补']);for(const missing of report.statementTotals.missing)totals.addRow(['待补',missing]);totals.columns.forEach(c=>c.width=30)}
 if(report.statements?.status==='映射核对底稿，尚非正式报表'){
  const draft=book.addWorksheet('项目比较底稿');draft.addRow(['项目','本期','比较原数','比较调整后','本年累计']);
  for(const row of report.statements.balance)draft.addRow([row.item,row.current??'未提供',row.yearEnd??'未提供',row.yearEndAdjusted??'未提供','']);
  for(const row of report.statements.income)draft.addRow([row.item,row.current??'未提供',row.priorPeriod??'未提供',row.priorPeriodAdjusted??'未提供',row.ytd??'待补']);
  for(const missing of report.statements.missing)draft.addRow(['待补',missing]);
  draft.columns=[{width:30},{width:20},{width:20},{width:20},{width:20}];
 }
 if(report.cashFlow&&report.cashFlow.status!=='未编制'){for(const [label,value] of Object.entries(report.cashFlow))if(label!=='items')result.addRow([`现金流 ${label}`,String(value)]);for(const row of report.cashFlow.items||[])result.addRow([`现金流 ${row.category}`,row.item,row.amount]);}
 if(report.cashFlowStatement?.status==='现金流明细核对底稿，待复核'){
  const cash=book.addWorksheet('现金流比较底稿');cash.addRow(['分类','项目','本月','本年累计','上年同月','上年同期累计']);
  for(const row of report.cashFlowStatement.items)cash.addRow([row.category,row.item,row.current??'待补',row.ytd??'待补',row.priorPeriod??'待补',row.priorYtd??'待补']);
  for(const missing of report.cashFlowStatement.missing)cash.addRow(['待补',missing]);cash.columns.forEach(c=>c.width=25);
 }
 if(report.equityMovement?.status!=='未编制')for(const row of report.equityMovement?.rows||[])result.addRow(['权益变动',row.account,`期初 ${row.opening}；变动 ${row.movement}；期末 ${row.closing}`]);
 if(report.equityStatement?.status==='权益变动矩阵底稿，待复核'){
  const equity=book.addWorksheet('权益变动矩阵底稿');equity.addRow(['变动类型',...report.equityStatement.columns]);
  for(const row of report.equityStatement.rows)equity.addRow([row.row,...report.equityStatement.columns.map((col:string)=>row.values[col])]);
  equity.columns.forEach(c=>c.width=24);
 }
 if(report.disclosuresCheck?.rows?.length){const check=book.addWorksheet('附注核对结果');check.addRow(['主题','状态','说明','依据']);for(const row of report.disclosuresCheck.rows)check.addRow([row.topic,row.status,row.content,row.evidence]);check.columns.forEach(c=>c.width=30)}
 result.columns=[{width:24},{width:30},{width:75}];
 return Buffer.from(await book.xlsx.writeBuffer());
}
export async function readAccountingWorkbook(bytes:Buffer,name:string){
 if(!name.toLowerCase().endsWith(".xlsx")) fail(400,"请使用标准 XLSX 底稿");
 if(bytes.length>10*1024*1024)fail(413,"表格不得超过10MB");
 let zip:AdmZip;try{zip=new AdmZip(bytes)}catch{fail(400,"表格格式无效")}
 const entries=zip.getEntries();if(entries.length>1000||entries.reduce((n,e)=>n+e.header.size,0)>50*1024*1024)fail(413,"表格解压体积过大");
 if(entries.some(e=>/vbaProject|externalLinks/i.test(e.entryName)))fail(400,"不接受宏或外部链接表格");
 const book=new ExcelJS.Workbook();try{await book.xlsx.load(bytes as any)}catch{fail(400,"无法读取 XLSX 表格")}
 function rows(name:keyof typeof sheets){
  const sheet=book.getWorksheet(name);if(!sheet&&["期间衔接","比较信息","比较调整","科目重分类","往来科目","往来明细","附注底稿","附注核对","报表口径","报表映射","报表零项确认","现金范围","现金流分类","权益变动"].includes(name))return [];if(!sheet)fail(400,`缺少 ${name} 工作表`);
  if(sheet.rowCount>10001||sheet.columnCount>100)fail(413,`${name} 工作表超出行列限制`);
  const headers=sheets[name];
  if(headers.some((h,i)=>{const actual=sheet.getRow(1).getCell(i+1).text.trim();return ((name==="发票"&&i>=9)||(name==="凭证"&&i===6)||(name==="现金流分类"&&i===4))&&!actual?false:actual!==h}))fail(400,`${name} 工作表列名与模板不一致`);
  const result:string[][]=[];
  sheet.eachRow((row,i)=>{if(i===1)return;const cells=headers.map((_,j)=>{
   const c=row.getCell(j+1);if(c.type===ExcelJS.ValueType.Formula)fail(400,`${name} 第 ${i} 行包含公式，请先转换为数值`);
   return c.value instanceof Date?c.value.toISOString().slice(0,10):c.text.trim();
  });if(cells.some(Boolean))result.push(cells)});
  return result;
 }
 const accounts=rows("科目").map(([code,name,category,opening])=>({code,name,category,opening}));
 const byNumber=new Map<string,{number:string;date:string;closing:boolean;lines:any[]}>();
 for(const [number,date,account,debit,credit,description,closingText] of rows("凭证")){
  if(closingText&&!['是','否'].includes(closingText))fail(400,`凭证 ${number} 是否损益结转应填写是或否`);
  const closing=closingText==='是';const voucher=byNumber.get(number)||{number,date,closing,lines:[]};
  if(voucher.date!==date||voucher.closing!==closing)fail(400,`凭证 ${number} 的日期或结转标记不一致`);
  voucher.lines.push({account,debit,credit,description});byNumber.set(number,voucher);
 }
 const invoices=rows("发票").map(([number,date,kind,net,tax,gross,voucher,account,taxAccount,color,originalPeriod,originalNumber,originalSnapshotId])=>({number,date,kind,net,tax,gross,voucher,account,taxAccount,color:color||"blue",originalPeriod,originalNumber,originalSnapshotId}));
 const links=rows("银行关联");if(links.length>1)fail(400,"银行关联仅支持一条，流水应覆盖所列科目及本期全部账户");
 const [bankImportId="",bankCodes=""]=links[0]||[];
 const previous=rows("期间衔接");if(previous.length>1)fail(400,"期间衔接仅允许一条上期底稿编号");
 const comparison=rows("比较信息");if(comparison.length>1)fail(400,"比较信息仅允许一条");
 const comparative=comparison.length?{yearEndSnapshotId:comparison[0][0],priorPeriodSnapshotId:comparison[0][1]}:null;
 const adjustmentRows=rows("比较调整"),comparativeAdjustments=adjustmentRows.length?adjustmentRows.map(([group,target,item,amount,reason,evidence])=>({group,target,item,amount,reason,evidence})):null;
 const reclassRows=rows("科目重分类"),reclassification=reclassRows.length?reclassRows.map(([account,target,amount,evidence])=>({account,target,amount,evidence})):null;
 const cpAccounts=rows("往来科目").map(([account,kind])=>({account,kind})),cpRows=rows("往来明细").map(([account,party,detail,amount,target,evidence])=>({account,party,detail,amount,target,evidence}));
 const counterparties=cpAccounts.length||cpRows.length?{accounts:cpAccounts,rows:cpRows}:null;
 const disclosureRows=rows("附注底稿"),disclosures=disclosureRows.length?disclosureRows.map(([title,content,evidence])=>({title,content,evidence})):null;
 const disclosureReviewRows=rows("附注核对"),disclosureReview=disclosureReviewRows.length?disclosureReviewRows.map(([topic,status,content,evidence])=>({topic,status,content,evidence})):null;
 const basisRows=rows("报表口径");if(basisRows.length>1)fail(400,"报表口径仅允许一条");const reportingBasis=basisRows[0]?.[0]||null;
 const mappingRows=rows("报表映射"),statementMappings=mappingRows.length?mappingRows.map(([account,table,item,amount,evidence])=>({account,table,item,amount,evidence})):null;
 const zeroRows=rows("报表零项确认"),statementZeros=zeroRows.length?zeroRows.map(([table,item,evidence])=>({table,item,evidence})):null;
 const cashAccounts=rows("现金范围").map(([code])=>code),cashAllocations=rows("现金流分类").map(([voucher,line,category,amount,item])=>({voucher,line:Number(line),category,amount,item}));
 const cashFlow=cashAccounts.length||cashAllocations.length?{accounts:cashAccounts,allocations:cashAllocations}:null;
 const equityRows=rows("权益变动"),equityMovement=equityRows.length?equityRows.map(([account,category,amount,evidence])=>({account,category,amount,evidence})):null;
 return accountingInput.parse({accounts,vouchers:[...byNumber.values()],invoices,cashFlow,equityMovement,comparative,comparativeAdjustments,reclassification,counterparties,disclosures,disclosureReview,reportingBasis,statementMappings,statementZeros,previousSnapshotId:previous[0]?.[0]||"",bankImportId,bankAccounts:bankCodes?bankCodes.split(/[,，]/).map(x=>x.trim()):[]});
}
