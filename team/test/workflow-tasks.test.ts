import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import argon2 from "argon2";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildServer } from "../src/server.js";
import { pool, dataRoot, sha } from "../src/core.js";
import { workflowProgress } from "../src/workflow-tasks.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
const enabled = process.env.TEAM_TEST_ACCEPT === "1";
const admin = enabled
  ? new Pool({ connectionString: process.env.ADMIN_DATABASE_URL })
  : null;
let app: Awaited<ReturnType<typeof buildServer>>;
after(async () => {
  await app?.close();
  await pool.end();
  await admin?.end();
});

test("progress never mistakes a ready package or unrelated approval for completed work", () => {
  const run = {
    id: "run",
    active: true,
    status: "external",
    input_revision: 1,
    result_files: [],
  };
  const order = { input_revision: 1, status: "processing" };
  const job = { id: "job", status: "completed", result: { fileId: "zip" } };
  assert.equal(workflowProgress(run, order, job).state, "ready");
  assert.equal(
    workflowProgress(run, { ...order, input_revision: 2 }, job).state,
    "stale",
  );
  assert.equal(
    workflowProgress({ ...run, active: false }, order, job).state,
    "cancelled",
  );
  const returned = { ...run, status: "returned", result_files: ["result"] };
  assert.equal(
    workflowProgress(returned, { ...order, status: "archived" }, job).state,
    "returned",
  );
  for (const status of ["review", "delivery", "archived"])
    assert.equal(
      workflowProgress(
        returned,
        {
          ...order,
          status,
          submission: { files: [{ id: "result", run_id: "run" }] },
        },
        job,
      ).state,
      status,
    );
  assert.equal(workflowProgress(run, order, null).state, "unavailable");
  assert.equal(
    workflowProgress(run, order, { status: "failed" }).state,
    "failed",
  );
});

test(
  "one-call start is atomic, duplicate-safe, persistent and company scoped",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      other = randomUUID(),
      company = randomUUID(),
      op = randomUUID(),
      viewer = randomUUID(),
      outsider = randomUUID();
    const password = "Synthetic-Test!2026",
      hash = await argon2.hash(password);
    await admin!.query(
      "INSERT INTO organizations VALUES($1,'虚构任务机构'),($2,'另一任务机构')",
      [org, other],
    );
    for (const [id, oid, role] of [
      [op, org, "operator"],
      [viewer, org, "viewer"],
      [outsider, other, "owner"],
    ])
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$3,$4,$5,false)",
        [id, oid, id, hash, role],
      );
    await admin!.query(
      "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,'虚构任务客户')",
      [company, org, company],
    );
    for (const id of [op, viewer])
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        company,
        id,
      ]);
    const order = randomUUID(),
      file = randomUUID();
    await admin!.query(
      "INSERT INTO work_orders(id,org_id,company_id,period,status,due_date,checklist,assignee_id) VALUES($1,$2,$3,'2026-10','processing','2026-11-01','[]',$4)",
      [order, org, company, op],
    );
    const storageKey = randomUUID();
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, storageKey), "", { flag: "wx" });
    await admin!.query(
      "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) VALUES($1,$2,$3,$4,'虚构.txt','source','other',0,$5,$6,$7,1)",
      [file, org, company, order, sha(""), storageKey, op],
    );
    async function login(id: string) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: id, password },
      });
      assert.equal(r.statusCode, 200, r.body);
      return {
        cookie: r.headers["set-cookie"]!.toString().split(";")[0],
        "x-csrf-token": r.json().csrf,
      };
    }
    const s = await login(op),
      v = await login(viewer),
      o = await login(outsider);
    const url = `/api/v1/orders/${order}/workflow-tasks`;
    const body = {
      version: 1,
      workflowId: FINANCE_WORKFLOWS[0].id,
      fileIds: [file],
      key: randomUUID(),
      taskBrief: { requirements: "虚构资料测试" },
    };
    const post = (headers: any, payload = body) =>
      app.inject({ method: "POST", url, headers, payload });
    assert.equal((await post(v)).statusCode, 403);
    assert.equal((await post(o)).statusCode, 404);
    const pair = await Promise.all([post(s), post(s)]);
    for (const r of pair) assert.equal(r.statusCode, 200, r.body);
    const task = pair[0].json();
    assert.equal(task.runId, pair[1].json().runId);
    assert.equal(task.package.id, pair[1].json().package.id);
    assert.equal(task.state, "queued");
    assert.equal(
      (
        await admin!.query(
          "SELECT count(*)::int n FROM runs WHERE order_id=$1",
          [order],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await admin!.query(
          "SELECT count(*)::int n FROM jobs WHERE company_id=$1",
          [company],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await post(s, { ...body, taskBrief: { requirements: "不同需求" } }))
        .statusCode,
      409,
    );
    const statusUrl = `/api/v1/workflow-tasks/${task.runId}`;
    assert.equal(
      (await app.inject({ url: statusUrl, headers: o })).statusCode,
      404,
    );
    const seen = await app.inject({ url: statusUrl, headers: v });
    assert.equal(seen.statusCode, 200, seen.body);
    assert.equal(seen.json().package, null);
    // Exercise the real rollback boundary by making the job insert fail after the run insert.
    const trigger = "workflow_test_" + org.replaceAll("-", "");
    await admin!.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${company}'::uuid THEN RAISE EXCEPTION 'synthetic enqueue failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      assert.equal(
        (await post(s, { ...body, version: 2, key: randomUUID() })).statusCode,
        500,
      );
    } finally {
      await admin!.query(
        `DROP TRIGGER ${trigger} ON jobs; DROP FUNCTION ${trigger}()`,
      );
    }
    assert.equal(
      (
        await admin!.query(
          "SELECT count(*)::int n FROM runs WHERE order_id=$1",
          [order],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await admin!.query("SELECT version FROM work_orders WHERE id=$1", [
          order,
        ])
      ).rows[0].version,
      2,
    );
    await app.close();
    app = await buildServer();
    await app.ready();
    assert.equal(
      (await app.inject({ url: statusUrl, headers: s })).json().runId,
      task.runId,
    );
    await admin!.query(
      "UPDATE jobs SET status='failed',error='虚构打包失败' WHERE id=$1",
      [task.package.id],
    );
    assert.equal((await post(s)).json().state, "failed");
    await admin!.query(
      "UPDATE work_orders SET input_revision=input_revision+1 WHERE id=$1",
      [order],
    );
    assert.equal(
      (await app.inject({ url: statusUrl, headers: s })).json().state,
      "stale",
    );
    await admin!.query(
      "DELETE FROM memberships WHERE company_id=$1 AND user_id=$2",
      [company, op],
    );
    assert.equal((await post(s)).statusCode, 404);
    assert.equal(
      (await app.inject({ url: statusUrl, headers: s })).statusCode,
      404,
    );
  },
);
