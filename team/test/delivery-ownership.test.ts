import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import argon2 from "argon2";
import AdmZip from "adm-zip";
import { buildServer } from "../src/server.js";
import { pool, tx } from "../src/core.js";
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
  "delivery ownership: parallel tasks, explicit manual selection, immutable receipts, revisions and legacy resolution",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      cid = randomUUID(),
      password = "Synthetic-Ownership!2026",
      hash = await argon2.hash(password),
      users: any = {};
    await admin!.query("INSERT INTO organizations VALUES($1,$2)", [
      org,
      "成果归属专项虚构机构",
    ]);
    for (const [key, role] of [
      ["owner", "owner"],
      ["op", "operator"],
      ["review", "reviewer"],
      ["viewer", "viewer"],
    ]) {
      const id = randomUUID(),
        username = "ownership_" + id;
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
        [id, org, username, key, hash, role],
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      assert.equal(login.statusCode, 200, login.body);
      users[key] = {
        id,
        org_id: org,
        role,
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
        "虚构所有权客户",
        JSON.stringify([{ name: "流水", required: true }]),
      ],
    );
    for (const key of ["op", "review", "viewer"])
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        cid,
        users[key].id,
      ]);
    async function req(
      path: string,
      payload?: any,
      expected = 200,
      who = "op",
    ) {
      const s = users[who],
        r = await app.inject({
          method: payload === undefined ? "GET" : "POST",
          url: "/api/v1" + path,
          headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
          payload,
        });
      assert.equal(r.statusCode, expected, path + ": " + r.body);
      return r.json();
    }
    const oid = (
      await req(
        "/orders",
        {
          companyId: cid,
          period: "2026-10",
          dueDate: "2026-11-10",
          assigneeId: users.op.id,
          reviewerId: users.review.id,
        },
        200,
        "owner",
      )
    ).id;
    const detail = () => req("/orders/" + oid + "?compact=1");
    const action = async (
      name: string,
      extra: any = {},
      expected = 200,
      who = "op",
    ) =>
      req(
        "/orders/" + oid + "/action",
        { version: (await detail()).version, action: name, ...extra },
        expected,
        who,
      );
    async function upload(
      kind: string,
      name: string,
      runId?: string,
      expected = 200,
    ) {
      const d = await detail(),
        version = runId
          ? d.runs.find((r: any) => r.id === runId).version
          : d.version,
        boundary = "OwnershipBoundary";
      const r = await app.inject({
        method: "POST",
        url: runId
          ? `/api/v1/runs/${runId}/files?version=${version}&key=${randomUUID()}`
          : `/api/v1/orders/${oid}/files?kind=${kind}&origin=manual&version=${version}&key=${randomUUID()}${kind === "source" && d.status === "collecting" ? "&materialIndex=0" : ""}`,
        headers: {
          cookie: users.op.cookie,
          "x-csrf-token": users.op.csrf,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nsynthetic ${randomUUID()}\r\n--${boundary}--\r\n`,
        ),
      });
      assert.equal(r.statusCode, expected, r.body);
      return r.json().id;
    }
    const source = await upload("source", "bank.txt");
    await action("finish_collection");
    await action("start_processing");
    const workflowId = (await req("/workflows"))[0].id;
    const start = async (ids = [source], expected = 200) =>
      req(
        "/orders/" + oid + "/runs",
        {
          version: (await detail()).version,
          workflowId,
          fileIds: ids,
          key: randomUUID(),
        },
        expected,
      );
    const run = async (id: string) =>
      (await detail()).runs.find((r: any) => r.id === id);
    const returned = async (
      id: string,
      ids: string[],
      expected = 200,
      summary = "已核对",
    ) => {
      const r = await run(id);
      return req(
        "/runs/" + id + "/return",
        {
          version: r.version,
          resultFileIds: ids,
          inputHashes: Object.fromEntries(
            r.input_files.map((f: any) => [f.id, f.sha256]),
          ),
          summary,
        },
        expected,
      );
    };
    const a = (await start()).id,
      b = (await start()).id;
    async function packageManifest(runId: string) {
      const j = await req("/jobs", {
        kind: "run_export",
        key: randomUUID(),
        companyId: cid,
        payload: { runId },
      });
      await processJob(users.op, j.id);
      const response = await app.inject({
        url: "/api/v1/jobs/" + j.id + "/download",
        headers: { cookie: users.op.cookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      return JSON.parse(
        new AdmZip(response.rawPayload).readAsText("return-manifest.json"),
      );
    }
    const initialManifest = await packageManifest(a);
    const af = await upload("result", "same.txt", a);
    assert.deepEqual(
      await packageManifest(a),
      initialManifest,
      "upload version changes must not change immutable input manifest",
    );
    assert.equal(initialManifest.schemaVersion, 2);
    assert.equal(initialManifest.version, undefined);

    await returned(a, [af]);
    const bf = await upload("result", "same.txt", b);
    assert.equal(
      (await run(a)).status,
      "returned",
      "parallel upload must not invalidate A",
    );
    assert.equal(
      (await run(a)).input_revision,
      (await detail()).input_revision,
    );
    await returned(b, [af], 400);
    await returned(b, [bf]);
    assert.equal((await run(a)).resultFiles[0].id, af);
    assert.equal((await run(a)).resultFiles[0].version, 1);
    assert.equal((await run(b)).resultFiles[0].version, 1);
    await upload("result", "late.txt", a, 409);
    await returned(a, [af], 409, "changed receipt");
    await returned(a, [af]); // exact receipt replay is safe
    const manual = await upload("result", "same.txt");
    const checks = { passed: true, summary: "合成核对", unresolved: "" };
    await action("submit", { checks });
    assert.deepEqual(
      new Set((await detail()).submission.files.map((f: any) => f.id)),
      new Set([af, bf]),
      "unselected manual draft cannot enter review",
    );
    await action("reject", { reason: "修订" }, 200, "review");
    const revise = async (id: string, ids?: string[]) =>
      req("/runs/" + id + "/revise", {
        version: (await run(id)).version,
        key: randomUUID(),
        reason: "修订",
        ...(ids ? { fileIds: ids } : {}),
      });
    const a2 = (await revise(a)).id;
    await req("/runs/" + b + "/cancel", {
      version: (await run(b)).version,
      reason: "本期不用",
    });
    const a2f = await upload("result", "same.txt", a2);
    await returned(a2, [a2f]);
    await action("submit", { checks, manualFileIds: [bf] }, 400);
    await action("submit", { checks, manualFileIds: [manual] });
    assert.deepEqual(
      new Set((await detail()).submission.files.map((f: any) => f.id)),
      new Set([a2f, manual]),
    );
    assert.equal((await run(a)).active, false);
    assert.deepEqual((await run(a)).result_files, [af]);
    await action("approve", { reason: "独立核对" }, 200, "review");
    const draft = await upload("result", "another-manual.txt");
    assert.equal((await detail()).status, "processing");
    assert.equal(
      (await run(a2)).status,
      "returned",
      "manual upload invalidates approval, not input receipt",
    );
    const source2 = await upload("source", "bank.txt");
    assert.equal((await run(a2)).status, "stale");
    await action("submit", { checks, manualFileIds: [manual] }, 400);
    await start([source], 400);
    await req(
      "/runs/" + a2 + "/revise",
      {
        version: (await run(a2)).version,
        key: randomUUID(),
        reason: "输入已变",
      },
      400,
    );
    const a3 = (await revise(a2, [source2])).id;
    const a3f = await upload("result", "same.txt", a3);
    await returned(a3, [a3f]);
    await action("submit", { checks, manualFileIds: [manual] }, 400);
    const currentManual = await upload("result", "same.txt");
    // Simulate a pre-migration result with zero explicit task references.
    const collision = await upload("result", "same.txt");
    await admin!.query("DELETE FROM result_origins WHERE file_id=$1", [
      collision,
    ]);
    await req(
      "/orders/" + oid + "/result-origins",
      {
        version: (await detail()).version,
        reason: "同名不能覆盖",
        assignments: [{ fileId: collision, origin: "workbuddy", runId: a3 }],
      },
      409,
    );
    await req("/orders/" + oid + "/result-origins", {
      version: (await detail()).version,
      reason: "旧草稿留档",
      assignments: [{ fileId: collision, origin: "excluded" }],
    });
    const legacy = draft; // Created under the older input generation, requiring explicit provenance confirmation.
    await admin!.query("DELETE FROM result_origins WHERE file_id=$1", [legacy]);
    assert.equal((await detail()).readiness.blockingReady, false);
    const pending = await req("/orders/" + oid + "/result-origins");
    assert.equal(pending.total, 1);
    assert.equal(pending.canResolve, true);
    assert.equal(
      pending.rows[0].candidateRuns.some((r: any) => r.id === a3),
      false,
    );
    await req(
      "/orders/" + oid + "/result-origins",
      {
        version: (await detail()).version,
        reason: "仅留存",
        assignments: [{ fileId: legacy, origin: "excluded" }],
      },
      403,
      "review",
    );
    await req(
      "/orders/" + oid + "/result-origins",
      {
        version: (await detail()).version,
        reason: "不能改写已回传记录",
        assignments: [{ fileId: legacy, origin: "workbuddy", runId: a3 }],
      },
      409,
    );
    const legacyRun = (await start([source2])).id;
    await req("/orders/" + oid + "/result-origins", {
      version: (await detail()).version,
      reason: "根据人工核对明确此旧文件归属新任务",
      assignments: [{ fileId: legacy, origin: "workbuddy", runId: legacyRun }],
    });
    const legacyAudit = (
      await admin!.query(
        "SELECT details FROM audit_events WHERE target_id=$1 AND action='result_origins_confirmed' ORDER BY created_at DESC LIMIT 1",
        [oid],
      )
    ).rows[0];
    assert.equal(
      legacyAudit.details.reason,
      "根据人工核对明确此旧文件归属新任务",
    );
    assert.equal(legacyAudit.details.assignments[0].runId, legacyRun);
    await returned(legacyRun, [legacy]);
    await req("/runs/" + legacyRun + "/cancel", {
      version: (await run(legacyRun)).version,
      reason: "仅保留人工确认记录，不参加本次交付",
    });
    await assert.rejects(
      tx(users.op, (db) =>
        db.query("UPDATE result_origins SET origin='manual' WHERE file_id=$1", [
          legacy,
        ]),
      ),
      (e: any) => e.code === "42501",
    );
    await action("submit", { checks, manualFileIds: [currentManual] });
    await action("approve", { reason: "独立核对" }, 200, "review");
    const j = await req("/jobs", {
      kind: "delivery_export",
      key: randomUUID(),
      companyId: cid,
      payload: { orderId: oid },
    });
    await processJob(users.op, j.id);
    const download = await app.inject({
      url: "/api/v1/jobs/" + j.id + "/download",
      headers: { cookie: users.op.cookie },
    });
    assert.equal(download.statusCode, 200, download.body);
    const manifest = JSON.parse(
      new AdmZip(download.rawPayload).readAsText("manifest.json"),
    );
    assert.deepEqual(
      new Set(manifest.files.map((f: any) => f.id)),
      new Set([a3f, currentManual]),
    );
    assert.equal(manifest.files.find((f: any) => f.id === a3f).runId, a3);
    assert.equal(
      manifest.files.find((f: any) => f.id === currentManual).origin,
      "manual",
    );
    await admin!.query(
      "UPDATE work_orders SET submission=jsonb_set(submission,'{files}',(SELECT jsonb_agg(x-'origin'-'run_id'-'run_version'-'origin_input_revision') FROM jsonb_array_elements(submission->'files') x)) WHERE id=$1",
      [oid],
    );
    const oldSnapshot = (await detail()).submission;
    const legacyJob = await req("/jobs", {
      kind: "delivery_export",
      key: randomUUID(),
      companyId: cid,
      payload: { orderId: oid },
    });
    await processJob(users.op, legacyJob.id);
    const legacyDownload = await app.inject({
      url: "/api/v1/jobs/" + legacyJob.id + "/download",
      headers: { cookie: users.op.cookie },
    });
    assert.equal(legacyDownload.statusCode, 200, legacyDownload.body);
    const legacyManifest = JSON.parse(
      new AdmZip(legacyDownload.rawPayload).readAsText("manifest.json"),
    );
    assert.ok(
      legacyManifest.files.every((f: any) => f.origin === "legacy_unrecorded"),
    );
    assert.deepEqual(
      (await detail()).submission,
      oldSnapshot,
      "export does not rewrite old approvals",
    );
    assert.equal((await detail()).status, "delivery");
    const evidence = await upload("evidence", "receipt.txt");
    await action("deliver", {
      delivery: { channel: "测试", evidenceFileId: evidence },
    });
    await req(
      "/runs/" + a3 + "/cancel",
      { version: (await run(a3)).version, reason: "归档不可改" },
      409,
    );
    assert.equal((await run(a3)).status, "returned");
  },
);
