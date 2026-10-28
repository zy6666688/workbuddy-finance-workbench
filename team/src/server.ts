import {
  resultRoutes,
  resultColumns,
  latestResult,
  invalidateInputs,
  invalidateApproval,
  selectedResults,
  assertOriginsResolved,
} from "./results.js";
import { filePageRoutes } from "./file-pages.js";
import { workspaceRoutes } from "./workspace.js";
import { deliveryRead } from "./delivery.js";
import { literalContains } from "./search.js";
import { agencyRoutes, submissionReadiness } from "./agency.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { operationsRoutes, assertStaffChange } from "./operations.js";
import AdmZip from "adm-zip";
import {
  pool,
  tx,
  one,
  company,
  order,
  audit,
  touch,
  editable,
  independent,
  membership,
  storeFile,
  fileBytes,
  storageStats,
  dataRoot,
  fail,
  role,
  writer,
  sha,
  canonical,
  token,
  uuid,
  period,
  date,
  label,
  reason,
  type Actor,
} from "./core.js";
import {
  readTable,
  validateRows,
  templates,
  templateFile,
  reconcile,
} from "./tables.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
import { composeFinanceTask } from "../../src/task-prompt.js";
import { parseFinanceBackup } from "../../src/finance-dashboard-helpers.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}
const versioned = z.object({ version: z.number().int().positive() });
const checklist = z
  .array(z.object({ name: label, required: z.boolean() }))
  .min(1)
  .max(40);
