import { resultReadiness } from "./results.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { literalContains } from "./search.js";
import {
  tx,
  one,
  company,
  audit,
  fail,
  role,
  uuid,
  period,
  date,
  label,
  membership,
} from "./core.js";

const listQuery = z.object({
  period,
  search: z.string().trim().max(100).default(""),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  companyId: z.union([uuid, z.literal("")]).default(""),
});
const materials = z
  .array(z.object({ name: label, required: z.boolean() }))
  .min(1)
  .max(40)
  .refine(
    (items) => new Set(items.map((i) => i.name)).size === items.length,
    "资料名称不能重复",
  );
const profile = z.object({
  contactName: z.string().trim().max(100).default(""),
  contactPhone: z.string().trim().max(100).default(""),
  serviceNotes: z.string().trim().max(2000).default(""),
});
const clientFields = z.object({
  name: label,
  code: label,
  profile,
  checklist: materials,
  assigneeId: uuid,
  reviewerId: uuid,
});
const baseClients = `SELECT c.*,a.name AS assignee_name,r.name AS reviewer_name,
 (a.active AND a.role<>'viewer' AND (a.role='owner' OR EXISTS(SELECT 1 FROM memberships WHERE company_id=c.id AND user_id=a.id))
 AND r.active AND r.role IN ('owner','reviewer') AND (r.role='owner' OR EXISTS(SELECT 1 FROM memberships WHERE company_id=c.id AND user_id=r.id))) IS TRUE AS staffed,
 w.id AS order_id,w.status AS order_status,w.due_date,
 (SELECT count(*)::int FROM memberships m JOIN users u ON u.id=m.user_id AND u.active WHERE m.company_id=c.id) AS member_count
 FROM companies c LEFT JOIN users a ON a.id=c.default_assignee_id LEFT JOIN users r ON r.id=c.default_reviewer_id
 LEFT JOIN work_orders w ON w.company_id=c.id AND w.period=$1
 WHERE (c.name ILIKE $2 OR c.code ILIKE $2) AND ($3::uuid IS NULL OR c.id=$3)`;

// This assignment is explicitly authorized by the owner and does not revoke
// other collaborators or rewrite existing work orders.
async function assignDefaults(
  db: any,
  a: any,
  cid: string,
  b: any,
  requestId: string,
) {
  if (b.assigneeId === b.reviewerId) fail(400, "经办与复核必须不同");
  for (const [uid, review] of [
    [b.assigneeId, false],
    [b.reviewerId, true],
  ] as const) {
    const u = await one(
      db,
      "SELECT id,role FROM users WHERE id=$1 AND active FOR SHARE",
      [uid],
    );
    if (review ? !["owner", "reviewer"].includes(u.role) : u.role === "viewer")
      fail(400, review ? "请选择有复核角色的在职员工" : "只读人员不能担任经办");
    await db.query(
      "INSERT INTO memberships(org_id,company_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [a.org_id, cid, uid],
    );
  }
  await db.query(
    "UPDATE companies SET default_assignee_id=$1,default_reviewer_id=$2 WHERE id=$3",
    [b.assigneeId, b.reviewerId, cid],
  );
  await audit(
    db,
    a,
    "client_staffed",
    cid,
    cid,
    { assigneeId: b.assigneeId, reviewerId: b.reviewerId },
    requestId,
  );
}

