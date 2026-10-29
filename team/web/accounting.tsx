import { useEffect, useRef, useState } from "preact/hooks";

export function AccountingWorkspace({api,companyId,period,canWrite}:any){
 const [saved,setSaved]=useState<any>(null),[history,setHistory]=useState<any[]>([]),[candidate,setCandidate]=useState<any>(null),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const file=useRef<HTMLInputElement>(null);
 const url=`/companies/${companyId}/accounting/${period}`;
 useEffect(()=>{let active=true;setSaved(null);setHistory([]);setCandidate(null);setMessage("");if(companyId) Promise.all([api(url),api(url+"/history")]).then(([x,h]:any)=>{if(active){setSaved(x);setHistory(h)}}).catch((e:any)=>{if(active)setMessage(e.message)});return()=>{active=false}},[companyId,period]);
 const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage("");try{await fn()}catch(e:any){setMessage(e.message)}finally{setBusy(false)}};
 if(!companyId)return <section className="panel"><h1>财务核对底稿</h1><p>请先在顶部选择客户公司和会计期间。</p></section>;
 const report=candidate?.report||saved?.report;
 const data=candidate?.payload||saved?.payload;
 return <div>
  <h1>财务核对底稿</h1><p>按当前客户和期间核对科目、凭证、发票及汇总关系。所有关联由经办明确填写，结果需人工复核。</p>
  {message&&<p role="alert">{message}</p>}
  <section className="panel"><header><h2>1. 准备底稿</h2><p>下载表格，按“填写说明”完成科目、凭证和发票；银行关联按需填写。上传先预览，再由经办确认保存。</p></header>
   <a href="/api/v1/accounting/template">下载 Excel 底稿模板</a>
   {canWrite&&<form onSubmit={e=>{e.preventDefault();void perform(async()=>{if(!file.current?.files?.[0])throw new Error("请先选择底稿");const form=new FormData();form.set("file",file.current.files[0]);setCandidate(await api(url+"/preview-file",form));setMessage("预览完成，尚未保存")})}}>
    <label>选择填写好的 Excel 文件<input ref={file} type="file" accept=".xlsx" required /></label><button disabled={busy||!saved}>预览核对结果</button>
   </form>}
   <p>已保存版本：{saved?.version||"暂无"}。每次保存保留旧版本；送审或归档后需要退回或重开才能修改。</p>
   {canWrite&&saved?.version>0&&<a href={`/api/v1${url}/export`}>下载已保存底稿与核对结果</a>}
   {history.length>0&&<details><summary>查看历史版本（最近 100 版）</summary><p>下载时会重新核对该版数据；送审记录保留当时固定的版本和汇总。跨期红字或期初衔接须填写对应底稿编号。</p><ul>{history.map((h:any)=><li>版本 {h.version} · {new Date(h.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 编号 {h.id} {canWrite&&<a href={`/api/v1${url}/export?version=${h.version}`}>下载该版本</a>}</li>)}</ul></details>}
  </section>
  {report&&<section className="panel"><header><h2>2. 核对结果 {candidate?"（预览，未保存）":"（已保存底稿）"}</h2><p>{report.limits}</p></header>
   <p><strong>{report.issues.length?`${report.issues.length} 项待处理`:'未发现所列规则差异'}</strong> · 未发现差异不等于发票已验真、资料完整或报表已复核。</p>
   <p>报表口径：{data.reportingBasis==='small_2011'?'小企业会计准则':data.reportingBasis==='enterprise_2019_new'?'一般企业 2019 格式（已执行三项新准则）':'未选择'}。适用范围须由会计确认；当前尚不能生成正式报表。</p>
   <p>逐项映射：{report.statementMapping?.status || '未提供'}。项目对应由经办填写，比较数、报表合计和披露尚需完整核对。</p>
   {report.statementMapping?.balance?.length>0&&<details><summary>查看资产负债项目映射底稿</summary><ul>{report.statementMapping.balance.map((row:any)=><li>{row.item}：{row.amount} 元</li>)}</ul></details>}
   {report.statementMapping?.income?.length>0&&<details><summary>查看利润项目映射底稿</summary><ul>{report.statementMapping.income.map((row:any)=><li>{row.item}：{row.amount} 元</li>)}</ul></details>}
   {report.statements?.status!=='未提供映射'&&report.statements&&<details><summary>查看项目比较与本年累计底稿</summary><p>{report.statements.limitations}</p>{report.statements.missing.length>0&&<p>累计数待补：{report.statements.missing.join('；')}</p>}<div className="accounting-table"><table><thead><tr><th>资产负债项目</th><th>本期末</th><th>上年末</th></tr></thead><tbody>{report.statements.balance.map((r:any)=><tr><td>{r.item}</td><td>{r.current??'未提供'}</td><td>{r.yearEnd??'未提供'}</td></tr>)}</tbody></table><table><thead><tr><th>利润项目</th><th>本月</th><th>上年同月</th><th>本年累计</th></tr></thead><tbody>{report.statements.income.map((r:any)=><tr><td>{r.item}</td><td>{r.current??'未提供'}</td><td>{r.priorPeriod??'未提供'}</td><td>{r.ytd??'待补'}</td></tr>)}</tbody></table></div>{report.statements.cashFlowYtd&&<p>本年累计现金流净额：{report.statements.cashFlowYtd.classifiedNet} 元（分类与现金范围仍需复核）。</p>}</details>}
   <div className="accounting-metrics">{[["资产",report.summary.assets],["负债",report.summary.liabilities],["权益",report.summary.equity],["收入",report.summary.revenue],["费用",report.summary.expenses],["损益",report.summary.profit],["平衡差额",report.summary.balanceDifference]].map(([label,value])=><div><span>{label}</span><strong>{value} 元</strong></div>)}</div>
   <p>银行核对：{report.bank.status}{report.bank.status==="已比较" && `；流水 ${report.bank.total} 元，凭证净发生 ${report.bank.movement} 元，差额 ${report.bank.difference} 元`}。流水须覆盖所选科目的全部银行账户。</p>
   <p>期间衔接：{report.previous?.status || '未关联上期'}{report.previous?.period && `（${report.previous.period}，版本 ${report.previous.version}）`}。未关联时无法确认上期期末与本期期初是否一致。</p>
   <p>科目重分类：{report.reclassification?.status || '未提供'}{report.reclassification?.status==='已提供，待复核'&&`；资产 ${report.reclassification.assets} 元、负债 ${report.reclassification.liabilities} 元、权益 ${report.reclassification.equity} 元、平衡差额 ${report.reclassification.balanceDifference} 元`}。分类依据须由会计确认。</p>
   <p>往来明细：{report.counterparties?.status || '未提供'}{report.counterparties?.rows!==undefined&&`；${report.counterparties.rows} 条`}。明细合计需与科目余额及重分类一致，拟列报项目由会计确认。</p>
   {report.counterparties?.items&&<details><summary>查看往来拟列报金额</summary><ul>{Object.entries(report.counterparties.items).map(([item,value]:[string,any])=><li>{({receivable:'应收账款',prepayment:'预付账款',payable:'应付账款',advance:'预收账款',contract_asset:'合同资产',contract_liability:'合同负债',other_noncurrent_asset:'其他非流动资产',other_noncurrent_liability:'其他非流动负债'} as any)[item]||item}：{value} 元</li>)}</ul></details>}
   <p>现金流核对：{report.cashFlow?.status || '未编制'}{report.cashFlow?.status==='已分类，待复核'&&`；经营 ${report.cashFlow.operating} 元，投资 ${report.cashFlow.investing} 元，筹资 ${report.cashFlow.financing} 元；期初 ${report.cashFlow.opening} 元，期末 ${report.cashFlow.closing} 元`}。现金范围和每条分类由经办确认，并需独立复核。</p>
   <p>历史比较底稿：上年末 {report.comparative?.yearEnd?.status || '未提供'}{report.comparative?.yearEnd?.summary&&`（${report.comparative.yearEnd.period}，资产 ${report.comparative.yearEnd.summary.assets} 元）`}；上年同月 {report.comparative?.priorPeriod?.status || '未提供'}{report.comparative?.priorPeriod?.summary&&`（${report.comparative.priorPeriod.period}，收入 ${report.comparative.priorPeriod.summary.revenue} 元）`}。缺失的比较数不按零处理，历史底稿仍需核对会计口径。</p>
   <details><summary>附注底稿（{data.disclosures?.length||0} 项，需人工复核完整性）</summary>{(data.disclosures||[]).map((d:any)=><p><strong>{d.title}：</strong>{d.content}；依据：{d.evidence}</p>)}</details>
   <p>经营快照对照（需先确认口径一致）：{report.snapshotComparison.income?`收入手工 ${report.snapshotComparison.income.manual} 元、底稿 ${report.snapshotComparison.income.book} 元、差额 ${report.snapshotComparison.income.difference} 元`:'收入未录入'}；{report.snapshotComparison.expense?`支出手工 ${report.snapshotComparison.expense.manual} 元、底稿 ${report.snapshotComparison.expense.book} 元、差额 ${report.snapshotComparison.expense.difference} 元`:'支出未录入'}。现金支出与会计费用不一定可直接比较。</p>
   {report.issues.length>0&&<div><h3>待处理事项</h3><ul>{report.issues.map((x:any)=><li>{x.reference}：{x.message}</li>)}</ul></div>}
   <details><summary>查看科目余额明细</summary><div className="accounting-table"><table><thead><tr><th>编号</th><th>科目</th><th>期初借减贷</th><th>本期借减贷</th><th>期末借减贷</th></tr></thead><tbody>{report.trial.map((a:any)=><tr><td>{a.code}</td><td>{a.name}</td><td>{a.opening}</td><td>{a.movement}</td><td>{a.closing}</td></tr>)}</tbody></table></div></details>
   <details><summary>查看凭证明细（共 {data.vouchers.length} 张，显示前 100 张）</summary><div className="accounting-table"><table><thead><tr><th>凭证</th><th>日期</th><th>科目</th><th>借方</th><th>贷方</th></tr></thead><tbody>{data.vouchers.slice(0,100).flatMap((v:any)=>v.lines.map((l:any)=><tr><td>{v.number}</td><td>{v.date}</td><td>{l.account}</td><td>{l.debit}</td><td>{l.credit}</td></tr>))}</tbody></table></div></details>
   <details><summary>查看发票明细（共 {data.invoices.length} 张，显示前 100 张）</summary><div className="accounting-table"><table><thead><tr><th>发票</th><th>日期</th><th>方向</th><th>蓝红字</th><th>价税合计</th><th>原蓝字</th><th>关联凭证</th></tr></thead><tbody>{data.invoices.slice(0,100).map((i:any)=><tr><td>{i.number}</td><td>{i.date}</td><td>{i.kind==='sale'?'销项':'进项'}</td><td>{i.color==='red'?'红字':'蓝字'}</td><td>{i.gross}</td><td>{i.color==='red'?`${i.originalPeriod} ${i.originalNumber}`:'—'}</td><td>{i.voucher}</td></tr>)}</tbody></table></div></details>
   {candidate&&canWrite&&<div><button disabled={busy} onClick={()=>void perform(async()=>{const result=await api(url,{version:saved.version,payload:candidate.payload});setSaved({version:result.version,payload:candidate.payload,report:result.report});setCandidate(null);try{setHistory(await api(url+"/history"));setMessage("底稿已保存；差异仍需处理并独立复核")}catch{setMessage("底稿已保存；历史列表暂未刷新，请稍后重新打开") }})}>保存本次底稿</button> <button className="secondary" disabled={busy} onClick={()=>setCandidate(null)}>放弃预览</button></div>}
  </section>}
 </div>;
}
