import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  tx,
  one,
  order,
  editable,
  touch,
  writer,
  audit,
  fail,
  role,
  uuid,
  date,
  reason,
  canonical,
} from "./core.js";

export async function assertStaffChange(db: any, id: string, b: any) {
  const u = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [id]);
  if (u.version !== b.version) fail(409, "员工资料已变化，请刷新后重试");
  const duties = (
    await db.query(
      `SELECT company_id,assignee_id,reviewer_id FROM work_orders WHERE status<>'archived' AND (assignee_id=$1 OR reviewer_id=$1)
    UNION ALL SELECT id,default_assignee_id,default_reviewer_id FROM companies WHERE default_assignee_id=$1 OR default_reviewer_id=$1`,
      [id],
    )
  ).rows;
  for (const d of duties) {
    if (
      !b.active ||
      b.role === "viewer" ||
      (d.reviewer_id === id && !["owner", "reviewer"].includes(b.role))
    )
      fail(409, "该员工仍有客户默认分工或未归档工作，请先在人员交接中转交");
    if (
      u.role === "owner" &&
      b.role !== "owner" &&
      !(
        await db.query(
          "SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2",
          [d.company_id, id],
        )
      ).rowCount
    )
      fail(409, "降级后将失去在办客户权限，请先分配客户授权或完成交接");
  }
}