export function agencyRoutes(get: any, post: any, createOrder: any) {
  get("/api/v1/clients", "客户建档与当月交付进度", async (r: any) =>
    tx(r.actor, async (db) => {
      const q = listQuery
        .extend({
          attention: z.enum(["all", "unstaffed", "unstarted"]).default("all"),
        })
        .parse(r.query);
      const base = `WITH base AS (${baseClients}),filtered AS(SELECT * FROM base WHERE ($4='all' OR ($4='unstaffed' AND NOT staffed) OR ($4='unstarted' AND order_id IS NULL)))`;
      const p = [
        q.period,
        literalContains(q.search),
        q.companyId || null,
        q.attention,
      ];
      const summary = (
        await db.query(
          `${base} SELECT count(*)::int AS total,count(*) FILTER(WHERE NOT staffed)::int AS unstaffed,count(*) FILTER(WHERE order_id IS NULL)::int AS unstarted,(SELECT count(*)::int FROM filtered) AS filtered_total FROM base`,
          p,
        )
      ).rows[0];
      const rows = (
        await db.query(
          `${base} SELECT * FROM filtered ORDER BY name,id LIMIT $5 OFFSET $6`,
          [...p, q.limit, q.offset],
        )
      ).rows;
      return { rows, ...summary };
    }),
  );
  get("/api/v1/clients/:id", "客户档案、人员与月份记录", async (r: any) =>
    tx(r.actor, async (db) => {
      const c = await company(db, r.params.id);
      const selectedPeriod = period.optional().parse(r.query?.period);
      const members = (
        await db.query(
          "SELECT u.id,u.name,u.role,u.active FROM users u WHERE u.role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=$1 AND m.user_id=u.id) ORDER BY u.name",
          [c.id],
        )
      ).rows;
      const orders = (
        await db.query(
          "SELECT id,period,status,due_date FROM work_orders WHERE company_id=$1 ORDER BY period DESC LIMIT 24",
          [c.id],
        )
      ).rows;
      const currentOrder = selectedPeriod
        ? orders.find((o) => o.period === selectedPeriod) ||
          (
            await db.query(
              "SELECT id,period,status,due_date FROM work_orders WHERE company_id=$1 AND period=$2",
              [c.id, selectedPeriod],
            )
          ).rows[0] ||
          null
        : null;
      const staffed =
        members.some(
          (u) =>
            u.id === c.default_assignee_id && u.active && u.role !== "viewer",
        ) &&
        members.some(
          (u) =>
            u.id === c.default_reviewer_id &&
            u.active &&
            ["owner", "reviewer"].includes(u.role),
        );
      return { ...c, members, orders, current_order: currentOrder, staffed };
    }),
  );
  post(
    "/api/v1/clients/onboard",
    clientFields.extend({
      firstMonth: z.object({ period, dueDate: date }).optional(),
    }),
    "建档、授权与首月安排一并保存",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const id = randomUUID();
        await db.query(
          "INSERT INTO companies(id,org_id,name,code,profile,template) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            r.actor.org_id,
            b.name,
            b.code,
            JSON.stringify(b.profile),
            JSON.stringify(b.checklist),
          ],
        );
        await assignDefaults(db, r.actor, id, b, r.id);
        await audit(
          db,
          r.actor,
          "company_created",
          id,
          id,
          { name: b.name, code: b.code },
          r.id,
        );
        const order = b.firstMonth
          ? await createOrder(
              db,
              r.actor,
              {
                companyId: id,
                ...b.firstMonth,
                assigneeId: b.assigneeId,
                reviewerId: b.reviewerId,
              },
              r.id,
            )
          : null;
        return { id, orderId: order?.id || null };
      }),
  );
  post(
    "/api/v1/clients/:id/profile",
    clientFields.extend({ version: z.number().int().positive() }),
    "更新档案及后续月份默认分工",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const c = await one(
          db,
          "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
          [uuid.parse(r.params.id)],
        );
        if (c.version !== b.version)
          fail(409, "客户档案已被修改，请重新打开档案后重试");
        await assignDefaults(db, r.actor, c.id, b, r.id);
        await db.query(
          "UPDATE companies SET name=$1,code=$2,profile=$3,template=$4,version=version+1 WHERE id=$5",
          [
            b.name,
            b.code,
            JSON.stringify(b.profile),
            JSON.stringify(b.checklist),
            c.id,
          ],
        );
        await audit(
          db,
          r.actor,
          "client_updated",
          c.id,
          c.id,
          { name: b.name, code: b.code, checklist: b.checklist },
          r.id,
        );
        return { id: c.id };
      }),
  );
  post(
    "/api/v1/clients/:id/start-month",
    z.object({ version: z.number().int().positive(), period, dueDate: date }),
    "按客户默认分工建立或打开月度工作",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        const c = await one(
          db,
          "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
          [uuid.parse(r.params.id)],
        );
        if (c.version !== b.version)
          fail(409, "客户分工或资料要求已改变，请刷新档案");
        const existing = (
          await db.query(
            "SELECT id FROM work_orders WHERE company_id=$1 AND period=$2",
            [c.id, b.period],
          )
        ).rows[0];
        if (existing) return { ...existing, existing: true };
        if (!c.default_assignee_id || !c.default_reviewer_id)
          fail(400, "请负责人先完善默认经办和复核分工");
        try {
          await membership(db, c.id, c.default_assignee_id);
          await membership(db, c.id, c.default_reviewer_id, true);
        } catch (e: any) {
          if (e.statusCode === 400 || e.statusCode === 404)
            fail(400, "默认分工不可用，请负责人检查账号状态与公司授权");
          throw e;
        }
        return createOrder(
          db,
          r.actor,
          {
            companyId: c.id,
            period: b.period,
            dueDate: b.dueDate,
            assigneeId: c.default_assignee_id,
            reviewerId: c.default_reviewer_id,
          },
          r.id,
        );
      }),
  );
  get(
    "/api/v1/reviews/queue",
    "独立复核、退回跟进、交付与重开队列",
    async (r: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        const q = listQuery
          .extend({
            queue: z
              .enum(["actionable", "review", "returned", "delivery", "reopen"])
              .default("actionable"),
          })
          .parse(r.query);
        const base = `WITH base AS (SELECT w.*,c.name AS company_name,c.code AS company_code,a.name AS assignee_name,r.name AS reviewer_name,s.name AS submitter_name,
  last_review.action AS last_review_action,last_review.reason AS last_review_reason,
  (w.assignee_id<>$4::uuid AND NOT $4::uuid=ANY(w.contributors) AND coalesce(w.submission->>'submittedBy','')<>$4::text AND (w.status<>'archived' OR coalesce(w.reopen_request->>'by','')<>$4::text) AND ($5='owner' OR w.reviewer_id=$4::uuid)) AS independent,
  coalesce(jsonb_array_length(w.submission->'files'),0) AS result_count
  FROM work_orders w JOIN companies c ON c.id=w.company_id LEFT JOIN users a ON a.id=w.assignee_id LEFT JOIN users r ON r.id=w.reviewer_id LEFT JOIN users s ON s.id=(w.submission->>'submittedBy')::uuid
  LEFT JOIN LATERAL (SELECT action,reason FROM reviews WHERE order_id=w.id ORDER BY created_at DESC,id DESC LIMIT 1) last_review ON true
  WHERE w.period=$1 AND (c.name ILIKE $2 OR c.code ILIKE $2) AND ($3::uuid IS NULL OR c.id=$3)),
  filtered AS(SELECT * FROM base WHERE ($6='actionable' AND status='review' AND independent) OR ($6='review' AND status='review') OR ($6='returned' AND status='processing' AND last_review_action='reject') OR ($6='delivery' AND status='delivery') OR ($6='reopen' AND status='archived' AND reopen_request IS NOT NULL))`;
        const p = [
          q.period,
          literalContains(q.search),
          q.companyId || null,
          r.actor.id,
          r.actor.role,
          q.queue,
        ];
        const stats = (
          await db.query(
            `${base} SELECT count(*) FILTER(WHERE status='review' AND independent)::int AS actionable,count(*) FILTER(WHERE status='review')::int AS review,count(*) FILTER(WHERE status='processing' AND last_review_action='reject')::int AS returned,count(*) FILTER(WHERE status='delivery')::int AS delivery,count(*) FILTER(WHERE status='archived' AND reopen_request IS NOT NULL)::int AS reopen,(SELECT count(*)::int FROM filtered) AS total FROM base`,
            p,
          )
        ).rows[0];
        const rows = (
          await db.query(
            `${base} SELECT * FROM filtered ORDER BY due_date,updated_at,id LIMIT $7 OFFSET $8`,
            [...p, q.limit, q.offset],
          )
        ).rows;
        return { rows, ...stats };
      }),
  );
}

export async function submissionReadiness(db: any, o: any) {
  const results = await resultReadiness(db, o);
  let reviewerReady = true;
  try {
    await membership(db, o.company_id, o.reviewer_id, true);
  } catch (e: any) {
    if (e.statusCode === 400 || e.statusCode === 404) reviewerReady = false;
    else throw e;
  }
  const independent =
    !!o.reviewer_id &&
    o.reviewer_id !== o.assignee_id &&
    !o.contributors.includes(o.reviewer_id);
  const items = [
    ...results.items,
    {
      label: "指定复核人员在职、有权限且未参与经办",
      ok: reviewerReady && independent,
    },
    {
      label: "至少一份已回传成果或明确选择人工成果",
      ok: results.taskResultCount > 0,
    },
  ];
  return {
    items,
    manualCandidateCount: results.manualCandidateCount,
    blockingReady: results.blockingReady && reviewerReady && independent,
    ready: items.every((i) => i.ok),
  };
}
