import { Pool, types, type PoolClient } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, statfs } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// A business deadline is a calendar date, not a UTC instant.
types.setTypeParser(1082, (value) => value);
export type Actor = {
  id: string;
  org_id: string;
  username: string;
  name: string;
  role: "owner" | "reviewer" | "operator" | "viewer";
  must_change_password: boolean;
  csrf: string;
};
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
export const dataRoot = path.resolve(process.env.FILES_DIR || ".data/files");
export const uuid = z.uuid();
export const period = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const date = z.iso.date();
export const label = z.string().trim().min(1).max(200);
export const reason = z.string().trim().min(1).max(4000);
export const sha = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
export const canonical = (value: any): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, JSON.parse(canonical(value[k]))]),
          )
      : value,
  );
export const token = () => randomBytes(32).toString("hex");
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status });
}
export function role(actor: Actor, ...roles: Actor["role"][]) {
  if (!roles.includes(actor.role)) fail(403, "没有执行此操作的权限");
}
export function writer(actor: Actor) {
  role(actor, "owner", "reviewer", "operator");
}
export async function tx<T>(
  actor: Pick<Actor, "id">,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('zy.actor',$1,true)", [actor.id]);
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function one(db: PoolClient, sql: string, values: unknown[] = []) {
  const r = await db.query(sql, values);
  if (!r.rows[0]) fail(404, "记录不存在或无权访问");
  return r.rows[0];
}
export async function company(db: PoolClient, id: string) {
  return one(db, "SELECT * FROM companies WHERE id=$1", [uuid.parse(id)]);
}
export async function order(db: PoolClient, id: string, version?: number) {
  const o = await one(db, "SELECT * FROM work_orders WHERE id=$1 FOR UPDATE", [
    uuid.parse(id),
  ]);
  if (version !== undefined && o.version !== version)
    fail(409, "记录已被修改，请刷新后重试");
  return o;
}
export async function audit(
  db: PoolClient,
  a: Actor,
  action: string,
  target: string,
  cid: string | null,
  details: unknown = {},
  requestId = "system",
) {
  await db.query(
    "INSERT INTO audit_events(org_id,company_id,actor_id,action,target_id,details,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [a.org_id, cid, a.id, action, target, JSON.stringify(details), requestId],
  );
}
export function editable(o: any) {
  if (o.status === "archived") fail(409, "已归档批次不可修改，请申请重开");
}
export async function touch(
  db: PoolClient,
  o: any,
  a: Actor,
  substantive = true,
) {
  await db.query(
    `UPDATE work_orders SET version=version+1,updated_at=now(),contributors=CASE WHEN $2 THEN ARRAY(SELECT DISTINCT unnest(contributors||$3::uuid)) ELSE contributors END WHERE id=$1`,
    [o.id, substantive, a.id],
  );
}
export async function membership(
  db: PoolClient,
  cid: string,
  uid: string,
  reviewer = false,
) {
  const u = await one(
    db,
    `SELECT u.id,u.role FROM users u WHERE u.id=$1 AND u.active AND (u.role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=$2 AND m.user_id=u.id))`,
    [uid, cid],
  );
  if (reviewer && !["owner", "reviewer"].includes(u.role))
    fail(400, "复核人员必须具有复核角色");
  if (!reviewer && u.role === "viewer") fail(400, "只读人员不能担任经办");
}
export function independent(o: any, a: Actor) {
  role(a, "owner", "reviewer");
  if (
    o.assignee_id === a.id ||
    o.contributors.includes(a.id) ||
    o.submission?.submittedBy === a.id
  )
    fail(403, "必须由未参与经办的另一名人员复核");
  if (a.role !== "owner" && o.reviewer_id !== a.id)
    fail(403, "仅指定复核人员可以处理");
}
export async function storeFile(
  a: Actor,
  o: any,
  name: string,
  bytes: Buffer,
  kind = "source",
) {
  if (!["source", "result", "evidence"].includes(kind))
    fail(400, "文件类别无效");
  const id = randomUUID(),
    key = `${a.org_id}/${o.company_id}/${kind}/${id}`;
  await mkdir(path.dirname(path.join(dataRoot, key)), { recursive: true });
  await writeFile(path.join(dataRoot, key), bytes, { flag: "wx", mode: 0o600 });
  return {
    id,
    key,
    size: bytes.length,
    hash: sha(bytes),
    name: path
      .basename(name.replaceAll("\\", "/"))
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 180),
  };
}
export async function fileBytes(f: any) {
  if (
    !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/(?:(?:source|result|evidence)\/)?[a-f0-9-]{36}$/.test(
      f.storage_key,
    )
  )
    fail(500, "文件索引异常");
  const bytes = await readFile(path.join(dataRoot, f.storage_key));
  if (sha(bytes) !== f.sha256) fail(409, "文件完整性检查失败");
  return bytes;
}
export async function storageStats() {
  await mkdir(dataRoot, { recursive: true });
  const s = await statfs(dataRoot);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}