const accountFields = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.@-]{3,100}$/),
  name: label,
  role: z.enum(["owner", "reviewer", "operator", "viewer"]),
  password: z.string().min(12).max(128),
});
const limitQuery = (q: any) => ({
  limit: Math.min(100, Math.max(1, Number(q.limit) || 30)),
  offset: Math.max(0, Math.min(1000000, Number(q.offset) || 0)),
  search: String(q.search || "").slice(0, 100),
});

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.headers.x-csrf-token",
      ],
    },
    bodyLimit: 6 * 1024 * 1024,
    requestTimeout: 30000,
  });
  await app.register(cookie);
  // Authenticated colleagues behind the same reverse proxy each get their own
  // request budget. Anonymous login throttling stays IP based and stricter.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.actor?.id || req.ip,
  });
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
      fields: 12,
      fieldSize: 10000,
    },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "ZY 代账团队 API", version: "3.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "zy_session" },
          csrf: { type: "apiKey", in: "header", name: "x-csrf-token" },
        },
      },
    },
  });
  app.decorateRequest("actor", null as unknown as Actor);
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== (process.env.APP_ORIGIN || "http://localhost:8080")
    )
      fail(403, "请求来源不匹配");
    if (
      !req.url.startsWith("/api/v1/") ||
      req.url.split("?")[0] === "/api/v1/auth/login"
    )
      return;
    const h = sha(req.cookies.zy_session || "");
    const result = await pool.query("SELECT * FROM lookup_session($1)", [h]);
    req.actor = result.rows[0];
    if (!req.actor) fail(401, "请登录");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-csrf-token"] !== req.actor.csrf
    )
      fail(403, "会话校验失败，请重新登录");
    if (
      req.actor.must_change_password &&
      ![
        "/api/v1/auth/me",
        "/api/v1/auth/password",
        "/api/v1/auth/logout",
      ].includes(req.url.split("?")[0])
    )
      fail(403, "请先修改初始密码");
  });
  app.setErrorHandler((e: any, req, reply) => {
    const status =
      e instanceof z.ZodError
        ? 400
        : e.code === "23505"
          ? 409
          : e.code === "23503"
            ? 400
            : e.code === "42501"
              ? 403
              : e.statusCode || 500;
    if (status >= 500)
      req.log.error({ code: e.code, requestId: req.id }, "request failed");
    reply.status(status).send({
      error:
        status >= 500
          ? "服务暂时不可用，请稍后重试"
          : e instanceof z.ZodError
            ? e.issues.map((i) => i.message).join("；")
            : e.code === "23505"
              ? "记录已存在"
              : e.code === "23503"
                ? "关联记录不存在或不属于当前机构"
                : e.code === "42501"
                  ? "无权访问"
                  : e.message,
      requestId: req.id,
    });
  });
  function post(
    url: string,
    schema: z.ZodType,
    summary: string,
    fn: (r: FastifyRequest, b: any) => Promise<any>,
  ) {
    app.post(
      url,
      {
        schema: {
          summary,
          body: z.toJSONSchema(schema, { target: "draft-7" }),
          security: [{ session: [], csrf: [] }],
        },
      },
      (r) => fn(r, schema.parse(r.body)),
    );
  }
  const get = (
    url: string,
    summary: string,
    fn: (r: FastifyRequest) => Promise<any>,
  ) => app.get(url, { schema: { summary, security: [{ session: [] }] } }, fn);
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true, version: "3.0.0" };
  });
  app.post(
    "/api/v1/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        summary: "账号登录",
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", maxLength: 100 },
            password: { type: "string", maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as any;
      const r = await pool.query("SELECT * FROM login_user($1)", [b.username]);
      const u = r.rows[0];
      if (!u || !(await argon2.verify(u.password_hash, b.password)))
        fail(401, "账号或密码错误");
      const s = token(),
        csrf = token();
      await pool.query("SELECT create_session($1,$2,$3)", [sha(s), u.id, csrf]);
      reply.setCookie("zy_session", s, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge: 43200,
      });
      await tx(u, (db) => audit(db, u, "login", u.id, null, {}, req.id));
      return {
        user: {
          id: u.id,
          name: u.name,
          role: u.role,
          must_change_password: u.must_change_password,
        },
        csrf,
      };
    },
  );
  get("/api/v1/auth/me", "当前账号", async (r) => r.actor);
  post("/api/v1/auth/session/logout", z.object({}), "撤销当前设备会话", async (r) =>
    tx(r.actor, async (db) => {
      await db.query("SELECT revoke_current_session($1)", [sha(r.cookies.zy_session || "")]);
      await audit(db, r.actor, "session_revoked", r.actor.id, null, {}, r.id);
      return { ok: true };
    }),
  );
  post("/api/v1/auth/logout", z.object({}), "退出并撤销所有会话", async (r) =>
    tx(r.actor, async (db) => {
      await db.query("SELECT revoke_sessions($1)", [r.actor.id]);
      return { ok: true };
    }),
  );
  post(
    "/api/v1/auth/password",
    z.object({
      current: z.string().max(128),
      password: z.string().min(12).max(128),
    }),
    "修改密码并撤销会话",
    async (r, b) =>
      tx(r.actor, async (db) => {
        const u = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
          r.actor.id,
        ]);
        if (!(await argon2.verify(u.password_hash, b.current)))
          fail(400, "原密码不正确");
        await db.query(
          "UPDATE users SET password_hash=$1,must_change_password=false,version=version+1 WHERE id=$2",
          [await argon2.hash(b.password), u.id],
        );
        await db.query("SELECT revoke_sessions($1)", [u.id]);
        await audit(db, r.actor, "password_changed", u.id, null, {}, r.id);
        return { ok: true };
      }),
  );
  get("/api/v1/users", "员工目录", async (r) =>
    tx(r.actor, async (db) => {
      role(r.actor, "owner", "reviewer");
      return (
        await db.query(
          "SELECT id,username,name,role,active,version FROM users ORDER BY name",
        )
      ).rows;
    }),
  );
  post("/api/v1/users", accountFields, "创建员工", async (r, b) =>
    tx(r.actor, async (db) => {
      role(r.actor, "owner");
      const id = randomUUID();
      await db.query(
        "INSERT INTO users(id,org_id,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          r.actor.org_id,
          b.username,
          b.name,
          b.role,
          await argon2.hash(b.password),
        ],
      );
      await audit(
        db,
        r.actor,
        "user_created",
        id,
        null,
        { name: b.name, role: b.role },
        r.id,
      );
      return { id };
    }),
  );
  post(
    "/api/v1/users/:id",
    versioned.extend({
      active: z.boolean(),
      role: z.enum(["owner", "reviewer", "operator", "viewer"]),
    }),
    "调整角色或停用员工",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const id = uuid.parse((r.params as any).id);
        if (id === r.actor.id) fail(400, "不能修改自己的角色或停用自己");
        await assertStaffChange(db, id, b);
        await one(
          db,
          "UPDATE users SET role=$1,active=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING id",
          [b.role, b.active, id, b.version],
        );
        await db.query("SELECT revoke_sessions($1)", [id]);
        await audit(db, r.actor, "user_changed", id, null, b, r.id);
        return { ok: true };
      }),
  );
  post(
    "/api/v1/users/:id/reset-password",
    z.object({ password: z.string().min(12).max(128) }),
    "重置初始密码",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const id = uuid.parse((r.params as any).id);
        await one(
          db,
          "UPDATE users SET password_hash=$1,must_change_password=true,version=version+1 WHERE id=$2 RETURNING id",
          [await argon2.hash(b.password), id],
        );
        await db.query("SELECT revoke_sessions($1)", [id]);
        await audit(db, r.actor, "password_reset", id, null, {}, r.id);
        return { ok: true };
      }),
  );
  get("/api/v1/companies", "授权客户公司列表", async (r) =>
    tx(r.actor, async (db) => {
      const q = limitQuery(r.query);
      return (
        await db.query(
          "SELECT *,count(*) OVER() AS total FROM companies WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name,id LIMIT $2 OFFSET $3",
          [literalContains(q.search.trim()), q.limit, q.offset],
        )
      ).rows;
    }),
  );
  post(
    "/api/v1/companies",
    z.object({ name: label, code: label }),
    "创建客户公司",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const id = randomUUID();
        await db.query(
          "INSERT INTO companies(id,org_id,name,code) VALUES($1,$2,$3,$4)",
          [id, r.actor.org_id, b.name, b.code],
        );
        await audit(db, r.actor, "company_created", id, id, b, r.id);
        return { id };
      }),
  );
  post(
    "/api/v1/companies/:id/template",
    versioned.extend({ checklist }),
    "修改未来月份的资料模板",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        const c = await one(
          db,
          "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
          [uuid.parse((r.params as any).id)],
        );
        if (c.version !== b.version) fail(409, "模板已更新");
        await db.query(
          "UPDATE companies SET template=$1,version=version+1 WHERE id=$2",
          [JSON.stringify(b.checklist), c.id],
        );
        await audit(db, r.actor, "template_changed", c.id, c.id, b, r.id);
        return { ok: true };
      }),
  );
  get("/api/v1/companies/:id/members", "公司授权成员", async (r) =>
    tx(r.actor, async (db) => {
      const c = await company(db, (r.params as any).id);
      return (
        await db.query(
          "SELECT u.id,u.name,u.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1",
          [c.id],
        )
      ).rows;
    }),
  );
  post(
    "/api/v1/companies/:id/members",
    z.object({ userId: uuid, enabled: z.boolean() }),
    "授予或撤销公司权限",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        const c = await one(
          db,
          "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
          [uuid.parse((r.params as any).id)],
        );
        if (b.enabled)
          await db.query(
            "INSERT INTO memberships(org_id,company_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [r.actor.org_id, c.id, b.userId],
          );
        else
          await db.query(
            "DELETE FROM memberships WHERE company_id=$1 AND user_id=$2",
            [c.id, b.userId],
          );
        await db.query("UPDATE companies SET version=version+1 WHERE id=$1", [
          c.id,
        ]);
        await audit(db, r.actor, "membership_changed", b.userId, c.id, b, r.id);
        return { ok: true };
      }),
  );
  get("/api/v1/orders", "月度工作单与逾期筛选", async (r) =>
    tx(r.actor, (db) => deliveryRead(db, r.actor, r.query)),
  );
  get("/api/v1/orders/overview", "授权范围内月度交付统计", async (r) =>
    tx(r.actor, (db) => deliveryRead(db, r.actor, r.query, true)),
  );
  post(
    "/api/v1/orders",
    z.object({
      companyId: uuid,
      period,
      dueDate: date,
      assigneeId: uuid,
      reviewerId: uuid,
    }),
    "创建月度工作单",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        return createOrder(db, r.actor, b, r.id);
      }),
  );
  get("/api/v1/orders/:id", "工作单详情", async (r) =>
    tx(r.actor, async (db) => {
      const o = await order(db, (r.params as any).id);
      const runs = (
        await db.query(
          "SELECT * FROM runs WHERE order_id=$1 ORDER BY created_at DESC",
          [o.id],
        )
      ).rows;
      const refs = [
        ...new Set([
          ...o.checklist.map((x: any) => x.fileId).filter(Boolean),
          ...(o.submission?.files || []).map((x: any) => x.id),
          ...runs.flatMap((x: any) => x.result_files),
        ]),
      ];
      const files = (
        await db.query(
          `SELECT ${resultColumns} FROM files f LEFT JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 ${(r.query as any).compact === "1" ? "AND f.id=ANY($2::uuid[])" : ""} ORDER BY f.created_at DESC`,
          (r.query as any).compact === "1" ? [o.id, refs] : [o.id],
        )
      ).rows;
      return {
        ...o,
        followups: (
          await db.query(
            "SELECT f.*,u.name AS actor_name FROM material_followups f JOIN users u ON u.id=f.actor_id WHERE f.order_id=$1 ORDER BY f.created_at DESC LIMIT 200",
            [o.id],
          )
        ).rows,
        readiness: await submissionReadiness(db, o),
        assignable: (
          await db.query(
            "SELECT u.id,u.name,u.role FROM users u WHERE u.active AND u.role<>'viewer' AND (u.role='owner' OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=$1 AND m.user_id=u.id)) ORDER BY u.name",
            [o.company_id],
          )
        ).rows,
        ...(await one(
          db,
          "SELECT c.name AS company_name,c.code AS company_code,a.name AS assignee_name,r.name AS reviewer_name FROM companies c LEFT JOIN users a ON a.id=$2 LEFT JOIN users r ON r.id=$3 WHERE c.id=$1",
          [o.company_id, o.assignee_id, o.reviewer_id],
        )),
        activity: (
          await db.query(
            "SELECT e.action,e.created_at,u.name AS actor_name,CASE WHEN e.action='deliver' THEN e.details ELSE '{}'::jsonb END AS delivery FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.company_id=$1 AND e.target_id=$2 ORDER BY e.created_at DESC LIMIT 50",
            [o.company_id, o.id],
          )
        ).rows,
        files,
        runs: runs.map((run: any) => ({
          ...run,
          resultFiles: run.result_files
            .map((id: string) => files.find((f: any) => f.id === id))
            .filter(Boolean),
        })),
        reviews: (
          await db.query(
            "SELECT r.*,u.name AS actor_name FROM reviews r LEFT JOIN users u ON u.id=r.actor_id WHERE r.order_id=$1 ORDER BY r.created_at DESC",
            [o.id],
          )
        ).rows,
      };
    }),
  );
  post(
    "/api/v1/orders/:id/assign",
    versioned.extend({ assigneeId: uuid, reviewerId: uuid, dueDate: date }),
    "调整分工及期限",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        const o = await order(db, (r.params as any).id, b.version);
        editable(o);
        if (b.assigneeId === b.reviewerId)
          fail(400, "经办与复核必须是不同人员");
        if (
          o.contributors.includes(b.reviewerId) ||
          o.assignee_id === b.reviewerId ||
          o.submission?.submittedBy === b.reviewerId
        )
          fail(400, "所选复核人员曾参与本批次经办，请选择另一名人员");
        await membership(db, o.company_id, b.assigneeId);
        await membership(db, o.company_id, b.reviewerId, true);
        await db.query(
          "UPDATE work_orders SET assignee_id=$1,reviewer_id=$2,due_date=$3,contributors=ARRAY(SELECT DISTINCT unnest(contributors||assignee_id)),version=version+1 WHERE id=$4",
          [b.assigneeId, b.reviewerId, b.dueDate, o.id],
        );
        await audit(db, r.actor, "assigned", o.id, o.company_id, b, r.id);
        return { ok: true };
      }),
  );
  post(
    "/api/v1/orders/:id/material",
    versioned.extend({
      index: z.number().int().min(0),
      action: z.enum(["receive", "waive"]),
      fileId: uuid.optional(),
      reason: reason.optional(),
    }),
    "接收或豁免必需材料",
    async (r, b) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await order(db, (r.params as any).id, b.version);
        if (o.status !== "collecting") fail(409, "仅资料收集阶段可调整清单");
        const item = o.checklist[b.index];
        if (!item) fail(400, "清单项不存在");
        if (b.action === "waive") {
          independent(o, r.actor);
          if (!b.reason) fail(400, "豁免必须说明原因");
          item.waiver = {
            by: r.actor.id,
            reason: b.reason,
            at: new Date().toISOString(),
          };
        } else {
          const f = await one(
            db,
            "SELECT id FROM files WHERE id=$1 AND order_id=$2 AND kind='source'",
            [b.fileId, o.id],
          );
          item.fileId = f.id;
        }
        await db.query("UPDATE work_orders SET checklist=$1 WHERE id=$2", [
          JSON.stringify(o.checklist),
          o.id,
        ]);
        await touch(db, o, r.actor, b.action !== "waive");
        await audit(
          db,
          r.actor,
          "material_" + b.action,
          o.id,
          o.company_id,
          b,
          r.id,
        );
        return { ok: true };
      }),
  );
  post(
    "/api/v1/orders/:id/action",
    versioned.extend({
      action: z.enum([
        "finish_collection",
        "start_processing",
        "submit",
        "approve",
        "reject",
        "deliver",
        "request_reopen",
        "reopen",
      ]),
      reason: reason.optional(),
      checks: z
        .object({
          passed: z.boolean(),
          summary: reason,
          unresolved: z.string().max(4000),
        })
        .optional(),
      manualFileIds: z.array(uuid).max(100).default([]),
      delivery: z.object({ channel: label, evidenceFileId: uuid }).optional(),
    }),
    "执行受控流程动作",
    async (r, b) =>
      tx(r.actor, async (db) =>
        transition(
          db,
          r.actor,
          await order(db, (r.params as any).id, b.version),
          b,
          r.id,
        ),
      ),
  );
  const upload = (taskResult: boolean) => async (r: any) => {
    writer(r.actor);
    const q = r.query as any;
    const kind = taskResult
      ? "result"
      : z.enum(["source", "result", "evidence"]).parse(q.kind);
    const origin =
      kind === "result"
        ? taskResult
          ? "workbuddy"
          : z.literal("manual").parse(q.origin)
        : null;
    const runId = taskResult ? uuid.parse(r.params.id) : null;
    const expected = z.coerce.number().int().positive().parse(q.version);
    const category = label.parse(q.category || "其他");
    const uploadKey = q.key === undefined ? null : uuid.parse(q.key);
    const materialIndex =
      q.materialIndex === undefined
        ? undefined
        : z.coerce.number().int().min(0).max(39).parse(q.materialIndex);
    const file = await r.file();
    if (!file) fail(400, "请选择文件");
    const name = file.filename;
    const ext = path.extname(name).toLowerCase();
    if (
      ![
        ".csv",
        ".xlsx",
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".txt",
        ".docx",
      ].includes(ext)
    )
      fail(400, "不支持的文件类型");
    const bytes = await file.toBuffer();
    if (file.file.truncated) fail(413, "文件超过50MB");
    validateFile(bytes, ext);
    const fingerprint = sha(
      canonical({
        name,
        origin,
        runId,
        kind,
        category,
        materialIndex: materialIndex ?? null,
        hash: sha(bytes),
      }),
    );
    return tx(r.actor, async (db) => {
      const ref = taskResult
        ? await one(db, "SELECT order_id FROM runs WHERE id=$1", [runId])
        : null;
      const o = await order(db, ref?.order_id || r.params.id);
      const run = taskResult
        ? await one(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [runId])
        : null;
      if (uploadKey) {
        const previous = (
          await db.query(
            "SELECT id,upload_fingerprint FROM files WHERE order_id=$1 AND uploaded_by=$2 AND upload_key=$3",
            [o.id, r.actor.id, uploadKey],
          )
        ).rows[0];
        if (previous) {
          if (previous.upload_fingerprint !== fingerprint)
            fail(409, "上传标识已用于不同文件，请重新选择文件");
          return {
            id: previous.id,
            orderVersion: o.version,
            runVersion: run?.version,
            replayed: true,
          };
        }
      }
      if ((run ? run.version : o.version) !== expected)
        fail(409, "记录已被修改，请刷新后重试");
      if (
        run &&
        (!run.active ||
          run.status !== "external" ||
          run.input_revision !== o.input_revision ||
          o.status !== "processing")
      )
        fail(409, "只能上传至当前输入版本的外部处理中任务，已回传请创建修订");
      editable(o);
      if (
        materialIndex !== undefined &&
        (kind !== "source" ||
          o.status !== "collecting" ||
          !o.checklist[materialIndex])
      )
        fail(400, "只能在收集阶段为现有资料项上传原件");
      if (kind === "source" && ["review", "delivery"].includes(o.status))
        fail(409, "复核期间不能修改输入资料，请先退回");
      const f = await storeFile(r.actor, o, name, bytes, kind);
      try {
        const v = Number(
          (
            await db.query(
              kind === "result"
                ? "SELECT coalesce(max(f.version),0)+1 AS v FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.name=$2 AND p.origin=$3 AND p.run_id IS NOT DISTINCT FROM $4::uuid"
                : "SELECT coalesce(max(version),0)+1 AS v FROM files WHERE order_id=$1 AND name=$2 AND kind=$3",
              kind === "result"
                ? [o.id, f.name, origin, runId]
                : [o.id, f.name, kind],
            )
          ).rows[0].v,
        );
        await db.query(
          "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version,upload_key,upload_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            f.id,
            r.actor.org_id,
            o.company_id,
            o.id,
            f.name,
            kind,
            category,
            f.size,
            f.hash,
            f.key,
            r.actor.id,
            v,
            uploadKey,
            fingerprint,
          ],
        );
        if (kind === "result") {
          await db.query(
            "INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,'upload',$8)",
            [
              f.id,
              o.org_id,
              o.company_id,
              o.id,
              origin,
              runId,
              o.input_revision,
              r.actor.id,
            ],
          );
          await invalidateApproval(db, o);
          if (run)
            await db.query("UPDATE runs SET version=version+1 WHERE id=$1", [
              run.id,
            ]);
        }
        if (materialIndex !== undefined) {
          o.checklist[materialIndex] = {
            name: o.checklist[materialIndex].name,
            required: o.checklist[materialIndex].required,
            fileId: f.id,
          };
          await db.query("UPDATE work_orders SET checklist=$1 WHERE id=$2", [
            JSON.stringify(o.checklist),
            o.id,
          ]);
          await audit(
            db,
            r.actor,
            "material_receive",
            o.id,
            o.company_id,
            { index: materialIndex, fileId: f.id },
            r.id,
          );
        }
        if (kind === "source") await invalidateInputs(db, o);
        await touch(db, o, r.actor, kind !== "evidence");
        await audit(
          db,
          r.actor,
          "file_uploaded",
          f.id,
          o.company_id,
          { name: f.name, kind, origin, runId, sha256: f.hash },
          r.id,
        );
        return {
          id: f.id,
          orderVersion: o.version + 1,
          runVersion: run ? run.version + 1 : undefined,
        };
      } catch (e) {
        await unlink(path.join(dataRoot, f.key)).catch(() => {});
        throw e;
      }
    });
  };
  app.post(
    "/api/v1/orders/:id/files",
    { schema: { summary: "上传资料、人工成果或证据" } },
    upload(false),
  );
  app.post(
    "/api/v1/runs/:id/files",
    { schema: { summary: "上传明确归属任务的成果" } },
    upload(true),
  );
  app.get(
    "/api/v1/files/:id/download",
    { schema: { summary: "鉴权下载文件" } },
    async (r, reply) =>
      tx(r.actor, async (db) => {
        const f = await one(db, "SELECT * FROM files WHERE id=$1", [
          uuid.parse((r.params as any).id),
        ]);
        if (r.actor.role === "viewer") {
          if (f.kind !== "result")
            fail(403, "只读账号不能下载原始附件或任务包");
          const o = await order(db, f.order_id);
          if (
            !["delivery", "archived"].includes(o.status) ||
            !o.submission?.files.some((x: any) => x.id === f.id)
          )
            fail(403, "只读账号仅可下载当前已复核成果");
        }
        await audit(
          db,
          r.actor,
          "file_downloaded",
          f.id,
          f.company_id,
          {},
          r.id,
        );
        reply
          .type("application/octet-stream")
          .header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          );
        return fileBytes(f);
      }),
  );
  get("/api/v1/workflows", "25个标准工作流", async () =>
    FINANCE_WORKFLOWS.map((w: any) => ({ id: w.id, title: w.title })),
  );
  post(
    "/api/v1/orders/:id/runs",
    versioned.extend({
      workflowId: z.string().max(100),
      taskBrief: z.record(z.string().max(50), z.string().max(2000)).default({}),
      fileIds: z.array(uuid).min(1).max(100),
      key: uuid.optional(),
    }),
    "建立WorkBuddy执行记录",
    async (r, b) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await order(db, (r.params as any).id);
        const fingerprint = sha(
          canonical({
            workflowId: b.workflowId,
            taskBrief: b.taskBrief,
            fileIds: [...b.fileIds].sort(),
          }),
        );
        if (b.key) {
          const previous = (
            await db.query(
              "SELECT id,client_fingerprint FROM runs WHERE order_id=$1 AND created_by=$2 AND client_key=$3",
              [o.id, r.actor.id, b.key],
            )
          ).rows[0];
          if (previous) {
            if (previous.client_fingerprint !== fingerprint)
              fail(409, "任务标识已用于不同输入");
            return { id: previous.id };
          }
        }
        if (o.version !== b.version) fail(409, "记录已被修改，请刷新后重试");
        if (o.status !== "processing") fail(409, "请先进入经办处理阶段");
        if (!FINANCE_WORKFLOWS.some((w: any) => w.id === b.workflowId))
          fail(400, "工作流不存在");
        const fs = (
          await db.query(
            "SELECT f.id,f.name,f.sha256,f.version FROM files f WHERE f.id=ANY($1::uuid[]) AND f.order_id=$2 AND f.kind='source' AND NOT EXISTS(SELECT 1 FROM files n WHERE n.order_id=f.order_id AND n.kind=f.kind AND n.name=f.name AND n.version>f.version)",
            [b.fileIds, o.id],
          )
        ).rows;
        if (fs.length !== new Set(b.fileIds).size)
          fail(400, "输入文件不属于本工作单");
        const id = randomUUID();
        await db.query(
          "INSERT INTO runs(id,org_id,company_id,order_id,workflow_id,input_files,revision,created_by,task_brief,client_key,client_fingerprint,input_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            id,
            r.actor.org_id,
            o.company_id,
            o.id,
            b.workflowId,
            JSON.stringify(fs),
            o.revision,
            r.actor.id,
            JSON.stringify(b.taskBrief),
            b.key || null,
            fingerprint,
            o.input_revision,
          ],
        );
        await touch(db, o, r.actor);
        await audit(db, r.actor, "run_created", id, o.company_id, {}, r.id);
        return { id };
      }),
  );
  post(
    "/api/v1/runs/:id/return",
    versioned.extend({
      resultFileIds: z.array(uuid).min(1).max(100),
      inputHashes: z.record(z.string(), z.string()),
      summary: reason,
    }),
    "回传成果并核对输入版本",
    async (r, b) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(db, "SELECT order_id FROM runs WHERE id=$1", [
          uuid.parse((r.params as any).id),
        ]);
        const o = await order(db, ref.order_id);
        const run = await one(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
          uuid.parse((r.params as any).id),
        ]);
        const hashes = Object.fromEntries(
          run.input_files.map((f: any) => [f.id, f.sha256]),
        );
        if (canonical(hashes) !== canonical(b.inputHashes))
          fail(400, "输入清单与原任务不一致");
        if (
          run.status === "returned" &&
          run.active &&
          run.input_revision === o.input_revision &&
          o.status === "processing" &&
          canonical([...run.result_files].sort()) ===
            canonical([...new Set(b.resultFileIds)].sort()) &&
          run.check_result.summary === b.summary
        )
          return { ok: true, replayed: true };
        if (
          run.version !== b.version ||
          run.status !== "external" ||
          !run.active ||
          run.input_revision !== o.input_revision ||
          o.status !== "processing"
        )
          fail(409, "任务版本或状态已改变，请重新发起");
        if (run.input_files.some((f: any) => b.inputHashes[f.id] !== f.sha256))
          fail(400, "输入清单与原任务不一致");
        const fs = (
          await db.query(
            `SELECT ${resultColumns} FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.id=ANY($2::uuid[]) AND p.origin='workbuddy' AND p.run_id=$3 AND ${latestResult}`,
            [o.id, b.resultFileIds, run.id],
          )
        ).rows;
        if (fs.length !== new Set(b.resultFileIds).size)
          fail(
            400,
            "请选择明确归属本次任务的最新成果，不能复用其他任务或人工成果",
          );
        await db.query(
          "UPDATE runs SET status='returned',result_files=$1,check_result=$2,version=version+1 WHERE id=$3",
          [
            b.resultFileIds,
            JSON.stringify({
              summary: b.summary,
              structuralChecks: true,
              financialReview: "pending",
            }),
            run.id,
          ],
        );
        await touch(db, o, r.actor);
        await audit(
          db,
          r.actor,
          "run_returned",
          run.id,
          o.company_id,
          { results: fs, inputFiles: run.input_files, summary: b.summary },
          r.id,
        );
        return { ok: true };
      }),
  );
  app.get(
    "/api/v1/templates/:kind/:format",
    { schema: { summary: "下载标准CSV或Excel模板" } },
    async (r, reply) => {
      const p = r.params as any;
      const format = z.enum(["csv", "xlsx"]).parse(p.format);
      reply
        .type("application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename="${p.kind}.${format}"`,
        );
      return templateFile(p.kind, format);
    },
  );
  app.post(
    "/api/v1/imports/preview",
    { schema: { summary: "上传CSV/XLSX并预览字段映射与错误" } },
    async (r) => {
      writer(r.actor);
      const q = r.query as any,
        kind = z
          .enum(["companies", "materials", "bank", "ledger", "delivery"])
          .parse(q.kind);
      if (kind === "companies") role(r.actor, "owner");
      const cid = q.companyId ? uuid.parse(q.companyId) : null;
      if (kind !== "companies" && !cid) fail(400, "请选择目标公司");
      const targetPeriod = q.period ? period.parse(q.period) : undefined;
      if (["bank", "ledger"].includes(kind) && !targetPeriod)
        fail(400, "流水与账务导入必须选择期间");
      let mapping: Record<string, string> = {};
      try {
        if (q.mapping)
          mapping = z
            .record(z.string(), z.string())
            .parse(JSON.parse(q.mapping));
      } catch {
        fail(400, "字段映射必须是有效的 JSON 对象");
      }
      const f = await r.file();
      if (!f) fail(400, "请选择表格");
      const rows = await readTable(await f.toBuffer(), f.filename);
      const result = validateRows(kind, rows, mapping, targetPeriod);
      return tx(r.actor, async (db) => {
        const targetCompany = cid ? await company(db, cid) : null;
        if (kind === "materials")
          result.digest = sha(result.digest + ":" + targetCompany.version);
        const id = randomUUID();
        const saved = await db.query(
          "INSERT INTO import_previews(id,org_id,company_id,actor_id,kind,digest,payload,errors) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
          [
            id,
            r.actor.org_id,
            cid,
            r.actor.id,
            kind,
            result.digest,
            JSON.stringify({
              period: targetPeriod,
              templateVersion: targetCompany?.version,
              ...result,
            }),
            JSON.stringify(result.errors),
          ],
        );
        const actual =
          saved.rows[0] ||
          (await one(
            db,
            "SELECT id FROM import_previews WHERE digest=$1 AND kind=$2 AND company_id IS NOT DISTINCT FROM $3",
            [result.digest, kind, cid],
          ));
        return { id: actual.id, ...result };
      });
    },
  );
  post(
    "/api/v1/imports/legacy/preview",
    z.object({ companyId: uuid, backup: z.any() }),
    "旧版备份导入预览",
    async (r, b) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner");
        await company(db, b.companyId);
        const data = parseFinanceBackup(b.backup),
          digest = sha(JSON.stringify(data));
        const id = randomUUID();
        await db.query(
          "INSERT INTO import_previews(id,org_id,company_id,actor_id,kind,digest,payload,errors) VALUES($1,$2,$3,$4,'legacy',$5,$6,'[]') ON CONFLICT DO NOTHING",
          [
            id,
            r.actor.org_id,
            b.companyId,
            r.actor.id,
            digest,
            JSON.stringify(data),
          ],
        );
        const v = await one(
          db,
          "SELECT id FROM import_previews WHERE company_id=$1 AND kind='legacy' AND digest=$2",
          [b.companyId, digest],
        );
        return {
          id: v.id,
          source: "历史导入，不能作为新审批证据",
          todos: data.todos.length,
          snapshots: data.snapshots?.length || 0,
        };
      }),
  );
  post(
    "/api/v1/reconcile",
    z.object({ bankImportId: uuid, ledgerImportId: uuid }),
    "对标准流水与账务表进行唯一匹配",
    async (r, b) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const bank = await one(
          db,
          "SELECT * FROM import_previews WHERE id=$1 AND kind='bank' AND committed_at IS NOT NULL",
          [b.bankImportId],
        );
        const ledger = await one(
          db,
          "SELECT * FROM import_previews WHERE id=$1 AND kind='ledger' AND committed_at IS NOT NULL",
          [b.ledgerImportId],
        );
        if (
          bank.company_id !== ledger.company_id ||
          bank.payload.period !== ledger.payload.period
        )
          fail(400, "两张表必须属于同一公司和期间");
        const result = reconcile(bank.payload.rows, ledger.payload.rows);
        await audit(
          db,
          r.actor,
          "reconciled",
          bank.id,
          bank.company_id,
          { ledgerId: ledger.id, ...result },
          r.id,
        );
        return result;
      }),
  );
  post(
    "/api/v1/jobs",
    z.object({
      kind: z.enum([
        "monthly_batch",
        "import_commit",
        "run_export",
        "delivery_export",
      ]),
      key: z.string().min(8).max(100),
      companyId: uuid.optional(),
      payload: z.any(),
    }),
    "提交可重试后台任务",
    async (r, b) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        if (b.kind === "monthly_batch") role(r.actor, "owner", "reviewer");
        if (b.companyId) await company(db, b.companyId);
        const payload = validateJob(b.kind, b.payload);
        if (["run_export", "delivery_export"].includes(b.kind)) {
          const o =
            b.kind === "run_export"
              ? await one(db, "SELECT order_id FROM runs WHERE id=$1", [
                  payload.runId,
                ])
              : { order_id: payload.orderId };
          const w = await order(db, o.order_id);
          if (w.company_id !== b.companyId) fail(400, "公司不匹配");
          if (b.kind === "delivery_export") {
            if (
              !["delivery", "archived"].includes(w.status) ||
              !w.submission?.at
            )
              fail(409, "只有通过复核的成果可以打包交付");
            await assertOriginsResolved(db, w);
            // Bind the queued request to the approved submission visible now.
            // The worker must never silently export a later approved correction.
            payload.revision = w.revision;
            payload.submittedAt = w.submission.at;
          }
        }
        if (b.kind === "import_commit") {
          const p = await one(
            db,
            "SELECT company_id FROM import_previews WHERE id=$1",
            [payload.importId],
          );
          b.companyId = p.company_id || undefined;
        }
        if (b.kind === "monthly_batch")
          for (const cid of payload.companyIds) await company(db, cid);
        const id = randomUUID();
        await db.query(
          "INSERT INTO jobs(id,org_id,company_id,actor_id,kind,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            id,
            r.actor.org_id,
            b.companyId || null,
            r.actor.id,
            b.kind,
            b.key,
            JSON.stringify(payload),
          ],
        );
        const j = await one(
          db,
          "SELECT * FROM jobs WHERE actor_id=$1 AND kind=$2 AND idempotency_key=$3",
          [r.actor.id, b.kind, b.key],
        );
        if (canonical(j.payload) !== canonical(payload))
          fail(409, "同一请求标识不能提交不同内容");
        return j;
      }),
  );
  post("/api/v1/jobs/:id/retry", z.object({}), "重试失败任务", async (r) =>
    tx(r.actor, async (db) => {
      writer(r.actor);
      const j = await one(
        db,
        "SELECT * FROM jobs WHERE id=$1 AND actor_id=$2 FOR UPDATE",
        [uuid.parse((r.params as any).id), r.actor.id],
      );
      if (j.status !== "failed") fail(409, "只有失败任务可重试");
      await db.query(
        "UPDATE jobs SET status='pending',error=NULL,updated_at=now() WHERE id=$1",
        [j.id],
      );
      await audit(db, r.actor, "job_retry", j.id, j.company_id, {}, r.id);
      return { ok: true };
    }),
  );
  get("/api/v1/jobs", "我的任务及处理状态", async (r) =>
    tx(r.actor, async (db) => {
      const id = (r.query as any).orderId
        ? uuid.parse((r.query as any).orderId)
        : null;
      if (id) await one(db, "SELECT id FROM work_orders WHERE id=$1", [id]);
      return (
        await db.query(
          "SELECT id,kind,status,result,error,created_at,company_id,payload->>'runId' AS run_id FROM jobs WHERE ($1::uuid IS NULL OR payload->>'runId' IN(SELECT id::text FROM runs WHERE order_id=$1)) ORDER BY created_at DESC LIMIT 100",
          [id],
        )
      ).rows;
    }),
  );
  app.get(
    "/api/v1/jobs/:id/download",
    { schema: { summary: "鉴权下载后台生成的任务包" } },
    async (r, reply) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const j = await one(
          db,
          "SELECT * FROM jobs WHERE id=$1 AND status='completed'",
          [uuid.parse((r.params as any).id)],
        );
        if (!j.result?.fileId) fail(404, "此任务没有可下载文件");
        const f = await one(db, "SELECT * FROM files WHERE id=$1", [
          j.result.fileId,
        ]);
        await audit(
          db,
          r.actor,
          "package_downloaded",
          j.id,
          j.company_id,
          {},
          r.id,
        );
        reply
          .type("application/zip")
          .header(
            "Content-Disposition",
            `attachment; filename="${j.kind}-${j.id}.zip"`,
          );
        return fileBytes(f);
      }),
  );
  get("/api/v1/audit", "公司审计记录", async (r) =>
    tx(r.actor, async (db) => {
      const q = r.query as any,
        p = limitQuery(q);
      return (
        await db.query(
          "SELECT id,actor_id,company_id,action,target_id,details,created_at FROM audit_events WHERE ($1::uuid IS NULL OR company_id=$1) ORDER BY id DESC LIMIT $2 OFFSET $3",
          [q.companyId ? uuid.parse(q.companyId) : null, p.limit, p.offset],
        )
      ).rows;
    }),
  );
  get("/api/v1/legacy/:companyId", "历史导入资料", async (r) =>
    tx(r.actor, async (db) => {
      await company(db, (r.params as any).companyId);
      return (
        await db.query(
          "SELECT id,payload,created_at FROM legacy_imports WHERE company_id=$1",
          [(r.params as any).companyId],
        )
      ).rows;
    }),
  );
  get("/api/v1/preferences", "个人偏好", async (r) =>
    tx(
      r.actor,
      async (db) =>
        (
          await db.query(
            "SELECT value || jsonb_build_object('_version',version) AS data FROM user_preferences WHERE user_id=$1",
            [r.actor.id],
          )
        ).rows[0]?.data || {},
    ),
  );
  post(
    "/api/v1/preferences",
    z.object({
      version: z.number().int().min(0),
      theme: z.enum(["indigo", "jade", "sand", "night"]),
      favorites: z.array(z.string().max(100)).max(25),
      recent: z.array(uuid).max(10).default([]),
    }),
    "保存个人偏好",
    async (r, b) =>
      tx(r.actor, async (db) => {
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
          theme: b.theme,
          favorites: b.favorites,
          recent: b.recent,
          desk: { ...old?.value?.desk, theme: b.theme, favorites: b.favorites },
        };
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
        return { ok: true, version: saved.rows[0].version };
      }),
  );
  get("/api/v1/admin/health", "运行、备份和存储状态", async (r) => {
    role(r.actor, "owner");
    let backup: any = { status: "未发现备份记录" };
    try {
      backup = JSON.parse(
        await readFile(
          path.join(process.env.BACKUP_DIR || ".data/backups", "latest.json"),
          "utf8",
        ),
      );
    } catch {}
    return tx(r.actor, async (db) => ({
      storage: await storageStats(),
      backup,
      failedJobs: (
        await db.query(
          "SELECT id,kind,error,actor_id,updated_at FROM jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 30",
        )
      ).rows,
    }));
  });
  get("/api/v1/openapi.json", "接口文档", async () => app.swagger());
  agencyRoutes(get, post, createOrder);
  operationsRoutes(get, post);
  workspaceRoutes(app);
  resultRoutes(get, post);
  filePageRoutes(app);
  await app.register(staticFiles, {
    root: path.resolve(process.env.WEB_DIR || "dist/web"),
    prefix: "/",
    index: "index.html",
  });
  return app;
}

