import { z } from "zod";
import type { PoolClient } from "pg";
import {
  pool,
  company,
  one,
  uuid,
  period,
  fail,
  sha,
  canonical,
  type Actor,
} from "./core.js";
import { literalContains } from "./search.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";

const booleanQuery = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const pageQuery = z.object({
  period: period.optional(),
  search: z.string().trim().max(200).default(""),
  kind: z.enum(["all", "source", "result", "evidence"]).default("all"),
  origin: z
    .enum([
      "all",
      "workbuddy",
      "manual",
      "excluded",
      "legacy_archive",
      "unassigned",
    ])
    .default("all"),
  fileType: z
    .enum(["all", "sheet", "document", "image", "slides", "other"])
    .default("all"),
  category: z.string().max(200).default(""),
  latestOnly: booleanQuery,
  pinnedOnly: booleanQuery,
  eligibleOnly: booleanQuery,
  runId: uuid.optional(),
  sort: z.enum(["recent", "name", "size"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000000).default(0),
  pageVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

// All summaries, pins and page rows see one database snapshot. A normal READ
// COMMITTED transaction would allow an upload between the version and rows.
async function readSnapshot<T>(
  actor: Actor,
  fn: (db: PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SELECT set_config('zy.actor',$1,true)", [actor.id]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

const typeSql = `CASE lower(regexp_replace(f.name,'^.*\\.',''))
 WHEN 'xls' THEN 'sheet' WHEN 'xlsx' THEN 'sheet' WHEN 'csv' THEN 'sheet' WHEN 'numbers' THEN 'sheet'
 WHEN 'pdf' THEN 'document' WHEN 'doc' THEN 'document' WHEN 'docx' THEN 'document' WHEN 'txt' THEN 'document' WHEN 'md' THEN 'document' WHEN 'rtf' THEN 'document' WHEN 'pages' THEN 'document'
 WHEN 'ppt' THEN 'slides' WHEN 'pptx' THEN 'slides' WHEN 'key' THEN 'slides'
 WHEN 'png' THEN 'image' WHEN 'jpg' THEN 'image' WHEN 'jpeg' THEN 'image' WHEN 'gif' THEN 'image' WHEN 'webp' THEN 'image' WHEN 'svg' THEN 'image' WHEN 'heic' THEN 'image'
 ELSE 'other' END`;
const relativeSql = `f.category||'/'||f.id||'/v'||f.version||'/'||f.name`;
const latestSql = `NOT EXISTS(SELECT 1 FROM files nf LEFT JOIN result_origins nro ON nro.file_id=nf.id
 WHERE nf.order_id=f.order_id AND nf.kind=f.kind AND nf.name=f.name AND nf.version>f.version
 AND (f.kind<>'result' OR (nro.origin IS NOT DISTINCT FROM ro.origin AND nro.run_id IS NOT DISTINCT FROM ro.run_id)))`;

type Scope = {
  companyId: string;
  orderId: string | null;
  period: string;
  pins: string[];
  orders: any[];
};
async function loadScope(
  db: PoolClient,
  actor: Actor,
  mode: "companies" | "orders",
  id: string,
  selectedPeriod?: string,
): Promise<Scope> {
  let companyId: string,
    orderId: string | null = null,
    accountingPeriod: string;
  if (mode === "orders") {
    const o = await one(
      db,
      "SELECT id,company_id,period FROM work_orders WHERE id=$1",
      [uuid.parse(id)],
    );
    companyId = o.company_id;
    orderId = o.id;
    accountingPeriod = o.period;
  } else {
    companyId = uuid.parse(id);
    await company(db, companyId);
    accountingPeriod = period.parse(selectedPeriod);
  }
  const orders = (
    await db.query(
      `SELECT w.id,w.version,w.input_revision,w.status,
        (SELECT md5(string_agg(r.id::text||':'||r.version||':'||r.active||':'||r.status||':'||r.input_revision,',' ORDER BY r.id)) FROM runs r WHERE r.order_id=w.id) AS run_stamp,
        (SELECT count(*)::int FROM result_origins ro WHERE ro.order_id=w.id) AS origin_count
        FROM work_orders w WHERE w.company_id=$1 AND w.period=$2 AND ($3::uuid IS NULL OR w.id=$3) ORDER BY w.id`,
      [companyId, accountingPeriod, orderId],
    )
  ).rows;
  const preference = (
    await db.query(
      "SELECT value->'desk'->'pinnedFiles' AS pins FROM user_preferences WHERE user_id=$1",
      [actor.id],
    )
  ).rows[0];
  const pins = Array.isArray(preference?.pins)
    ? preference.pins.filter((v: any) => typeof v === "string")
    : [];
  return { companyId, orderId, period: accountingPeriod, pins, orders };
}

function baseSql() {
  return `WITH base AS (SELECT f.id,f.org_id,f.company_id,f.order_id,f.name,f.kind,f.category,f.size::double precision AS size,f.sha256,f.version,f.uploaded_by,f.created_at,
    (extract(epoch FROM f.created_at)*1000)::double precision AS "modifiedAt",${relativeSql} AS relative,${typeSql} AS "fileType",
    ro.origin,ro.run_id,ro.input_revision,
    (f.id::text=ANY($4::text[]) OR ${relativeSql}=ANY($4::text[])) AS pinned,
    ($5<>'viewer' OR (f.kind='result' AND w.status IN ('delivery','archived') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(w.submission->'files','[]')) sf WHERE sf->>'id'=f.id::text))) AS "canDownload",
    ($5<>'viewer' AND f.kind='source' AND ${latestSql}) AS "canReference",
    ${latestSql} AS "isLatest",
    ($5<>'viewer' AND ((f.kind='source' AND ${latestSql}) OR (f.kind='evidence' AND f.category<>'系统任务包') OR
      (f.kind='result' AND ro.input_revision=w.input_revision AND
       ((ro.origin='manual' AND ro.run_id IS NULL) OR (ro.origin='workbuddy' AND rr.active AND rr.status='external' AND rr.input_revision=w.input_revision))))) AS eligible
    FROM files f JOIN work_orders w ON w.id=f.order_id LEFT JOIN result_origins ro ON ro.file_id=f.id LEFT JOIN runs rr ON rr.id=ro.run_id
    WHERE f.company_id=$1 AND w.period=$2 AND ($3::uuid IS NULL OR f.order_id=$3))`;
}
const paramsFor = (s: Scope, a: Actor) => [
  s.companyId,
  s.period,
  s.orderId,
  s.pins,
  a.role,
];
function shape(row: any) {
  const { org_id, ...visible } = row;
  return {
    ...visible,
    eligible: Boolean(
      row.eligible && (row.kind === "evidence" || row.isLatest),
    ),
    canDownload: Boolean(row.canDownload),
    canReference: Boolean(row.canReference),
  };
}

export function filePageRoutes(app: any) {
  for (const mode of ["companies", "orders"] as const) {
    const path = `/api/v1/${mode}/:id/files`;
    app.get(
      path + "/page",
      { schema: { summary: "授权范围内文件分页、筛选与完整汇总" } },
      async (r: any) =>
        readSnapshot(r.actor, async (db) => {
          const q = pageQuery.parse(r.query),
            scope = await loadScope(db, r.actor, mode, r.params.id, q.period);
          if (q.offset && !q.pageVersion)
            fail(400, "翻页必须携带当前文件列表版本");
          if (q.runId) {
            const run = await one(
              db,
              "SELECT id,order_id FROM runs WHERE id=$1",
              [q.runId],
            );
            if (!scope.orders.some((o) => o.id === run.order_id))
              fail(404, "任务不属于当前资料范围");
          }
          const base = baseSql(),
            p = paramsFor(scope, r.actor);
          const summary = (
            await db.query(
              `${base} SELECT count(*)::int AS total,coalesce(sum(size),0)::double precision AS bytes,
        count(*) FILTER(WHERE "fileType"='sheet')::int AS sheet,count(*) FILTER(WHERE "fileType"='document')::int AS document,
        count(*) FILTER(WHERE "fileType"='image')::int AS image,count(*) FILTER(WHERE "fileType"='slides')::int AS slides,count(*) FILTER(WHERE "fileType"='other')::int AS other,
        coalesce(array_agg(DISTINCT category ORDER BY category),'{}') AS categories,
        max(created_at)::text AS newest,coalesce(sum(version),0)::text AS revisions FROM base`,
              p,
            )
          ).rows[0];
          const { categories, newest, revisions, ...scopeSummary } = summary;
          const { offset, limit, pageVersion: expected, ...query } = q;
          const pageVersion = sha(
            canonical({
              query,
              actor: r.actor.id,
              role: r.actor.role,
              scope: [scope.companyId, scope.orderId, scope.period],
              orders: scope.orders,
              pins: scope.pins,
              files: [summary.total, summary.bytes, newest, revisions],
            }),
          );
          if (expected && expected !== pageVersion)
            fail(
              409,
              "附件或置顶顺序已变化，请从第一页刷新；已选文件保留待核对",
            );
          const filtered = `${base}, filtered AS(SELECT * FROM base WHERE ($6='all' OR kind=$6) AND ($7='all' OR "fileType"=$7)
        AND ($8='' OR category=$8) AND (name ILIKE $9 OR relative ILIKE $9)
        AND (NOT $10::boolean OR "isLatest") AND (NOT $11::boolean OR pinned)
        AND (NOT $12::boolean OR (eligible AND (kind<>'result' OR "isLatest"))) AND ($13::uuid IS NULL OR run_id=$13)
        AND ($14='all' OR origin=$14 OR ($14='unassigned' AND kind='result' AND origin IS NULL)))`;
          const args = [
            ...p,
            q.kind,
            q.fileType,
            q.category,
            literalContains(q.search),
            q.latestOnly,
            q.pinnedOnly,
            q.eligibleOnly,
            q.runId || null,
            q.origin,
          ];
          const filteredTotal = (
            await db.query(
              `${filtered} SELECT count(*)::int AS n FROM filtered`,
              args,
            )
          ).rows[0].n;
          const sort = {
            recent: "created_at DESC,id DESC",
            name: 'name COLLATE "C",id',
            size: "size DESC,created_at DESC,id DESC",
          }[q.sort];
          const rows = (
            await db.query(
              `${filtered} SELECT * FROM filtered ORDER BY pinned DESC,${sort} LIMIT $15 OFFSET $16`,
              [...args, q.limit, q.offset],
            )
          ).rows.map(shape);
          return {
            rows,
            filteredTotal,
            scopeSummary,
            facets: { categories },
            pageVersion,
            offset: q.offset,
            limit: q.limit,
            hasMore: q.offset + rows.length < filteredTotal,
          };
        }),
    );
    app.post(
      path + "/resolve",
      { schema: { summary: "按固定文件版本解析引用，不依赖当前附件页" } },
      async (r: any) =>
        readSnapshot(r.actor, async (db) => {
          const body = z.object({ ids: z.array(uuid).max(100) }).parse(r.body);
          const scope = await loadScope(
            db,
            r.actor,
            mode,
            r.params.id,
            r.query?.period,
          );
          const ids = [...new Set(body.ids)];
          const rows = (
            await db.query(
              `${baseSql()} SELECT * FROM base WHERE id=ANY($6::uuid[])`,
              [...paramsFor(scope, r.actor), ids],
            )
          ).rows;
          const byId = new Map(rows.map((row) => [row.id, shape(row)]));
          return {
            rows: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)),
            unavailableIds: ids.filter((id) => !byId.has(id)),
          };
        }),
    );
  }
  app.get(
    "/api/v1/companies/:id/files/suggestions",
    { schema: { summary: "从本期完整资料范围匹配工作流输入建议" } },
    async (r: any) =>
      readSnapshot(r.actor, async (db) => {
        const q = z
          .object({ period, workflowId: z.string().max(100) })
          .parse(r.query);
        const workflow = FINANCE_WORKFLOWS.find(
          (w: any) => w.id === q.workflowId,
        );
        if (!workflow) fail(404, "工作流不存在");
        const scope = await loadScope(
          db,
          r.actor,
          "companies",
          r.params.id,
          q.period,
        );
        const keywords = (workflow.keywords || [])
          .map((s: string) => s.trim().toLocaleLowerCase("zh-CN"))
          .filter(Boolean);
        const sql = `${baseSql()}, scored AS(SELECT *,
      (SELECT count(*) FROM unnest($6::text[]) keyword WHERE position(keyword in lower(name||' '||relative))>0)*10+
      CASE WHEN "fileType"=ANY($7::text[]) THEN 1 ELSE 0 END AS score FROM base WHERE kind='source' AND "isLatest"),
      matched AS(SELECT * FROM scored WHERE score>=CASE WHEN cardinality($6::text[])>0 THEN 10 ELSE 1 END)
      SELECT *,count(*) OVER()::int AS match_total FROM matched ORDER BY score DESC,"modifiedAt" DESC,id LIMIT 8`;
        const rows = (
          await db.query(sql, [
            ...paramsFor(scope, r.actor),
            keywords,
            workflow.fileKinds || [],
          ])
        ).rows;
        return {
          rows: rows.map(({ match_total, score, ...row }) => shape(row)),
          total: rows[0]?.match_total || 0,
        };
      }),
  );
}
