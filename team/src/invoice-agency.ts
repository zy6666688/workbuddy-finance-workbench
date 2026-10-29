import { z } from "zod";
import { one, fail, uuid } from "./core.js";

export const authorizationRef = z
  .object({ id: uuid, version: z.number().int().positive() })
  .strict();
export const chinaDay = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export async function evidenceFiles(db: any, orderId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = (
    await db.query(
      "SELECT id,name,sha256,version FROM files WHERE order_id=$1 AND id=ANY($2::uuid[]) AND kind='evidence' AND category<>'系统任务包'",
      [orderId, unique],
    )
  ).rows;
  if (!unique.length || rows.length !== unique.length)
    fail(400, "请选择本工作单已上传的凭证附件，不可用原始资料或系统任务包代替");
  return rows;
}

export function authorizationState(row: any) {
  const today = chinaDay();
  return row.status !== "verified"
    ? row.status
    : today < row.payload.validFrom
      ? "not_started"
      : today > row.payload.validUntil
        ? "expired"
        : "effective";
}

export async function checkAuthorization(
  db: any,
  companyId: string,
  ref: any,
  seller: any,
  scope: string,
  required = false,
) {
  if (!ref) {
    if (required) fail(409, "请先选择已独立核验且仍有效的客户授权记录");
    return { valid: false, state: "missing", platformAuthorized: false };
  }
  // Serialize revocation with application confirmation and receipt recording.
  const row = await one(
    db,
    "SELECT * FROM invoice_authorizations WHERE id=$1 AND company_id=$2 FOR SHARE",
    [ref.id, companyId],
  );
  const state = authorizationState(row);
  const valid =
    state === "effective" &&
    row.version === ref.version &&
    row.payload.sellerName === seller.sellerName &&
    row.payload.sellerTaxId === seller.sellerTaxId &&
    row.payload.scopes.includes(scope);
  if (required && !valid)
    fail(
      409,
      "客户授权未生效、已失效、版本改变、主体不符或未包含本操作范围，请重新核实",
    );
  return {
    id: row.id,
    version: row.version,
    state,
    valid,
    payload: row.payload,
    platformAuthorized: false,
  };
}

export async function resultState(db: any, requestId: string) {
  // A request permits one pending record and no records after verified success.
  // Insertion sequence is stable even when transactions waited on the same order.
  const rows = (
    await db.query(
      "SELECT id,status,payload,version,request_version,actor_id,created_at FROM invoice_result_records WHERE request_id=$1 AND status<>'rejected' ORDER BY record_index DESC LIMIT 2",
      [requestId],
    )
  ).rows;
  const pending = rows.find((x: any) => x.status === "pending");
  const issued = rows.find(
    (x: any) => x.status === "verified" && x.payload.outcome === "issued",
  );
  const latest = rows.find((x: any) => x.status === "verified");
  const lastRecord = (
    await db.query(
      `SELECT rr.id,rr.status,rr.request_version,(SELECT a.details->>'reason' FROM audit_events a
      WHERE a.company_id=rr.company_id AND a.target_id=rr.request_id::text
        AND a.action='invoice_request_result_reject' AND a.details->>'recordId'=rr.id::text
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS reason
      FROM invoice_result_records rr WHERE rr.request_id=$1 ORDER BY rr.record_index DESC LIMIT 1`,
      [requestId],
    )
  ).rows[0];
  return {
    pending,
    issued,
    latest,
    rejected: lastRecord?.status === "rejected" ? lastRecord : null,
    locked: !!pending || !!issued || latest?.payload.outcome === "unknown",
    taxAuthorityVerified: false,
  };
}

export async function assertInvoiceEditable(db: any, id: string) {
  const state = await resultState(db, id);
  if (state.locked || state.latest?.payload.outcome === "failed")
    fail(
      409,
      "申请已有实际结果回录，请先核实原渠道结果并继续回录；不可修改、撤回或重复开票",
    );
}
