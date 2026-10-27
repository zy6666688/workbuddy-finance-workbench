import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import argon2 from "argon2";
import { buildServer } from "../src/server.js";
import { pool } from "../src/core.js";
import { processJob } from "../src/worker.js";

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

test(
  "delivery audit: a restarted WorkBuddy task cannot reuse an earlier round's result",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      cid = randomUUID();
    await admin!.query("INSERT INTO organizations VALUES($1,$2)", [
      org,
      "月度交付专项合成机构",
    ]);
    const password = "Synthetic-Audit!2026",
      hash = await argon2.hash(password);
    const users: Record<string, any> = {};
    for (const [name, role] of [
      ["owner", "owner"],
      ["op", "operator"],
      ["review", "reviewer"],
    ]) {
      const id = randomUUID(),
        username = "delivery_audit_" + id;
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
        [id, org, username, name, hash, role],
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      assert.equal(login.statusCode, 200, login.body);
      users[name] = {
        id,
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
        csrf: login.json().csrf,
      };
    }
    await admin!.query(
      "INSERT INTO companies(id,org_id,code,name,template) VALUES($1,$2,$3,$4,$5)",
      [
        cid,
        org,
        cid,
        "虚构审计客户",
        JSON.stringify([{ name: "银行流水", required: true }]),
      ],
    );
    for (const key of ["op", "review"])
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        cid,
        users[key].id,
      ]);
    async function req(
      who: string,
      path: string,
      payload?: any,
      expected = 200,
    ) {
      const r = await app.inject({
        method: payload === undefined ? "GET" : "POST",
        url: "/api/v1" + path,
        headers: { cookie: users[who].cookie, "x-csrf-token": users[who].csrf },
        payload,
      });
      assert.equal(r.statusCode, expected, who + " " + path + ": " + r.body);
      return r.json();
    }
    const oid = (
      await req("owner", "/orders", {
        companyId: cid,
        period: "2026-10",
        dueDate: "2026-11-10",
        assigneeId: users.op.id,
        reviewerId: users.review.id,
      })
    ).id;
    const detail = () => req("op", "/orders/" + oid);
    async function action(
      who: string,
      name: string,
      extra: any = {},
      expected = 200,
    ) {
      return req(
        who,
        `/orders/${oid}/action`,
        { version: (await detail()).version, action: name, ...extra },
        expected,
      );
    }
    async function upload(
      kind: string,
      filename: string,
      body: string,
      materialIndex?: number,
    ) {
      const boundary = "AuditBoundary",
        d = await detail();
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${oid}/files?kind=${kind}&version=${d.version}${materialIndex === undefined ? "" : "&materialIndex=" + materialIndex}`,
        headers: {
          cookie: users.op.cookie,
          "x-csrf-token": users.op.csrf,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--${boundary}--\r\n`,
        ),
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().id;
    }
    const source = await upload(
      "source",
      "bank.csv",
      "date,amount\n2026-10-01,100.00",
      0,
    );
    await action("op", "finish_collection");
    await action("op", "start_processing");
    const workflowId = (await req("op", "/workflows"))[0].id;
    async function startRun() {
      const created = await req("op", `/orders/${oid}/runs`, {
        version: (await detail()).version,
        workflowId,
        fileIds: [source],
      });
      return (await detail()).runs.find((r: any) => r.id === created.id);
    }
    function receipt(run: any, resultId: string) {
      return {
        version: run.version,
        resultFileIds: [resultId],
        inputHashes: Object.fromEntries(
          run.input_files.map((f: any) => [f.id, f.sha256]),
        ),
        summary: "虚构数据核对100.00，无未解决事项",
      };
    }
    const firstRun = await startRun();
    const oldResult = await upload("result", "result.txt", "first round");
    await req(
      "op",
      `/runs/${firstRun.id}/return`,
      receipt(firstRun, oldResult),
    );
    const checks = {
      passed: true,
      summary: "合成测试核对完成",
      unresolved: "",
    };
    await action("op", "submit", { checks });
    await action("review", "reject", { reason: "请补充逐笔核对说明" });
    const freshRun = await startRun();
    // Previous implementation accepted this latest-by-name file even though it
    // belongs to the rejected round and predates the new execution record.
    await req(
      "op",
      `/runs/${freshRun.id}/return`,
      receipt(freshRun, oldResult),
      400,
    );
    const before = await detail();
    assert.equal(
      before.runs.find((r: any) => r.id === freshRun.id).status,
      "external",
    );
    const freshResult = await upload(
      "result",
      "result.txt",
      "second round: itemized checks",
    );
    await req(
      "op",
      `/runs/${freshRun.id}/return`,
      receipt(freshRun, freshResult),
    );
    await action("op", "submit", { checks });
    await action("op", "approve", { reason: "不得自审" }, 403);
    const d = await detail();
    const approvals = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: `/api/v1/orders/${oid}/action`,
          headers: {
            cookie: users.review.cookie,
            "x-csrf-token": users.review.csrf,
          },
          payload: {
            version: d.version,
            action: "approve",
            reason: "独立核对通过",
          },
        }),
      ),
    );
    assert.deepEqual(approvals.map((r) => r.statusCode).sort(), [200, 409]);
    assert.deepEqual(
      (await detail()).submission.files.map((f: any) => f.id),
      [freshResult],
    );
    const requestedExport = await req("op", "/jobs", {
      kind: "delivery_export",
      key: randomUUID(),
      companyId: cid,
      payload: { orderId: oid },
    });
    // Failed clones are not dispatched by the live worker. They retain exactly
    // the API-produced payload so retry behavior can be checked deterministically.
    async function queuedClone(payload: any) {
      const id = randomUUID();
      await admin!.query(
        "INSERT INTO jobs(id,org_id,company_id,actor_id,kind,status,idempotency_key,payload) VALUES($1,$2,$3,$4,'delivery_export','failed',$5,$6)",
        [id, org, cid, users.op.id, id, JSON.stringify(payload)],
      );
      return id;
    }
    const delayedExport = await queuedClone(requestedExport.payload);
    const evidence = await upload("evidence", "receipt.txt", "虚构交付证据");
    await action("op", "deliver", {
      delivery: { channel: "测试", evidenceFileId: evidence },
    });
    await action("op", "request_reopen", { reason: "虚构更正" });
    await action("op", "reopen", { reason: "不允许自行审批" }, 403);
    await action("review", "reopen", { reason: "准予更正并重新复核" });
    const reopenedRun = await startRun();
    await req(
      "op",
      `/runs/${reopenedRun.id}/return`,
      receipt(reopenedRun, freshResult),
      400,
    );
    assert.equal((await detail()).status, "processing");
    const thirdResult = await upload(
      "result",
      "result.txt",
      "third round: approved correction",
    );
    await req(
      "op",
      `/runs/${reopenedRun.id}/return`,
      receipt(reopenedRun, thirdResult),
    );
    await action("op", "submit", { checks });
    await action("review", "approve", { reason: "更正后的成果独立复核通过" });
    const actor = { id: users.op.id, org_id: org, role: "operator" } as any;
    await assert.rejects(
      processJob(actor, delayedExport),
      (e: any) => e.statusCode === 409,
    );
    assert.equal(
      (
        await admin!.query(
          "SELECT count(*)::int AS n FROM files WHERE name=$1",
          [`delivery_export-${delayedExport}.zip`],
        )
      ).rows[0].n,
      0,
    );
    const legacy = await queuedClone({ orderId: oid });
    await assert.rejects(
      processJob(actor, legacy),
      (e: any) => e.statusCode === 409,
    );
    const currentExport = await req("op", "/jobs", {
      kind: "delivery_export",
      key: randomUUID(),
      companyId: cid,
      payload: { orderId: oid },
    });
    const currentClone = await queuedClone(currentExport.payload);
    assert.ok((await processJob(actor, currentClone)).fileId);
  },
);
