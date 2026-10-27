import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  tx,
  one,
  order,
  editable,
  writer,
  audit,
  touch,
  fail,
  uuid,
  reason,
  canonical,
} from "./core.js";

export const resultColumns = `f.id,f.name,f.kind,f.category,f.size,f.sha256,f.version,f.uploaded_by,f.created_at,p.origin,p.run_id,p.input_revision AS origin_input_revision`;
export const latestResult = `NOT EXISTS(SELECT 1 FROM files n JOIN result_origins np ON np.file_id=n.id WHERE n.order_id=f.order_id AND n.kind='result' AND n.name=f.name AND n.version>f.version AND np.origin=p.origin AND np.run_id IS NOT DISTINCT FROM p.run_id)`;
export async function unresolvedCount(db: any, orderId: string) {
  return (
    await db.query(
      "SELECT count(*)::int AS n FROM files f LEFT JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.kind='result' AND p.file_id IS NULL",
      [orderId],
    )
  ).rows[0].n;
}
export async function assertOriginsResolved(db: any, o: any) {
  if (await unresolvedCount(db, o.id))
    fail(409, "存在历史成果归属待确认，请先明确任务、人工或仅留档，再重新送审");
}
export async function invalidateInputs(db: any, o: any) {
  await db.query(
    "UPDATE work_orders SET input_revision=input_revision+1,revision=revision+1 WHERE id=$1",
    [o.id],
  );
  await db.query(
    "UPDATE runs SET status='stale',version=version+1 WHERE order_id=$1 AND active AND status<>'cancelled'",
    [o.id],
  );
}
export async function invalidateApproval(db: any, o: any) {
  if (["review", "delivery"].includes(o.status))
    await db.query(
      "UPDATE work_orders SET status='processing',revision=revision+1,submission=NULL WHERE id=$1",
      [o.id],
    );
}
export async function selectedResults(
  db: any,
  o: any,
  manualFileIds: string[] = [],
) {
  const ids = [...new Set(manualFileIds)];
  const manual = (
    await db.query(
      `SELECT ${resultColumns} FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.id=ANY($2::uuid[]) AND p.origin='manual' AND p.input_revision=$3 AND ${latestResult}`,
      [o.id, ids, o.input_revision],
    )
  ).rows;
  if (manual.length !== ids.length)
    fail(400, "人工成果必须明确选择本期输入版本下的最新人工文件");
  const task = (
    await db.query(
      `SELECT ${resultColumns},r.version AS run_version FROM files f JOIN result_origins p ON p.file_id=f.id JOIN runs r ON r.id=p.run_id WHERE f.order_id=$1 AND p.origin='workbuddy' AND r.active AND r.status='returned' AND r.input_revision=$2 AND f.id=ANY(r.result_files) AND ${latestResult}`,
      [o.id, o.input_revision],
    )
  ).rows;
  return [...task, ...manual];
}
export async function resultReadiness(db: any, o: any) {
  const runs = (
    await db.query(
      "SELECT id,status,input_revision,result_files FROM runs WHERE order_id=$1 AND active",
      [o.id],
    )
  ).rows;
  const pending = await unresolvedCount(db, o.id);
  const manualCandidateCount = (
    await db.query(
      `SELECT count(*)::int n FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND p.origin='manual' AND p.input_revision=$2 AND ${latestResult}`,
      [o.id, o.input_revision],
    )
  ).rows[0].n;
  const selected = await selectedResults(db, o);
  const blockedRuns = runs.filter(
    (r: any) =>
      r.status !== "returned" || r.input_revision !== o.input_revision,
  );
  // A returned receipt must still refer to exactly its own latest file versions.
  const invalidReceipt = runs.some(
    (r: any) =>
      r.status === "returned" &&
      r.result_files.some(
        (id: string) =>
          !selected.some((f: any) => f.id === id && f.run_id === r.id),
      ),
  );
  return {
    pending,
    manualCandidateCount,
    taskResultCount: selected.length,
    blockingReady: !pending && !blockedRuns.length && !invalidReceipt,
    items: [
      { label: "历史成果归属已确认", ok: pending === 0 },
      {
        label: "任务已回传，失效任务已修订或明确取消",
        ok: blockedRuns.length === 0 && !invalidReceipt,
      },
    ],
  };
}
export function resultRoutes(get: any, post: any) {
  get(
    "/api/v1/orders/:id/result-origins",
    "历史成果归属待确认",
    async (r: any) =>
      tx(r.actor, async (db) => {
        const o = await order(db, r.params.id);
        const q = z
          .object({
            limit: z.coerce.number().int().min(1).max(100).default(50),
            offset: z.coerce.number().int().min(0).default(0),
          })
          .parse(r.query);
        const rows = (
          await db.query(
            `SELECT ${resultColumns},coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'workflow_id',x.workflow_id,'status',x.status,'active',x.active,'priorReference',f.id=ANY(x.result_files))) FROM runs x WHERE x.order_id=f.order_id AND x.active AND (x.status='external' OR (x.status='returned' AND f.id=ANY(x.result_files)))),'[]') AS "candidateRuns" FROM files f LEFT JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.kind='result' AND p.file_id IS NULL ORDER BY f.created_at,f.id LIMIT $2 OFFSET $3`,
            [o.id, q.limit, q.offset],
          )
        ).rows;
        return {
          rows,
          total: await unresolvedCount(db, o.id),
          orderVersion: o.version,
          canResolve: r.actor.role === "owner" || o.assignee_id === r.actor.id,
        };
      }),
  );
  post(
    "/api/v1/orders/:id/result-origins",
    z.object({
      version: z.number().int().positive(),
      reason,
      assignments: z
        .array(
          z.object({
            fileId: uuid,
            origin: z.enum(["workbuddy", "manual", "excluded"]),
            runId: uuid.optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    "确认历史成果归属",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await order(db, r.params.id, b.version);
        editable(o);
        if (r.actor.role !== "owner" && o.assignee_id !== r.actor.id)
          fail(403, "仅负责人或本期经办可确认历史成果归属");
        if (
          new Set(b.assignments.map((x: any) => x.fileId)).size !==
          b.assignments.length
        )
          fail(400, "成果编号重复");
        for (const a of b.assignments) {
          const file = await one(
            db,
            "SELECT id,name FROM files WHERE id=$1 AND order_id=$2 AND kind='result'",
            [a.fileId, o.id],
          );
          if (
            a.origin !== "excluded" &&
            (
              await db.query(
                "SELECT 1 FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.name=$2 AND p.origin=$3 AND p.run_id IS NOT DISTINCT FROM $4::uuid LIMIT 1",
                [o.id, file.name, a.origin, a.runId || null],
              )
            ).rowCount
          )
            fail(
              409,
              "目标来源已有同名成果，不能将旧版本并入该来源；请将旧文件仅留档或确认其他独立执行",
            );
          if ((a.origin === "workbuddy") !== !!a.runId)
            fail(400, "任务成果必须指定执行，人工成果不能关联执行");
          const run = a.runId
            ? await one(db, "SELECT * FROM runs WHERE id=$1 AND order_id=$2", [
                a.runId,
                o.id,
              ])
            : null;
          if (
            run &&
            (!run.active ||
              (run.status !== "external" &&
                !(
                  run.status === "returned" &&
                  run.result_files.includes(file.id)
                )))
          )
            fail(
              409,
              "仅可确认到外部处理中任务，或明确引用该文件的既有回执；失效任务请先修订",
            );
          await db.query(
            "INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,'manual_resolution',$8,$9)",
            [
              a.fileId,
              o.org_id,
              o.company_id,
              o.id,
              a.origin,
              a.runId || null,
              run?.input_revision || o.input_revision,
              r.actor.id,
              b.reason,
            ],
          );
        }
        await invalidateApproval(db, o);
        await touch(db, o, r.actor);
        await audit(
          db,
          r.actor,
          "result_origins_confirmed",
          o.id,
          o.company_id,
          b,
          r.id,
        );
        return { ok: true, orderVersion: o.version + 1 };
      }),
  );
  post(
    "/api/v1/runs/:id/cancel",
    z.object({ version: z.number().int().positive(), reason }),
    "取消执行并保留记录",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(db, "SELECT order_id FROM runs WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const o = await order(db, ref.order_id);
        editable(o);
        const run = await one(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
          r.params.id,
        ]);
        if (run.version !== b.version || !run.active)
          fail(409, "任务已变化，请刷新");
        await db.query(
          "UPDATE runs SET active=false,status='cancelled',version=version+1 WHERE id=$1",
          [run.id],
        );
        await invalidateApproval(db, o);
        await touch(db, o, r.actor);
        await audit(
          db,
          r.actor,
          "run_cancelled",
          run.id,
          o.company_id,
          { reason: b.reason, receipt: run },
          r.id,
        );
        return { ok: true };
      }),
  );
  post(
    "/api/v1/runs/:id/revise",
    z.object({
      version: z.number().int().positive(),
      reason,
      fileIds: z.array(uuid).min(1).max(100).optional(),
      key: uuid,
    }),
    "创建新的修订执行",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(db, "SELECT order_id FROM runs WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const o = await order(db, ref.order_id);
        editable(o);
        const run = await one(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
          r.params.id,
        ]);
        const fingerprint = canonical({
          supersedes: run.id,
          reason: b.reason,
          fileIds: b.fileIds ? [...new Set(b.fileIds)].sort() : null,
        });
        const replay = (
          await db.query(
            "SELECT id,client_fingerprint FROM runs WHERE order_id=$1 AND created_by=$2 AND client_key=$3",
            [o.id, r.actor.id, b.key],
          )
        ).rows[0];
        if (replay) {
          if (replay.client_fingerprint !== fingerprint)
            fail(409, "修订标识已用于不同内容");
          return { id: replay.id };
        }
        if (run.version !== b.version || !run.active)
          fail(409, "任务已变化或已被修订");
        if (o.status === "collecting" || o.status === "checking")
          fail(409, "请先进入经办处理");
        if (run.input_revision !== o.input_revision && !b.fileIds)
          fail(400, "输入资料已变化，请重新选择输入文件");
        const ids = b.fileIds || run.input_files.map((x: any) => x.id);
        const fs = (
          await db.query(
            "SELECT f.id,f.name,f.sha256,f.version FROM files f WHERE f.id=ANY($1::uuid[]) AND f.order_id=$2 AND f.kind='source' AND NOT EXISTS(SELECT 1 FROM files n WHERE n.order_id=f.order_id AND n.kind=f.kind AND n.name=f.name AND n.version>f.version)",
            [ids, o.id],
          )
        ).rows;
        if (fs.length !== new Set(ids).size) fail(400, "输入不属于当前工作单");
        const id = randomUUID();
        await db.query(
          "INSERT INTO runs(id,org_id,company_id,order_id,workflow_id,input_files,revision,input_revision,created_by,task_brief,client_key,client_fingerprint,supersedes_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            id,
            o.org_id,
            o.company_id,
            o.id,
            run.workflow_id,
            JSON.stringify(fs),
            o.revision + (["review", "delivery"].includes(o.status) ? 1 : 0),
            o.input_revision,
            r.actor.id,
            JSON.stringify(run.task_brief),
            b.key,
            fingerprint,
            run.id,
          ],
        );
        await db.query(
          "UPDATE runs SET active=false,version=version+1 WHERE id=$1",
          [run.id],
        );
        await invalidateApproval(db, o);
        await touch(db, o, r.actor);
        await audit(
          db,
          r.actor,
          "run_revised",
          run.id,
          o.company_id,
          { newRunId: id, reason: b.reason },
          r.id,
        );
        return { id };
      }),
  );
}
