import { assertOriginsResolved } from "./results.js";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { fileURLToPath } from "node:url";
import {
  pool,
  tx,
  one,
  company,
  order,
  role,
  writer,
  audit,
  storeFile,
  fileBytes,
  fail,
  type Actor,
} from "./core.js";
import { createOrder } from "./server.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
import { composeFinanceTask } from "../../src/task-prompt.js";
import { calculateEmbedded } from "./embedded-workflows.js";

export async function processJob(actor: Actor, id: string) {
  return tx(actor, async (db) => {
    const j = await one(db, "SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [id]);
    if (j.status === "completed") return j.result;
    writer(actor);
    await db.query(
      "UPDATE jobs SET status='running',error=NULL,updated_at=now() WHERE id=$1",
      [j.id],
    );
    let result: any = {};
    if (j.kind === "monthly_batch") {
      role(actor, "owner", "reviewer");
      let created = 0;
      for (const companyId of j.payload.companyIds) {
        const r = await createOrder(db, actor, { ...j.payload, companyId });
        if (r.id && !r.existing) created++;
      }
      result = { created, total: j.payload.companyIds.length };
    } else if (j.kind === "import_commit") {
      const p = await one(
        db,
        "SELECT * FROM import_previews WHERE id=$1 FOR UPDATE",
        [j.payload.importId],
      );
      if (p.errors.length) fail(400, "导入存在错误，不能提交");
      if (p.company_id) await company(db, p.company_id);
      if (p.committed_at) result = { alreadyCommitted: true };
      else {
        if (p.kind === "companies") {
          role(actor, "owner");
          for (const row of p.payload.rows)
            await db.query(
              "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,code) DO NOTHING",
              [randomUUID(), actor.org_id, row.code, row.name],
            );
        }
        if (p.kind === "legacy") {
          role(actor, "owner");
          await db.query(
            "INSERT INTO legacy_imports(id,org_id,company_id,actor_id,payload) VALUES($1,$2,$3,$4,$5)",
            [
              p.id,
              actor.org_id,
              p.company_id,
              actor.id,
              JSON.stringify(p.payload),
            ],
          );
        }
        if (p.kind === "materials") {
          role(actor, "owner", "reviewer");
          const target = await one(
            db,
            "SELECT version FROM companies WHERE id=$1 FOR UPDATE",
            [p.company_id],
          );
          if (target.version !== p.payload.templateVersion)
            fail(409, "资料模板已被修改，请重新预览后提交");
          await db.query(
            "UPDATE companies SET template=$1,version=version+1 WHERE id=$2",
            [
              JSON.stringify(
                p.payload.rows.map((r: any) => ({
                  name: r.category,
                  required: r.required === "true",
                })),
              ),
              p.company_id,
            ],
          );
        }
        await db.query(
          "UPDATE import_previews SET committed_at=now() WHERE id=$1",
          [p.id],
        );
        await audit(db, actor, "import_committed", p.id, p.company_id, {
          kind: p.kind,
          count: p.payload.count || 0,
        });
        result = { importId: p.id, count: p.payload.count || 0 };
      }
    } else if (["run_export", "delivery_export", "embedded_accounting", "embedded_rules"].includes(j.kind)) {
      let o: any,
        run: any,
        files: any[],
        zip = new AdmZip();
      if (j.kind !== "delivery_export") {
        run = await one(db, "SELECT * FROM runs WHERE id=$1", [
          j.payload.runId,
        ]);
        o = await order(db, run.order_id);
        if (!(await company(db, o.company_id)).active) fail(409, "客户已停用，任务停止处理");
        run = await one(db, "SELECT * FROM runs WHERE id=$1", [run.id]);
        if (
          run.status !== "external" ||
          !run.active ||
          run.input_revision !== o.input_revision ||
          o.status !== "processing"
        )
          fail(409, "任务输入或状态已改变");
        files = (
          await db.query(
            "SELECT * FROM files WHERE id=ANY($1::uuid[]) AND order_id=$2",
            [run.input_files.map((f: any) => f.id), o.id],
          )
        ).rows;
        if (
          files.length !== run.input_files.length ||
          run.input_files.some(
            (x: any) =>
              !files.some(
                (f: any) =>
                  f.id === x.id &&
                  f.sha256 === x.sha256 &&
                  f.version === x.version,
              ),
          )
        )
          fail(409, "任务输入快照不一致");
        const workflow = FINANCE_WORKFLOWS.find(
          (w: any) => w.id === run.workflow_id,
        );
        if (!workflow) fail(400, "工作流不存在");
        zip.addFile(
          "任务说明.md",
          Buffer.from(
            `# 任务 ${run.id}\n公司编号：${o.company_id}\n期间：${o.period}\n\n${composeFinanceTask({ ...workflow, taskBrief: run.task_brief })}\n\n将成果及校验说明上传回原任务。不得直接改变系统状态。`,
          ),
        );
        zip.addFile(
          "return-manifest.json",
          Buffer.from(
            JSON.stringify(
              {
                runId: run.id,
                schemaVersion: 2,
                inputRevision: run.input_revision,
                inputHashes: Object.fromEntries(
                  run.input_files.map((f: any) => [f.id, f.sha256]),
                ),
                summary: "请填写处理规则、金额/行数校验及未解决事项",
              },
              null,
              2,
            ),
          ),
        );
        zip.addFile(
          "校验清单.csv",
          Buffer.from(
            "\uFEFF检查项,结果,说明\r\n输入行数,,\r\n输出行数,,\r\n来源金额合计,,\r\n结果金额合计,,\r\n未解决异常,,\r\n",
          ),
        );
        if (["embedded_accounting", "embedded_rules"].includes(j.kind)) {
          if (o.company_id !== j.company_id) fail(403, "任务公司不匹配");
          const calculated = await calculateEmbedded(db, o, run, files);
          for (const output of calculated.files) zip.addFile(`outputs/${output.name}`, output.bytes);
          result.calculation = calculated.metadata;
        }
      } else {
        o = await order(db, j.payload.orderId);
        if (!["delivery", "archived"].includes(o.status))
          fail(409, "只有通过复核的成果可以打包交付");
        if (
          j.payload.revision !== o.revision ||
          !j.payload.submittedAt ||
          j.payload.submittedAt !== o.submission?.at
        )
          fail(409, "交付版本已变化或任务缺少版本信息，请重新生成交付包");
        await assertOriginsResolved(db, o);
        files = (
          await db.query(
            "SELECT * FROM files WHERE id=ANY($1::uuid[]) AND order_id=$2",
            [o.submission.files.map((f: any) => f.id), o.id],
          )
        ).rows;
        if (
          files.length !== o.submission.files.length ||
          o.submission.files.some(
            (x: any) =>
              !files.some(
                (f: any) =>
                  f.id === x.id &&
                  f.sha256 === x.sha256 &&
                  f.version === x.version,
              ),
          )
        )
          fail(409, "交付快照不一致");
        zip.addFile(
          "交付清单.json",
          Buffer.from(
            JSON.stringify(
              {
                orderId: o.id,
                period: o.period,
                revision: o.revision,
                submission: o.submission,
              },
              null,
              2,
            ),
          ),
        );
      }
      if (o.company_id !== j.company_id) fail(403, "任务公司不匹配");
      if (files.reduce((n, f) => n + Number(f.size), 0) > 200 * 1024 * 1024)
        fail(413, "单次打包不能超过200MB，请拆分任务");
      for (const f of files)
        zip.addFile(
          `${j.kind !== "delivery_export" ? "inputs" : "results"}/${f.id}-${f.name}`,
          await fileBytes(f),
        );
      zip.addFile(
        "manifest.json",
        Buffer.from(
          JSON.stringify(
            {
              companyId: o.company_id,
              period: o.period,
              orderId: o.id,
              runId: run?.id,
              files: files.map((f) => ({
                id: f.id,
                name: f.name,
                sha256: f.sha256,
                version: f.version,
                ...(j.kind === "delivery_export"
                  ? {
                      origin:
                        o.submission.files.find((x: any) => x.id === f.id)
                          ?.origin || "legacy_unrecorded",
                      runId:
                        o.submission.files.find((x: any) => x.id === f.id)
                          ?.run_id || null,
                    }
                  : {}),
              })),
            },
            null,
            2,
          ),
        ),
      );
      const f = await storeFile(
        actor,
        o,
        `${j.kind}-${j.id}.zip`,
        zip.toBuffer(),
        "evidence",
      );
      await db.query(
        "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) VALUES($1,$2,$3,$4,$5,'evidence','系统任务包',$6,$7,$8,$9,1)",
        [
          f.id,
          actor.org_id,
          o.company_id,
          o.id,
          f.name,
          f.size,
          f.hash,
          f.key,
          actor.id,
        ],
      );
      result = { ...result, fileId: f.id };
    }
    await db.query(
      "UPDATE jobs SET status='completed',result=$1,error=NULL,updated_at=now() WHERE id=$2",
      [JSON.stringify(result), j.id],
    );
    await audit(db, actor, "job_completed", j.id, j.company_id, {
      kind: j.kind,
      result,
    });
    return result;
  });
}

export async function runWorker() {
  const queueUrl = process.env.QUEUE_DATABASE_URL;
  if (!queueUrl) throw new Error("QUEUE_DATABASE_URL is required");
  const control = new Pool({ connectionString: queueUrl, max: 3 });
  const boss = new PgBoss({ connectionString: queueUrl, schema: "pgboss" });
  boss.on("error", (e) => console.error("queue error", e.message));
  await boss.start();
  await boss.createQueue("team-job", {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 600,
  });
  await boss.work("team-job", { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { id: string; actor_id: string };
      try {
        const r = await control.query("SELECT * FROM worker_actor($1)", [
          data.actor_id,
        ]);
        if (!r.rows[0]) fail(403, "账号已停用");
        await processJob(r.rows[0], data.id);
      } catch (e: any) {
        await control.query("SELECT fail_job($1,$2)", [
          data.id,
          e.statusCode ? e.message : "后台处理失败，请重试",
        ]);
        throw e;
      }
    }
  });
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const p = await control.query("SELECT * FROM pending_jobs()");
      for (const j of p.rows)
        await boss.send("team-job", j, { singletonKey: j.id });
    } catch (e: any) {
      console.error("dispatch error", e.message);
    } finally {
      dispatching = false;
    }
  };
  await dispatch();
  const timer = setInterval(dispatch, 3000);
  const stop = async () => {
    clearInterval(timer);
    await boss.stop();
    await control.end();
    await pool.end();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log("team worker ready");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runWorker();
