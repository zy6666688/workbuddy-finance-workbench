import { z } from "zod";
import {
  tx,
  company,
  one,
  writer,
  role,
  audit,
  uuid,
  period,
  fail,
  sha,
  touch,
} from "./core.js";
import {
  validateFinanceState,
  buildFinanceBackup,
} from "../../src/finance-dashboard-helpers.js";

const keys = z.enum([
  "todos",
  "closeTasks",
  "fieldDictionary",
  "settings",
  "snapshots",
  "exceptions",
]);
const personal = z.enum([
  "theme",
  "favorites",
  "recentWorkflows",
  "pinnedFiles",
  "recentOrders",
]);
function validate(key: string, value: any) {
  if (key === "recentOrders") {
    z.array(uuid).max(10).parse(value);
    return;
  }
  try {
    validateFinanceState({
      todos: [],
      closeTasks: [],
      favorites: [],
      fieldDictionary: [],
      [key]: value,
    });
  } catch (e: any) {
    fail(400, e.message);
  }
}
export function workspaceRoutes(app: any) {
  const query = (r: any) => ({
    cid: uuid.parse(r.params.id),
    period: period.parse(r.params.period),
  });
  app.get("/api/v1/companies/:id/workspace/:period", async (r: any) =>
    tx(r.actor, async (db) => {
      const q = query(r);
      await company(db, q.cid);
      const row = (
        await db.query(
          "SELECT state,version FROM finance_workspaces WHERE company_id=$1 AND period=$2",
          [q.cid, q.period],
        )
      ).rows[0] || { state: {}, version: 0 };
      const history = (
        await db.query(
          "SELECT state->'snapshots' AS snapshots FROM finance_workspaces WHERE company_id=$1 AND period<$2 ORDER BY period DESC LIMIT 5",
          [q.cid, q.period],
        )
      ).rows.flatMap((r) => r.snapshots || []);
      return { ...row, history };
    }),
  );
  app.post("/api/v1/companies/:id/workspace/:period", async (r: any) =>
    tx(r.actor, async (db) => {
      writer(r.actor);
      const q = query(r),
        b = z
          .object({
            version: z.number().int().min(0),
            key: keys,
            value: z.any(),
          })
          .parse(r.body);
      await company(db, q.cid);
      validate(b.key, b.value);
      if (Buffer.byteLength(JSON.stringify(b.value)) > 2 * 1024 * 1024)
        fail(413, "单项业务记录超过2MB，请分期整理");
      if (
        b.key === "snapshots" &&
        b.value.some((s: any) => s.period !== q.period)
      )
        fail(400, "经营快照必须属于当前会计期间");
      const order = (
        await db.query(
          "SELECT * FROM work_orders WHERE company_id=$1 AND period=$2 FOR UPDATE",
          [q.cid, q.period],
        )
      ).rows[0];
      if (order && ["review", "delivery", "archived"].includes(order.status))
        fail(409, "本期已提交复核或归档，请退回或申请重开后修改业务记录");
      const old = (
        await db.query(
          "SELECT * FROM finance_workspaces WHERE company_id=$1 AND period=$2 FOR UPDATE",
          [q.cid, q.period],
        )
      ).rows[0];
      if ((old?.version || 0) !== b.version)
        fail(409, "记录已被其他同事修改，请刷新后重试");
      const state = { ...old?.state, [b.key]: b.value };
      let saved;
      if (old)
        saved = await db.query(
          "UPDATE finance_workspaces SET state=$1,version=version+1,updated_at=now() WHERE company_id=$2 AND period=$3 RETURNING version",
          [JSON.stringify(state), q.cid, q.period],
        );
      else
        saved = await db.query(
          "INSERT INTO finance_workspaces(org_id,company_id,period,state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING version",
          [r.actor.org_id, q.cid, q.period, JSON.stringify(state)],
        );
      if (!saved.rows[0]) fail(409, "记录已被其他同事修改，请刷新后重试");
      if (order) await touch(db, order, r.actor);
      await audit(
        db,
        r.actor,
        "workspace_changed",
        q.period,
        q.cid,
        {
          key: b.key,
          version: saved.rows[0].version,
          previousDigest: sha(JSON.stringify(old?.state?.[b.key] ?? null)),
          digest: sha(JSON.stringify(b.value)),
        },
        r.id,
      );
      return saved.rows[0];
    }),
  );
  app.get(
    "/api/v1/companies/:id/workspace/:period/export",
    async (r: any, reply: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const q = query(r),
          c = await company(db, q.cid);
        const row = (
          await db.query(
            "SELECT state FROM finance_workspaces WHERE company_id=$1 AND period=$2",
            [q.cid, q.period],
          )
        ).rows[0];
        await audit(
          db,
          r.actor,
          "workspace_exported",
          q.period,
          c.id,
          {},
          r.id,
        );
        reply
          .header(
            "Content-Disposition",
            `attachment; filename="company-${q.period}.json"`,
          )
          .type("application/octet-stream");
        return Buffer.from(
          JSON.stringify(
            buildFinanceBackup({
              todos: [],
              closeTasks: [],
              fieldDictionary: [],
              favorites: [],
              ...row?.state,
              profile: { entity: c.name, period: q.period },
              auditLog: [],
            }),
            null,
            2,
          ),
        );
      }),
  );
  app.get("/api/v1/companies/:id/files", async (r: any) =>
    tx(r.actor, async (db) => {
      const cid = uuid.parse(r.params.id);
      await company(db, cid);
      const p = period.parse(r.query.period);
      return (
        await db.query(
          "SELECT f.id,f.name,f.kind,f.size,f.version,(extract(epoch FROM f.created_at)*1000)::double precision AS \"modifiedAt\",f.category||'/v'||f.version||'/'||f.name AS relative FROM files f JOIN work_orders w ON w.id=f.order_id WHERE f.company_id=$1 AND w.period=$2 ORDER BY f.created_at DESC LIMIT 1000",
          [cid, p],
        )
      ).rows;
    }),
  );
  app.post("/api/v1/preferences/desk", async (r: any) =>
    tx(r.actor, async (db) => {
      const b = z
        .object({
          version: z.number().int().min(0),
          key: personal,
          value: z.any(),
        })
        .parse(r.body);
      validate(b.key, b.value);
      const old = (
        await db.query(
          "SELECT * FROM user_preferences WHERE user_id=$1 FOR UPDATE",
          [r.actor.id],
        )
      ).rows[0];
      if ((old?.version || 0) !== b.version)
        fail(409, "个人设置已被其他页面修改");
      const value = {
        ...old?.value,
        desk: { ...old?.value?.desk, [b.key]: b.value },
      };
      if (b.key === "theme") value.theme = b.value;
      const saved = old
        ? await db.query(
            "UPDATE user_preferences SET value=$1,version=version+1 WHERE user_id=$2 RETURNING version",
            [JSON.stringify(value), r.actor.id],
          )
        : await db.query(
            "INSERT INTO user_preferences(user_id,value) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING version",
            [r.actor.id, JSON.stringify(value)],
          );
      if (!saved.rows[0]) fail(409, "个人设置已被其他页面修改");
      return saved.rows[0];
    }),
  );
}
