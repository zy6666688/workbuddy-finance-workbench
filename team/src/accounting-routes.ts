import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountingInput } from "./accounting.js";
import { contextualAccountingReport } from "./accounting-context.js";
import { accountingTemplate, accountingExport, readAccountingWorkbook } from "./accounting-workbook.js";
import { invalidateInputs } from "./results.js";
import { tx, uuid, period, company, writer, fail, audit, sha, touch } from "./core.js";

export function accountingRoutes(app: any) {
 const path = (r:any) => ({ cid:uuid.parse(r.params.id), p:period.parse(r.params.period) });
 app.get("/api/v1/accounting/template",async(_r:any,reply:any)=>{
  reply.header("Content-Disposition",'attachment; filename="accounting-template.xlsx"').type("application/octet-stream");
  return accountingTemplate();
 });
 app.get("/api/v1/companies/:id/accounting/:period", async(r:any)=>tx(r.actor,async(db)=>{
  const {cid,p}=path(r);await company(db,cid);
  const row=(await db.query("SELECT version,payload,actor_id,created_at FROM accounting_snapshots WHERE company_id=$1 AND period=$2 ORDER BY version DESC LIMIT 1",[cid,p])).rows[0];
  return row?{...row,report:await contextualAccountingReport(db,cid,p,row.payload)}:{version:0,payload:null,report:null};
 }));
 app.get("/api/v1/companies/:id/accounting/:period/history",async(r:any)=>tx(r.actor,async(db)=>{
  const {cid,p}=path(r);await company(db,cid);
  return (await db.query("SELECT id,version,actor_id,created_at FROM accounting_snapshots WHERE company_id=$1 AND period=$2 ORDER BY version DESC LIMIT 100",[cid,p])).rows;
 }));
 app.get("/api/v1/companies/:id/accounting/:period/export",async(r:any,reply:any)=>tx(r.actor,async(db)=>{
  writer(r.actor);const {cid,p}=path(r);await company(db,cid);
  const selected=r.query?.version===undefined?null:z.coerce.number().int().positive().parse(r.query.version);
  const row=(await db.query("SELECT version,payload FROM accounting_snapshots WHERE company_id=$1 AND period=$2 AND ($3::integer IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",[cid,p,selected])).rows[0];
  if(!row)fail(404,"本期尚无已保存底稿");
  const report=await contextualAccountingReport(db,cid,p,row.payload),bytes=await accountingExport(row.payload,report);
  await audit(db,r.actor,"accounting_snapshot_exported",p,cid,{version:row.version},r.id);
  reply.header("Content-Disposition",`attachment; filename="accounting-${p}.xlsx"`).type("application/octet-stream");return bytes;
 }));
 app.post("/api/v1/companies/:id/accounting/:period/preview",async(r:any)=>{
  const {cid,p}=path(r);return tx(r.actor,async(db)=>{await company(db,cid);return contextualAccountingReport(db,cid,p,r.body)});
 });
 app.post("/api/v1/companies/:id/accounting/:period/preview-file",async(r:any)=>{
  writer(r.actor);const {cid,p}=path(r);
  await tx(r.actor,async(db)=>{await company(db,cid)});
  const file=await r.file();if(!file)fail(400,"请选择底稿表格");
  const payload=await readAccountingWorkbook(await file.toBuffer(),file.filename);
  return {payload,report:await tx(r.actor,db=>contextualAccountingReport(db,cid,p,payload))};
 });
 app.post("/api/v1/companies/:id/accounting/:period",async(r:any)=>tx(r.actor,async(db)=>{
  writer(r.actor);const {cid,p}=path(r);const body=z.object({version:z.number().int().min(0),payload:accountingInput}).parse(r.body);
  if(Buffer.byteLength(JSON.stringify(body.payload))>2*1024*1024) fail(413,"核对底稿超过 2MB，请按期间整理");
  // Lock company to serialize first and subsequent versions.
  await company(db,cid);await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[cid+":"+p]);
  const order=(await db.query("SELECT * FROM work_orders WHERE company_id=$1 AND period=$2 FOR UPDATE",[cid,p])).rows[0];
  if(!order) fail(409,"请先为该客户建立本期月度工作单，再保存底稿");
  if(order && ["review","delivery","archived"].includes(order.status)) fail(409,"本期已提交复核或归档，请退回或重开后修改底稿");
  const old=(await db.query("SELECT version FROM accounting_snapshots WHERE company_id=$1 AND period=$2 ORDER BY version DESC LIMIT 1",[cid,p])).rows[0];
  if((old?.version||0)!==body.version) fail(409,"底稿已被其他同事修改，请刷新后重试");
  const report=await contextualAccountingReport(db,cid,p,body.payload),version=body.version+1;
  await db.query("INSERT INTO accounting_snapshots(id,org_id,company_id,period,version,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),r.actor.org_id,cid,p,version,JSON.stringify(body.payload),r.actor.id]);
  await invalidateInputs(db,order);await touch(db,order,r.actor);
  await audit(db,r.actor,"accounting_snapshot_saved",p,cid,{version,digest:sha(JSON.stringify(body.payload)),issueCount:report.issues.length},r.id);
  return {version,report};
 }));
}