export async function createOrder(
  db: any,
  a: Actor,
  b: any,
  requestId = "worker",
) {
  const c = await company(db, b.companyId);
  if (!c.active) fail(400, "公司已停用");
  if (b.assigneeId === b.reviewerId) fail(400, "经办与复核必须不同");
  await membership(db, c.id, b.assigneeId);
  await membership(db, c.id, b.reviewerId, true);
  const id = randomUUID();
  const r = await db.query(
    "INSERT INTO work_orders(id,org_id,company_id,period,due_date,assignee_id,reviewer_id,checklist,contributors) VALUES($1,$2,$3,$4,$5,$6,$7,$8,ARRAY(SELECT DISTINCT x FROM (SELECT $6::uuid AS x UNION SELECT actor_id FROM audit_events WHERE company_id=$3 AND target_id=$4 AND action='workspace_changed') contributors)) ON CONFLICT(company_id,period) DO NOTHING RETURNING id",
    [
      id,
      a.org_id,
      c.id,
      b.period,
      b.dueDate,
      b.assigneeId,
      b.reviewerId,
      JSON.stringify(c.template),
    ],
  );
  if (r.rows[0]) await audit(db, a, "order_created", id, c.id, b, requestId);
  return (
    r.rows[0] || {
      ...(await one(
        db,
        "SELECT id FROM work_orders WHERE company_id=$1 AND period=$2",
        [c.id, b.period],
      )),
      existing: true,
    }
  );
}
export async function transition(
  db: any,
  a: Actor,
  o: any,
  b: any,
  requestId: string,
) {
  writer(a);
  let next = o.status;
  let details: any = { reason: b.reason || "", revision: o.revision };
  if (b.action === "finish_collection") {
    if (o.status !== "collecting") fail(409, "当前阶段不能结束收集");
    if (o.checklist.some((i: any) => i.required && !i.fileId && !i.waiver))
      fail(400, "必需材料未齐备");
    next = "checking";
  } else if (b.action === "start_processing") {
    if (o.status !== "checking") fail(409, "请先完成资料收集");
    next = "processing";
  } else if (b.action === "submit") {
    if (o.status !== "processing") fail(409, "当前不能提交复核");
    const readiness = await submissionReadiness(db, o);
    if (!readiness.blockingReady)
      fail(
        400,
        readiness.items
          .filter((i) => !i.ok)
          .map((i) => i.label)
          .join("；"),
      );
    if (o.reviewer_id === a.id)
      fail(400, "指定复核人员不能经办送审，请先调整分工");
    if (!b.checks?.passed) fail(400, "需填写并通过校验清单");
    if (b.checks.unresolved.trim()) fail(400, "存在未解决事项，不能提交");
    const results = await selectedResults(db, o, b.manualFileIds || []);
    if (!results.length) fail(400, "请回传任务成果或明确选择人工成果");
    const snapshot = {
      files: results,
      checks: b.checks,
      submittedBy: a.id,
      at: new Date().toISOString(),
      revision: o.revision,
      inputRevision: o.input_revision,
    };
    await db.query(
      "UPDATE work_orders SET submission=$1,contributors=ARRAY(SELECT DISTINCT unnest(contributors||$3::uuid)) WHERE id=$2",
      [JSON.stringify(snapshot), o.id, a.id],
    );
    details = snapshot;
    next = "review";
  } else if (["approve", "reject"].includes(b.action)) {
    if (o.status !== "review") fail(409, "当前不在复核阶段");
    await assertOriginsResolved(db, o);
    independent(o, a);
    if (!b.reason) fail(400, "请填写复核意见");
    await db.query(
      "INSERT INTO reviews(id,org_id,company_id,order_id,revision,actor_id,action,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        a.org_id,
        o.company_id,
        o.id,
        o.revision,
        a.id,
        b.action,
        b.reason,
        JSON.stringify(o.submission),
      ],
    );
    next = b.action === "approve" ? "delivery" : "processing";
    if (b.action === "reject") {
      await db.query(
        "UPDATE runs SET status='stale',version=version+1 WHERE order_id=$1 AND active",
        [o.id],
      );
      await db.query(
        "UPDATE work_orders SET revision=revision+1,submission=NULL WHERE id=$1",
        [o.id],
      );
    }
  } else if (b.action === "deliver") {
    if (o.status !== "delivery" || !b.delivery)
      fail(409, "请先通过复核并补充交付证据");
    await assertOriginsResolved(db, o);
    await one(
      db,
      "SELECT id FROM files WHERE id=$1 AND order_id=$2 AND kind='evidence' AND category<>'系统任务包'",
      [b.delivery.evidenceFileId, o.id],
    );
    details = { ...details, ...b.delivery };
    next = "archived";
  } else if (b.action === "request_reopen") {
    if (o.status !== "archived" || !b.reason) fail(400, "归档重开必须填写理由");
    if (o.reopen_request)
      fail(409, "已有重开申请，等待独立审批，不能覆盖申请记录");
    await db.query("UPDATE work_orders SET reopen_request=$1 WHERE id=$2", [
      JSON.stringify({
        by: a.id,
        reason: b.reason,
        at: new Date().toISOString(),
      }),
      o.id,
    ]);
  } else if (b.action === "reopen") {
    if (o.status !== "archived" || !o.reopen_request || !b.reason)
      fail(400, "需先申请重开并填写审核理由");
    independent(o, a);
    if (o.reopen_request.by === a.id) fail(403, "不能批准自己的重开申请");
    await db.query(
      "UPDATE work_orders SET revision=revision+1,submission=NULL,reopen_request=NULL WHERE id=$1",
      [o.id],
    );
    await db.query(
      "UPDATE runs SET status='stale',version=version+1 WHERE order_id=$1 AND active",
      [o.id],
    );
    next = "processing";
  }
  await db.query(
    "UPDATE work_orders SET status=$1,version=version+1,updated_at=now() WHERE id=$2",
    [next, o.id],
  );
  await audit(db, a, b.action, o.id, o.company_id, details, requestId);
  return { status: next };
}
export function validateFile(bytes: Buffer, ext: string) {
  if ([".xlsx", ".docx"].includes(ext)) {
    if (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
      fail(400, "文件格式不匹配");
    const es = new AdmZip(bytes).getEntries();
    if (
      es.length > 3000 ||
      es.reduce((n, e) => n + e.header.size, 0) > 100 * 1024 * 1024 ||
      es.some((e) => /vbaProject|\.exe$/i.test(e.entryName))
    )
      fail(400, "压缩文档超限或包含活动内容");
  }
  if (ext === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    fail(400, "PDF格式不正确");
  if (bytes.subarray(0, 2).equals(Buffer.from("MZ")))
    fail(400, "不接受可执行文件");
}
export function validateJob(kind: string, p: any): any {
  if (kind === "monthly_batch")
    return z
      .object({
        companyIds: z.array(uuid).min(1).max(2000),
        period,
        dueDate: date,
        assigneeId: uuid,
        reviewerId: uuid,
      })
      .parse(p);
  if (kind === "import_commit") return z.object({ importId: uuid }).parse(p);
  if (kind === "run_export") return z.object({ runId: uuid }).parse(p);
  return z.object({ orderId: uuid }).parse(p);
}
if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  path.basename(process.argv[1]).startsWith("server.")
) {
  const app = await buildServer();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT || 3000) });
  const stop = async () => {
    await app.close();
    await pool.end();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
