import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { tx, company, one, uuid, period, writer, role, fail, audit, canonical, sha, storeFile, fileBytes, touch, type Actor } from "./core.js";
import { dossierPayload, emptyDossier, dossierGaps, dossierDiff, type DossierPayload } from "./client-dossier.js";
import { invalidateInputs } from "./results.js";

const lock = (db: any, cid: string) => db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dossier:" + cid]);
const latest = async (db: any, cid: string) => (await db.query("SELECT * FROM client_dossier_revisions WHERE company_id=$1 ORDER BY version DESC LIMIT 1", [cid])).rows[0];
const effective = async (db: any, cid: string, p: string) => (await db.query("SELECT * FROM client_dossier_revisions WHERE company_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC,version DESC LIMIT 1", [cid, p])).rows[0];
const refs = (p: DossierPayload) => [...p.evidence, ...p.intake.flatMap(i => i.evidence)];
async function evidence(db: any, cid: string, payload: DossierPayload) {
  const found = new Map();
  for (const ref of refs(payload)) {
    const key = ref.kind + ":" + ref.id;
    if (found.has(key)) continue;
    const table = ref.kind === "monthly" ? "files" : "client_dossier_documents";
    const f = await one(db, `SELECT id,name,sha256,size,created_at FROM ${table} WHERE id=$1 AND company_id=$2`, [ref.id, cid]);
    found.set(key, { ...f, kind: ref.kind, downloadUrl: ref.kind === "monthly" ? `/api/v1/files/${f.id}/download` : `/api/v1/companies/${cid}/dossier/documents/${f.id}/download` });
  }
  return [...found.values()];
}
function visiblePayload(p: DossierPayload, a: Actor) {
  if (a.role !== "viewer") return p;
  return { ...p, contactPhone: p.contactPhone ? "已隐藏" : "", banks: p.banks.map(b => ({ ...b, accountNumber: "****" + b.accountNumber.slice(-4) })) };
}
// Only invoked for a newly created month. Existing months require explicit binding.
export async function bindNewMonthDossier(db: any, a: Actor, cid: string, p: string, requestId: string) {
  await lock(db, cid);
  const revision = await effective(db, cid, p);
  if (!revision) return;
  await db.query("INSERT INTO client_dossier_bindings(org_id,company_id,period,revision_id,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [a.org_id,cid,p,revision.id,a.id]);
  await audit(db,a,"dossier_month_bound",p,cid,{revisionId:revision.id,version:revision.version,automatic:true},requestId);
}

export function clientDossierRoutes(app: any, validateFile: (b: Buffer, ext: string) => void) {
  const route = "/api/v1/companies/:id/dossier";
  const get = (url: string, summary: string, fn: any) => app.get(url, {schema:{summary,security:[{session:[]}]}},fn);
  const post = (url: string, summary: string, schema: z.ZodType, fn: any) => app.post(url,{schema:{summary,security:[{session:[],csrf:[]}],body:z.toJSONSchema(schema,{target:"draft-7"})}},(r:any)=>fn(r,schema.parse(r.body)));
  get(route,"客户档案、指定月份快照及接账缺项",(r:any)=>tx(r.actor,async db=>{
    const c=await company(db,r.params.id), p=period.parse(r.query?.period);
    const head=await latest(db,c.id), candidate=await effective(db,c.id,p);
    const binding=(await db.query("SELECT d.*,b.created_at AS bound_at FROM client_dossier_bindings b JOIN client_dossier_revisions d ON d.id=b.revision_id WHERE b.company_id=$1 AND b.period=$2",[c.id,p])).rows[0];
    const o=(await db.query("SELECT id,version,status,assignee_id,reviewer_id FROM work_orders WHERE company_id=$1 AND period=$2",[c.id,p])).rows[0];
    const ids=[o?.assignee_id||c.default_assignee_id,o?.reviewer_id||c.default_reviewer_id];
    const staff=(await db.query("SELECT id,name,role,active,(role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=$1 AND m.user_id=users.id)) AS authorized FROM users WHERE id=ANY($2::uuid[])",[c.id,ids.filter(Boolean)])).rows;
    const staffed=ids[0]!==ids[1] && staff.some(u=>u.id===ids[0]&&u.active&&u.authorized&&u.role!=="viewer") && staff.some(u=>u.id===ids[1]&&u.active&&u.authorized&&["reviewer","owner"].includes(u.role));
    const selected=binding||candidate;
    const payload=selected?.payload||emptyDossier(c);
    const gaps=dossierGaps(payload,staffed);
    if(!binding) gaps.unshift({key:"period_binding",name:"本月档案尚未固定",impact:"当前展示候选档案；须在月度工作单中确认适用版本"});
    if(!selected) gaps.unshift({key:"unconfirmed",name:"客户档案尚未确认",impact:"基础信息仅供补录，不代表已完成接账"});
    const history=(await db.query("SELECT id,version,effective_from,reason,actor_id,created_at FROM client_dossier_revisions WHERE company_id=$1 ORDER BY version DESC LIMIT 30",[c.id])).rows;
    const drafts=(await db.query("SELECT id,base_version,company_version,effective_from,reason,actor_id,created_at FROM client_dossier_drafts WHERE company_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 30",[c.id])).rows;
    return {company:{id:c.id,name:c.name,code:c.code,version:c.version},period:p,latestVersion:head?.version||0,selectedVersion:selected?.version||0,revisionId:selected?.id||null,effectiveFrom:selected?.effective_from||null,bound:!!binding,order:o||null,staffing:{source:o?"monthly":"defaults",assigneeId:ids[0],reviewerId:ids[1],people:staff,valid:staffed},payload:visiblePayload(payload,r.actor),gaps,readiness:gaps.length?"待补齐":"资料已登记，仍需业务复核",evidence:await evidence(db,c.id,payload),history,drafts,canEdit:r.actor.role!=="viewer",canConfirm:["owner","reviewer"].includes(r.actor.role)};
  }));
  get(route+"/revisions/:revisionId","查看不可覆盖的历史客户档案",(r:any)=>tx(r.actor,async db=>{
    const c=await company(db,r.params.id), row=await one(db,"SELECT * FROM client_dossier_revisions WHERE company_id=$1 AND id=$2",[c.id,uuid.parse(r.params.revisionId)]);
    return {...row,payload:visiblePayload(row.payload,r.actor),evidence:await evidence(db,c.id,row.payload)};
  }));
  const draftSchema=z.object({version:z.number().int().min(0),companyVersion:z.number().int().positive(),key:uuid,effectiveFrom:period,reason:z.string().trim().min(1).max(2000),payload:dossierPayload}).strict();
  post(route+"/drafts","准备客户档案变更草稿，不生效",draftSchema,(r:any,b:any)=>tx(r.actor,async db=>{
    writer(r.actor);const c=await company(db,r.params.id);if(!c.active)fail(409,"客户已停用");await lock(db,c.id);
    const fingerprint=sha(canonical(b));const prior=(await db.query("SELECT id,fingerprint,status FROM client_dossier_drafts WHERE company_id=$1 AND actor_id=$2 AND request_key=$3",[c.id,r.actor.id,b.key])).rows[0];
    if(prior){if(prior.fingerprint!==fingerprint)fail(409,"该请求标识已用于不同草稿");return {id:prior.id,status:prior.status};}
    const head=await latest(db,c.id);if((head?.version||0)!==b.version||c.version!==b.companyVersion)fail(409,"档案或客户信息已更新，请重新查看后准备草稿");
    await evidence(db,c.id,b.payload);
    const id=randomUUID();await db.query("INSERT INTO client_dossier_drafts(id,org_id,company_id,base_version,company_version,effective_from,payload,reason,actor_id,request_key,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,r.actor.org_id,c.id,b.version,b.companyVersion,b.effectiveFrom,JSON.stringify(b.payload),b.reason,r.actor.id,b.key,fingerprint]);
    await audit(db,r.actor,"dossier_draft_created",id,c.id,{baseVersion:b.version,digest:fingerprint},r.id);
    return {id,status:"pending"};
  }));
  get(route+"/drafts/:draftId","审阅客户档案变更及依据",(r:any)=>tx(r.actor,async db=>{
    const c=await company(db,r.params.id), draft=await one(db,"SELECT * FROM client_dossier_drafts WHERE id=$1 AND company_id=$2",[uuid.parse(r.params.draftId),c.id]);
    const head=await latest(db,c.id), before=head?.payload||emptyDossier(c);
    return {...draft,payload:visiblePayload(draft.payload,r.actor),before:visiblePayload(before,r.actor),changedFields:dossierDiff(before,draft.payload),stale:(head?.version||0)!==draft.base_version||c.version!==draft.company_version,evidence:await evidence(db,c.id,draft.payload)};
  }));
  post(route+"/drafts/:draftId/confirm","员工确认档案版本，已固定月份保持不变",z.object({version:z.number().int().min(0)}).strict(),(r:any,b:any)=>tx(r.actor,async db=>{
    role(r.actor,"owner","reviewer");const c=await company(db,r.params.id);await lock(db,c.id);
    // Serialize with existing company profile/name/staff edits as well.
    const current=await one(db,"SELECT * FROM companies WHERE id=$1 FOR UPDATE",[c.id]);
    if(!current.active)fail(409,"客户已停用");
    const draft=await one(db,"SELECT * FROM client_dossier_drafts WHERE company_id=$1 AND id=$2 FOR UPDATE",[c.id,uuid.parse(r.params.draftId)]);
    if(draft.status==="confirmed")return {id:draft.revision_id,existing:true};
    if(draft.status!=="pending")fail(409,"草稿已撤回");
    const head=await latest(db,c.id);
    if((head?.version||0)!==b.version||draft.base_version!==b.version||draft.company_version!==current.version)fail(409,"档案或客户信息已变化，请重新准备草稿");
    await evidence(db,c.id,draft.payload);
    const id=randomUUID(),version=b.version+1;
    await db.query("INSERT INTO client_dossier_revisions(id,org_id,company_id,version,effective_from,payload,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,r.actor.org_id,c.id,version,draft.effective_from,draft.payload,draft.reason,r.actor.id]);
    await db.query("UPDATE client_dossier_drafts SET status='confirmed',revision_id=$1 WHERE id=$2",[id,draft.id]);
    await audit(db,r.actor,"dossier_confirmed",id,c.id,{version,preparedBy:draft.actor_id,effectiveFrom:draft.effective_from,digest:sha(canonical(draft.payload))},r.id);
    return {id,version};
  }));
  post(route+"/drafts/:draftId/withdraw","撤回尚未生效的草稿",z.object({}).strict(),(r:any)=>tx(r.actor,async db=>{
    writer(r.actor);const c=await company(db,r.params.id);await lock(db,c.id);
    const d=await one(db,"SELECT * FROM client_dossier_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE",[uuid.parse(r.params.draftId),c.id]);
    if(d.actor_id!==r.actor.id&&!['owner','reviewer'].includes(r.actor.role))fail(403,"只能撤回本人草稿");
    if(d.status==='confirmed')fail(409,"已生效档案须建立新版本");
    if(d.status!=='withdrawn'){await db.query("UPDATE client_dossier_drafts SET status='withdrawn' WHERE id=$1",[d.id]);await audit(db,r.actor,"dossier_draft_withdrawn",d.id,c.id,{},r.id);}
    return {ok:true};
  }));
  post(route+"/bind","确认本月档案版本",z.object({period,revisionId:uuid,orderVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(2000)}).strict(),(r:any,b:any)=>tx(r.actor,async db=>{
    role(r.actor,"owner","reviewer");const c=await company(db,r.params.id);await lock(db,c.id);
    const o=await one(db,"SELECT * FROM work_orders WHERE company_id=$1 AND period=$2 FOR UPDATE",[c.id,b.period]);
    const prior=(await db.query("SELECT revision_id FROM client_dossier_bindings WHERE company_id=$1 AND period=$2",[c.id,b.period])).rows[0];
    if(prior?.revision_id===b.revisionId)return {ok:true,existing:true};
    if(o.version!==b.orderVersion)fail(409,"月份资料已变化，请刷新");
    if(!['collecting','checking','processing'].includes(o.status))fail(409,"送审或归档月份不可更改档案版本，请先退回或重开");
    const d=await one(db,"SELECT * FROM client_dossier_revisions WHERE id=$1 AND company_id=$2",[b.revisionId,c.id]);
    if(d.effective_from>b.period)fail(400,"该档案尚未在本月生效");
    await db.query("INSERT INTO client_dossier_bindings(org_id,company_id,period,revision_id,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,period) DO UPDATE SET revision_id=EXCLUDED.revision_id,actor_id=EXCLUDED.actor_id,created_at=now()",[r.actor.org_id,c.id,b.period,d.id,r.actor.id]);
    await invalidateInputs(db,o);await touch(db,o,r.actor);
    await audit(db,r.actor,"dossier_month_bound",b.period,c.id,{revisionId:d.id,previous:prior?.revision_id||null,reason:b.reason},r.id);
    return {ok:true};
  }));
  get(route+"/documents","分页查询长期档案原件",(r:any)=>tx(r.actor,async db=>{
    const c=await company(db,r.params.id),q=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(r.query);
    return {rows:(await db.query("SELECT id,name,size,sha256,created_at FROM client_dossier_documents WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT 30 OFFSET $2",[c.id,q.offset])).rows,total:(await db.query("SELECT count(*)::int AS n FROM client_dossier_documents WHERE company_id=$1",[c.id])).rows[0].n};
  }));
  app.post(route+"/documents",{schema:{summary:"上传长期档案原件（不覆盖旧文件）",security:[{session:[],csrf:[]}]}},async(r:any)=>{
    writer(r.actor);const cid=uuid.parse(r.params.id),key=uuid.parse(r.query?.key);
    await tx(r.actor,async db=>{const c=await company(db,cid);if(!c.active)fail(409,"客户已停用")});
    const f=await r.file();if(!f)fail(400,"请选择文件");
    const ext=path.extname(f.filename).toLowerCase();if(!['.csv','.xlsx','.pdf','.png','.jpg','.jpeg','.txt','.docx'].includes(ext))fail(400,"不支持的文件类型");
    const bytes=await f.toBuffer();if(f.file.truncated)fail(413,"文件超过50MB");validateFile(bytes,ext);
    const name=path.basename(f.filename.replaceAll('\\','/')).replace(/[\u0000-\u001f]/g,'').slice(0,180);
    return tx(r.actor,async db=>{
      const c=await company(db,cid);if(!c.active)fail(409,"客户已停用");await lock(db,cid);
      const old=(await db.query("SELECT id,name,sha256 FROM client_dossier_documents WHERE company_id=$1 AND uploaded_by=$2 AND request_key=$3",[cid,r.actor.id,key])).rows[0];
      if(old){if(old.sha256!==sha(bytes)||old.name!==name)fail(409,"上传标识已用于不同文件");return old;}
      const saved=await storeFile(r.actor,{company_id:cid},name,bytes);
      await db.query("INSERT INTO client_dossier_documents(id,org_id,company_id,name,storage_key,size,sha256,uploaded_by,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[saved.id,r.actor.org_id,cid,saved.name,saved.key,saved.size,saved.hash,r.actor.id,key]);
      await audit(db,r.actor,"dossier_document_uploaded",saved.id,cid,{sha256:saved.hash,size:saved.size},r.id);
      return {id:saved.id,name:saved.name,sha256:saved.hash};
    });
  });
  get(route+"/documents/:fileId/download","鉴权下载长期档案原件",(r:any,reply:any)=>tx(r.actor,async db=>{
    writer(r.actor);const c=await company(db,r.params.id),f=await one(db,"SELECT * FROM client_dossier_documents WHERE id=$1 AND company_id=$2",[uuid.parse(r.params.fileId),c.id]);
    const bytes=await fileBytes(f);await audit(db,r.actor,"dossier_document_downloaded",f.id,c.id,{},r.id);
    reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).header('X-Content-Type-Options','nosniff').type('application/octet-stream');return bytes;
  }));
}