export function operationsRoutes(get: any, post: any) {
  post(
    "/api/v1/orders/:id/followups",
    z.object({
      version: z.number().int().positive(),
      index: z.number().int().min(0).max(39),
      note: reason,
      channel: z.enum(["电话", "微信", "邮件", "其他"]),
      nextDate: date.optional(),
    }),
    "记录缺件跟进",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await order(db, r.params.id, b.version);
        editable(o);
        const item = o.checklist[b.index];
        if (!item || item.fileId || item.waiver)
          fail(409, "该资料已齐备或豁免，请刷新缺件清单");
        const id = randomUUID();
        await db.query(
          "INSERT INTO material_followups(id,org_id,company_id,order_id,material_index,note,channel,next_date,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            r.actor.org_id,
            o.company_id,
            o.id,
            b.index,
            b.note,
            b.channel,
            b.nextDate || null,
            r.actor.id,
          ],
        );
        await touch(db, o, r.actor, false);
        await audit(
          db,
          r.actor,
          "material_followup",
          o.id,
          o.company_id,
          b,
          r.id,
        );
        return { id };
      }),
  );
  get("/api/v1/team/directory", "员工工作量与状态", async (r: any) =>
    tx(r.actor, async (db) => {
      role(r.actor, "owner");
      return (
        await db.query(`SELECT u.id,u.name,u.username,u.role,u.active,u.version,u.must_change_password,
          CASE WHEN u.role='owner' THEN (SELECT count(*)::int FROM companies) ELSE coalesce(m.n,0) END AS companies,
          coalesce(h.n,0) AS handling,coalesce(r.n,0) AS reviewing
          FROM users u
          LEFT JOIN(SELECT user_id,count(*)::int n FROM memberships GROUP BY user_id)m ON m.user_id=u.id
          LEFT JOIN(SELECT assignee_id,count(*)::int n FROM work_orders WHERE status<>'archived' GROUP BY assignee_id)h ON h.assignee_id=u.id
          LEFT JOIN(SELECT reviewer_id,count(*)::int n FROM work_orders WHERE status<>'archived' GROUP BY reviewer_id)r ON r.reviewer_id=u.id
          ORDER BY u.active DESC,u.name`)
      ).rows;
    }),
  );
  get(
    "/api/v1/team/users/:id/workload",
    "员工客户分工与交接预览",
    async (r: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const id = uuid.parse(r.params.id);
        const user = await one(
          db,
          "SELECT id,name,role,active,version FROM users WHERE id=$1",
          [id],
        );
        const companies = (
          await db.query(
            `SELECT c.* FROM companies c WHERE c.default_assignee_id=$1 OR c.default_reviewer_id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=c.id AND m.user_id=$1) OR EXISTS(SELECT 1 FROM work_orders w WHERE w.company_id=c.id AND w.status<>'archived' AND (w.assignee_id=$1 OR w.reviewer_id=$1)) ORDER BY c.name`,
            [id],
          )
        ).rows;
        const orders = (
          await db.query(
            "SELECT id,company_id,period,status,version,assignee_id,reviewer_id FROM work_orders WHERE status<>'archived' AND (assignee_id=$1 OR reviewer_id=$1) ORDER BY company_id,period",
            [id],
          )
        ).rows;
        return { user, companies, orders };
      }),
  );
  post(
    "/api/v1/team/handoff",
    z.object({
      sourceId: uuid,
      targetId: uuid,
      companyId: uuid,
      sourceVersion: z.number().int().positive(),
      companyVersion: z.number().int().positive(),
      orders: z
        .array(z.object({ id: uuid, version: z.number().int().positive() }))
        .max(1000),
      reason,
      revokeSource: z.boolean(),
    }),
    "按客户原子交接人员职责",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        if (b.sourceId === b.targetId) fail(400, "请选择另一位接手员工");
        const c = await one(
          db,
          "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
          [b.companyId],
        );
        // Stable lock order prevents simultaneous opposite handoffs from deadlocking.
        const people = (
          await db.query(
            "SELECT id,role,active,version FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [[b.sourceId, b.targetId]],
          )
        ).rows;
        const source = people.find((u) => u.id === b.sourceId),
          target = people.find((u) => u.id === b.targetId);
        if (!source || !target) fail(404, "员工不存在");
        if (
          source.version !== b.sourceVersion ||
          c.version !== b.companyVersion
        )
          fail(409, "分工已变化，请重新预览");
        if (!target.active) fail(400, "接手员工已停用");
        if (source.role === "owner" && b.revokeSource)
          fail(400, "负责人拥有全部客户权限，不能按公司撤销");
        const orders = (
          await db.query(
            "SELECT * FROM work_orders WHERE company_id=$1 AND status<>'archived' AND (assignee_id=$2 OR reviewer_id=$2) ORDER BY id FOR UPDATE",
            [c.id, source.id],
          )
        ).rows;
        const snapshot = (a: any[]) =>
          canonical(
            a
              .map((o) => ({ id: o.id, version: o.version }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          );
        if (snapshot(orders) !== snapshot(b.orders))
          fail(409, "在办月份已变化，请重新预览交接范围");
        const replace = (id: string) => (id === source.id ? target.id : id);
        const check = (
          assignee: string,
          reviewer: string,
          contributors: string[] = [],
          submittedBy?: string,
        ) => {
          if (assignee === source.id && target.role === "viewer")
            fail(400, "只读人员不能接手经办职责");
          if (
            reviewer === source.id &&
            !["owner", "reviewer"].includes(target.role)
          )
            fail(400, "接手人员需要复核角色");
          if (replace(assignee) && replace(assignee) === replace(reviewer))
            fail(400, "交接会导致经办与复核为同一人");
          if (
            reviewer === source.id &&
            (contributors.includes(target.id) ||
              submittedBy === target.id ||
              assignee === target.id)
          )
            fail(403, "接手复核人员参与过经办，请选择独立复核人员");
        };
        check(c.default_assignee_id, c.default_reviewer_id);
        for (const o of orders)
          check(
            o.assignee_id,
            o.reviewer_id,
            o.contributors,
            o.submission?.submittedBy,
          );
        await db.query(
          "INSERT INTO memberships(org_id,company_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [r.actor.org_id, c.id, target.id],
        );
        await db.query(
          "UPDATE companies SET default_assignee_id=$1,default_reviewer_id=$2,version=version+1 WHERE id=$3",
          [
            replace(c.default_assignee_id),
            replace(c.default_reviewer_id),
            c.id,
          ],
        );
        for (const o of orders) {
          await db.query(
            "UPDATE work_orders SET assignee_id=$1,reviewer_id=$2,version=version+1,updated_at=now(),contributors=CASE WHEN assignee_id=$3 THEN ARRAY(SELECT DISTINCT unnest(contributors||$3::uuid)) ELSE contributors END WHERE id=$4",
            [replace(o.assignee_id), replace(o.reviewer_id), source.id, o.id],
          );
          await audit(
            db,
            r.actor,
            "staff_handoff",
            o.id,
            c.id,
            { sourceId: source.id, targetId: target.id, reason: b.reason },
            r.id,
          );
        }
        if (b.revokeSource)
          await db.query(
            "DELETE FROM memberships WHERE company_id=$1 AND user_id=$2",
            [c.id, source.id],
          );
        await audit(
          db,
          r.actor,
          "company_handoff",
          c.id,
          c.id,
          { ...b, orders: orders.map((o) => o.id) },
          r.id,
        );
        return { ok: true, transferred: orders.length };
      }),
  );
}
