import AdmZip from "adm-zip";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readProgress } from "./workflow-tasks.js";
import {
  tx,
  one,
  order,
  company,
  writer,
  fail,
  uuid,
  reason,
  fileBytes,
  storeFile,
  touch,
  audit,
  canonical,
  dataRoot,
} from "./core.js";

async function calculation(db: any, run: any, o: any) {
  const job = await one(
    db,
    "SELECT * FROM jobs WHERE kind IN ('embedded_accounting','embedded_rules') AND actor_id=$1 AND idempotency_key=$2",
    [run.created_by, `workflow-task:${run.id}`],
  );
  if (job.status !== "completed" || !job.result?.fileId)
    fail(409, "后台计算尚未完成，请先查询任务进度");
  const file = await one(
    db,
    "SELECT * FROM files WHERE id=$1 AND order_id=$2 AND kind='evidence'",
    [job.result.fileId, o.id],
  );
  const zip = new AdmZip(await fileBytes(file));
  const outputNames = [
    "计算结果与异常.json",
    job.kind === "embedded_rules" ? "工作流处理结果.xlsx" : "财务核对底稿.xlsx",
    "计算说明.md",
  ];
  const outputs = outputNames.map((name) => {
    const entry = zip.getEntry(`outputs/${name}`);
    if (!entry || entry.header.size > 50 * 1024 * 1024)
      fail(409, "计算成果包不完整或过大");
    return { name, bytes: entry!.getData() };
  });
  const data = JSON.parse(outputs[0].bytes.toString("utf8"));
  if (
    data.runId !== run.id ||
    data.workflowId !== run.workflow_id ||
    data.executor !== run.execution_mode ||
    data.companyId !== o.company_id ||
    data.inputRevision !== run.input_revision ||
    !Array.isArray(data.report?.issues) ||
    data.issueCount !== data.report.issues.length
  )
    fail(409, "计算成果与任务快照不一致");
  return { job, outputs, data };
}

export function calculationRoutes(get: any, post: any) {
  get(
    "/api/v1/workflow-tasks/:id/calculation",
    "分页读取内嵌计算摘要及异常",
    async (r: any) =>
      tx(r.actor, async (db) => {
        const q = z
          .object({
            section: z
              .enum(["summary", "issues", "trial", "rows"])
              .default("summary"),
            offset: z.coerce.number().int().min(0).max(1000000).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .parse(r.query);
        const run = await one(db, "SELECT * FROM runs WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
          run.order_id,
        ]);
        const { job, data } = await calculation(db, run, o);
        const { report, ...metadata } = data;
        const rows = q.section === "summary" ? [] : report[q.section] || [];
        return {
          runId: run.id,
          runVersion: run.version,
          jobId: job.id,
          stale:
            !run.active ||
            run.input_revision !== o.input_revision ||
            !(await company(db, o.company_id)).active,
          metadata,
          availableSections:
            job.kind === "embedded_rules"
              ? ["summary", "issues", "rows"]
              : ["summary", "issues", "trial"],
          section: q.section,
          total: rows.length,
          offset: q.offset,
          rows: rows.slice(q.offset, q.offset + q.limit),
          financialReview: "pending",
        };
      }),
  );
  post(
    "/api/v1/workflow-tasks/:id/return-calculation",
    z
      .object({
        version: z.number().int().positive(),
        jobId: uuid,
        summary: reason,
      })
      .strict(),
    "将内嵌计算成果和经办说明回传原任务",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(db, "SELECT order_id FROM runs WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const o = await order(db, ref.order_id);
        const run = await one(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
          r.params.id,
        ]);
        if (
          !run.active ||
          run.input_revision !== o.input_revision ||
          !(await company(db, o.company_id)).active
        )
          fail(409, "输入或客户状态已变化，请修订任务");
        if (
          run.status === "returned" &&
          run.check_result?.jobId === b.jobId &&
          run.check_result?.summary === b.summary
        )
          return {
            ok: true,
            replayed: true,
            runId: run.id,
            resultFileIds: run.result_files,
            checkResult: run.check_result,
            progress: await readProgress(db, run.id),
            posted: false,
          };
        if (
          run.status !== "external" ||
          run.version !== b.version ||
          o.status !== "processing"
        )
          fail(409, "任务版本或阶段已变化，请刷新");
        const { job, outputs, data } = await calculation(db, run, o);
        if (job.id !== b.jobId) fail(409, "计算任务编号不一致");
        const input = (
          await db.query(
            "SELECT id,sha256,version FROM files WHERE order_id=$1 AND id=ANY($2::uuid[])",
            [o.id, run.input_files.map((f: any) => f.id)],
          )
        ).rows;
        if (
          run.input_files.some(
            (f: any) =>
              !input.some(
                (n: any) =>
                  n.id === f.id &&
                  n.sha256 === f.sha256 &&
                  n.version === f.version,
              ),
          )
        )
          fail(409, "原始资料快照不一致");
        outputs.push({ name: "经办说明.txt", bytes: Buffer.from(b.summary) });
        const ids: string[] = [];
        const storedKeys: string[] = [];
        try {
          for (const output of outputs) {
            const f = await storeFile(
              r.actor,
              o,
              output.name,
              output.bytes,
              "result",
            );
            storedKeys.push(f.key);
            const v = await one(
              db,
              "SELECT coalesce(max(f.version),0)+1 AS n FROM files f JOIN result_origins p ON p.file_id=f.id WHERE f.order_id=$1 AND f.name=$2 AND p.run_id=$3",
              [o.id, f.name, run.id],
            );
            await db.query(
              "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) VALUES($1,$2,$3,$4,$5,'result','内嵌计算成果',$6,$7,$8,$9,$10)",
              [
                f.id,
                r.actor.org_id,
                o.company_id,
                o.id,
                f.name,
                f.size,
                f.hash,
                f.key,
                r.actor.id,
                v.n,
              ],
            );
            await db.query(
              "INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method,actor_id,reason) VALUES($1,$2,$3,$4,'workbuddy',$5,$6,'upload',$7,$8)",
              [
                f.id,
                r.actor.org_id,
                o.company_id,
                o.id,
                run.id,
                run.input_revision,
                r.actor.id,
                "内嵌计算原件及经办说明回传",
              ],
            );
            ids.push(f.id);
          }
          const checkResult = {
            summary: b.summary,
            jobId: job.id,
            executor: job.kind,
            structuralChecks: true,
            financialReview: "pending",
            unresolvedIssues: data.issueCount,
          };
          await db.query(
            "UPDATE runs SET status='returned',result_files=$1,check_result=$2,version=version+1 WHERE id=$3",
            [ids, canonical(checkResult), run.id],
          );
          await touch(db, o, r.actor);
          await audit(
            db,
            r.actor,
            "calculation_returned",
            run.id,
            o.company_id,
            { jobId: job.id, fileIds: ids, issueCount: data.issueCount },
            r.id,
          );
          return {
            ok: true,
            runId: run.id,
            resultFileIds: ids,
            checkResult,
            progress: await readProgress(db, run.id),
            posted: false,
          };
        } catch (error) {
          // Only this transaction's newly generated blobs; never remove committed receipts.
          await Promise.allSettled(
            storedKeys.map((key) => unlink(path.join(dataRoot, key))),
          );
          throw error;
        }
      }),
  );
}
