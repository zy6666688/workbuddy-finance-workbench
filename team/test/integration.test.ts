import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { Pool } from "pg";
import argon2 from "argon2";
import { buildServer } from "../src/server.js";
import { pool, tx, type Actor } from "../src/core.js";
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
  "real PostgreSQL: isolation, delivery, WorkBuddy, concurrency and revoked access",
  { skip: !enabled },
  async (t) => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      otherOrg = randomUUID(),
      c = randomUUID(),
      hidden = randomUUID(),
      foreign = randomUUID();
    await admin!.query("INSERT INTO organizations VALUES($1,$2),($3,$4)", [
      org,
      "合成验收机构",
      otherOrg,
      "合成机构乙",
    ]);
    const actors: Record<string, Actor> = {},
      sessions: Record<string, any> = {};
    const password = "Synthetic-Test!2026",
      hash = await argon2.hash(password);
    for (const [key, role, oid] of [
      ["owner", "owner", org],
      ["op", "operator", org],
      ["review", "reviewer", org],
      ["viewer", "viewer", org],
      ["outsider", "owner", otherOrg],
    ]) {
      const id = randomUUID(),
        username = "test_" + id;
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
        [id, oid, username, key, hash, role],
      );
      actors[key] = {
        id,
        org_id: oid,
        username,
        name: key,
        role: role as Actor["role"],
        must_change_password: false,
        csrf: "",
      };
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      assert.equal(r.statusCode, 200, r.body);
      sessions[key] = {
        cookie: r.headers["set-cookie"]!.toString().split(";")[0],
        csrf: r.json().csrf,
      };
    }
    for (const [id, oid, name] of [
      [c, org, "验收公司"],
      [hidden, org, "未授权公司"],
      [foreign, otherOrg, "跨机构公司"],
    ])
      await admin!.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,$4)",
        [id, oid, id, name],
      );
    for (const key of ["op", "review", "viewer"])
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        c,
        actors[key].id,
      ]);
    async function req(key: string, path: string, body?: any, expected = 200) {
      const s = sessions[key];
      const r = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: "/api/v1" + path,
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload: body,
      });
      assert.equal(r.statusCode, expected, `${key} ${path}: ${r.body}`);
      return r.json();
    }
    let oid = "";
    const detail = () => req("op", "/orders/" + oid);
    async function action(
      who: string,
      action: string,
      extra: any = {},
      expected = 200,
    ) {
      return req(
        who,
        `/orders/${oid}/action`,
        { version: (await detail()).version, action, ...extra },
        expected,
      );
    }
    async function upload(
      who: string,
      kind: string,
      name: string,
      content: string,
      expected = 200,
      materialIndex?: number,
      runId?: string,
    ) {
      const d = await detail(),
        boundary = "testBoundary";
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      );
      const s = sessions[who];
      const r = await app.inject({
        method: "POST",
        url: runId
          ? `/api/v1/runs/${runId}/files?version=${d.runs.find((r: any) => r.id === runId).version}&key=${randomUUID()}`
          : `/api/v1/orders/${oid}/files?kind=${kind}&origin=manual&version=${d.version}${materialIndex === undefined ? "" : "&materialIndex=" + materialIndex}`,
        headers: {
          cookie: s.cookie,
          "x-csrf-token": s.csrf,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload,
      });
      assert.equal(r.statusCode, expected, r.body);
      return r.json();
    }
    const checks = {
      passed: true,
      summary: "合成数据行数与金额已人工复核",
      unresolved: "",
    };
    let source: any, result: any, run: any, job: any;
    await t.test(
      "RLS runtime role and two organizations, guessed identifiers, CSRF",
      async () => {
        const roles = await pool.query(
          "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        );
        assert.deepEqual(roles.rows[0], {
          rolsuper: false,
          rolbypassrls: false,
        });
        assert.equal(
          (await tx(actors.op, (db) => db.query("SELECT id FROM companies")))
            .rowCount,
          1,
        );
        assert.equal((await req("op", "/companies")).length, 1);
        await req("op", `/companies/${hidden}/members`, undefined, 404);
        await req("owner", `/companies/${foreign}/members`, undefined, 404);
        const r = await app.inject({
          method: "POST",
          url: "/api/v1/companies",
          headers: { cookie: sessions.owner.cookie },
          payload: { code: "x", name: "x" },
        });
        assert.equal(r.statusCode, 403);
        await assert.rejects(
          tx(actors.owner, (db) => db.query("DELETE FROM audit_events")),
          /permission denied/,
        );
      },
    );
    await t.test(
      "original workbench business data persists with company, period and account isolation",
      async () => {
        const value = [
          {
            id: "todo-test",
            text: "合成预算复核",
            category: "预算",
            due: "2026-01-20",
            priority: "高",
            done: false,
          },
        ];
        const first = await req("op", `/companies/${c}/workspace/2026-01`, {
          version: 0,
          key: "todos",
          value,
        });
        assert.equal(first.version, 1);
        assert.deepEqual(
          (await req("review", `/companies/${c}/workspace/2026-01`)).state
            .todos,
          value,
        );
        assert.deepEqual(
          (await req("op", `/companies/${c}/workspace/2026-02`)).state,
          {},
        );
        await req(
          "outsider",
          `/companies/${c}/workspace/2026-01`,
          undefined,
          404,
        );
        await req(
          "op",
          `/companies/${hidden}/workspace/2026-01`,
          { version: 0, key: "todos", value },
          404,
        );
        await req(
          "viewer",
          `/companies/${c}/workspace/2026-01`,
          { version: 1, key: "todos", value: [] },
          403,
        );
        await req(
          "op",
          `/companies/${c}/workspace/2026-01`,
          { version: 0, key: "todos", value: [] },
          409,
        );
        await req("op", "/preferences/desk", {
          version: 0,
          key: "theme",
          value: "jade",
        });
        assert.equal((await req("op", "/preferences")).desk.theme, "jade");
        assert.equal((await req("review", "/preferences")).desk, undefined);
      },
    );
    await t.test(
      "monthly uniqueness, version conflicts, required materials",
      async () => {
        const body = {
          companyId: c,
          period: "2026-01",
          dueDate: "2026-02-10",
          assigneeId: actors.op.id,
          reviewerId: actors.review.id,
        };
        oid = (await req("owner", "/orders", body)).id;
        assert.equal((await req("owner", "/orders", body)).existing, true);
        // Populate inaccessible companies too: aggregates must respect RLS, not
        // merely hide cards after reading every company's totals.
        await admin!.query(
          "INSERT INTO work_orders(id,org_id,company_id,period,due_date,checklist) VALUES($1,$2,$3,'2026-01','2026-02-10','[]'),($4,$5,$6,'2026-01','2026-02-10','[]')",
          [randomUUID(), org, hidden, randomUUID(), otherOrg, foreign],
        );
        const overview = await req("op", "/orders/overview?period=2026-01");
        assert.equal(overview.total, 1);
        assert.equal(overview.missing, 1);
        assert.equal(overview.stages.collecting, 1);
        assert.equal(
          (await req("owner", "/orders/overview?period=2026-01")).total,
          2,
        );
        assert.equal(
          (await req("outsider", "/orders/overview?period=2026-01")).total,
          1,
        );
        assert.equal(
          (await req("op", `/orders/overview?companyId=${hidden}`)).total,
          0,
        );
        assert.equal((await req("op", "/orders?scope=handling")).length, 1);
        assert.equal((await req("op", "/orders?scope=reviewing")).length, 0);
        const listed = await req(
          "review",
          "/orders?scope=reviewing&attention=missing&limit=1",
        );
        assert.equal(listed[0].missing_count, 3);
        assert.equal(listed[0].assignee_name, "op");
        assert.equal(
          (await req("op", "/orders?search=" + encodeURIComponent("验收公司")))
            .length,
          1,
        );
        assert.equal(
          (
            await req(
              "op",
              "/orders?search=" + encodeURIComponent("未授权公司"),
            )
          ).length,
          0,
        );
        assert.equal(
          (await req("owner", "/orders?limit=1&offset=1")).length,
          1,
        );
        assert.equal(
          (await req("owner", "/orders/overview?limit=1&offset=1")).total,
          2,
        );
        await req("op", "/orders?sort=not-a-column", undefined, 400);
        await req("op", "/orders/overview?scope=someone-else", undefined, 400);
        await req("outsider", "/orders/" + oid, undefined, 404);
        await req(
          "viewer",
          `/orders/${oid}/action`,
          { version: 1, action: "finish_collection" },
          403,
        );
        await action("op", "finish_collection", {}, 400);
        source = await upload(
          "op",
          "source",
          "source.csv",
          "date,reference,amount\n2026-01-01,A,1.00",
        );
        await req(
          "op",
          `/orders/${oid}/material`,
          { version: 1, index: 0, action: "receive", fileId: source.id },
          409,
        );
        for (let i = 0; i < 3; i++)
          await req("op", `/orders/${oid}/material`, {
            version: (await detail()).version,
            index: i,
            action: "receive",
            fileId: source.id,
          });
        await action("op", "finish_collection");
        await action("op", "start_processing");
        assert.equal(
          (await req("op", "/orders/overview?attention=missing"))
            .filtered_total,
          0,
        );
        assert.equal(
          (await req("op", "/orders?sort=updated"))[0].received_count,
          3,
        );
        assert.equal((await detail()).company_name, "验收公司");
        assert.ok((await detail()).activity.length > 0);
      },
    );
    await t.test(
      "task package, idempotency, exact input manifest and result return",
      async () => {
        const workflows = await req("op", "/workflows");
        assert.equal(workflows.length, 25);
        run = await req("op", `/orders/${oid}/runs`, {
          version: (await detail()).version,
          workflowId: workflows[0].id,
          fileIds: [source.id],
        });
        const payload = {
          kind: "run_export",
          key: randomUUID(),
          companyId: c,
          payload: { runId: run.id },
        };
        job = await req("op", "/jobs", payload);
        assert.equal((await req("op", "/jobs", payload)).id, job.id);
        await processJob(actors.op, job.id);
        const repeated = await processJob(actors.op, job.id);
        assert.ok(repeated.fileId);
        await req("outsider", `/jobs/${job.id}/download`, undefined, 404);
        await req("viewer", `/files/${source.id}/download`, undefined, 403);
        const downloaded = await app.inject({
          url: `/api/v1/jobs/${job.id}/download`,
          headers: { cookie: sessions.op.cookie },
        });
        assert.equal(downloaded.statusCode, 200);
        assert.equal(downloaded.rawPayload.subarray(0, 2).toString(), "PK");
        result = await upload(
          "op",
          "result",
          "result.csv",
          "reference,amount\nA,1.00",
          200,
          undefined,
          run.id,
        );
        const rd = (await detail()).runs[0];
        await req(
          "op",
          `/runs/${run.id}/return`,
          {
            version: rd.version,
            resultFileIds: [result.id],
            inputHashes: {},
            summary: "验证",
          },
          400,
        );
        await req("op", `/runs/${run.id}/return`, {
          version: rd.version,
          resultFileIds: [result.id],
          inputHashes: Object.fromEntries(
            rd.input_files.map((f: any) => [f.id, f.sha256]),
          ),
          summary: "校验完成",
        });
      },
    );
    await t.test(
      "independent review survives reassignment; replacing approved results revokes approval",
      async () => {
        await action("op", "submit", { checks });
        await action("op", "approve", { reason: "自审" }, 403);
        await action("review", "reject", { reason: "补充说明" });
        const workflow = (await req("op", "/workflows"))[0].id;
        async function rerun() {
          const old = (await detail()).runs.find((r: any) => r.active);
          const r = await req("op", `/runs/${old.id}/revise`, {
            version: old.version,
            reason: "修订成果",
            key: randomUUID(),
            fileIds: [source.id],
          });
          result = await upload(
            "op",
            "result",
            "result.csv",
            "reference,amount\nA,1.00\n",
            200,
            undefined,
            r.id,
          );
          const rd = (await detail()).runs.find((x: any) => x.id === r.id);
          await req("op", `/runs/${r.id}/return`, {
            version: rd.version,
            resultFileIds: [result.id],
            inputHashes: Object.fromEntries(
              rd.input_files.map((f: any) => [f.id, f.sha256]),
            ),
            summary: "更正并复核数据",
          });
        }
        await rerun();
        await action("op", "submit", { checks });
        await action("review", "approve", { reason: "核对通过" });
        await action("review", "approve", { reason: "重复" }, 409);
        result = await upload(
          "op",
          "result",
          "result.csv",
          "reference,amount\nA,1.00\n",
        );
        assert.equal((await detail()).status, "processing");
        await action(
          "op",
          "deliver",
          { delivery: { channel: "测试", evidenceFileId: source.id } },
          409,
        );
        await rerun();
        await action("op", "submit", { checks });
        // A former operator promoted to owner still cannot review their own batch.
        await admin!.query("UPDATE users SET role='owner' WHERE id=$1", [
          actors.op.id,
        ]);
        await req(
          "owner",
          `/orders/${oid}/assign`,
          {
            version: (await detail()).version,
            assigneeId: actors.owner.id,
            reviewerId: actors.op.id,
            dueDate: "2026-02-10",
          },
          400,
        );
        await action("op", "approve", { reason: "调岗后尝试自审" }, 403);
        await req("owner", `/orders/${oid}/assign`, {
          version: (await detail()).version,
          assigneeId: actors.op.id,
          reviewerId: actors.review.id,
          dueDate: "2026-02-10",
        });
        await admin!.query("UPDATE users SET role='operator' WHERE id=$1", [
          actors.op.id,
        ]);
        await action("review", "approve", { reason: "新版本复核通过" });
        const evidence = await upload(
          "op",
          "evidence",
          "delivery.txt",
          "原渠道交付凭证（合成）",
        );
        await action("op", "deliver", {
          delivery: { channel: "线下验收", evidenceFileId: evidence.id },
        });
        assert.equal((await detail()).status, "archived");
        await upload("op", "result", "blocked.txt", "不能修改", 409);
        await req(
          "op",
          `/companies/${c}/workspace/2026-01`,
          { version: 1, key: "todos", value: [] },
          409,
        );
        await action("op", "request_reopen", { reason: "测试更正流程" });
        await action("op", "reopen", { reason: "自批" }, 403);
        await action("review", "reopen", { reason: "同意重新处理" });
        assert.equal((await detail()).status, "processing");
        await rerun();
        await action("op", "submit", { checks });
        await action("review", "approve", { reason: "更正完成" });
        await action("op", "deliver", {
          delivery: { channel: "更正交付", evidenceFileId: evidence.id },
        });
      },
    );
    await t.test(
      "preview before import, company-scoped deduplication and concurrent edits",
      async () => {
        async function preview(
          companyId: string,
          kind: string,
          content: string,
        ) {
          const boundary = "csvBoundary";
          const r = await app.inject({
            method: "POST",
            url: `/api/v1/imports/preview?kind=${kind}&companyId=${companyId}&period=2026-01`,
            headers: {
              cookie: sessions.owner.cookie,
              "x-csrf-token": sessions.owner.csrf,
              "content-type": "multipart/form-data; boundary=" + boundary,
            },
            payload: Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\n\r\n${content}\r\n--${boundary}--\r\n`,
            ),
          });
          assert.equal(r.statusCode, 200, r.body);
          return r.json();
        }
        const csv = "date,reference,amount,description\n2026-01-01,A,0.30,test";
        const bank = await preview(c, "bank", csv),
          other = await preview(hidden, "bank", csv);
        assert.notEqual(bank.id, other.id);
        assert.equal((await preview(c, "bank", csv)).id, bank.id);
        const ledger = await preview(c, "ledger", csv);
        await req(
          "op",
          "/reconcile",
          { bankImportId: bank.id, ledgerImportId: ledger.id },
          404,
        );
        for (const p of [bank, ledger]) {
          const j = await req("owner", "/jobs", {
            kind: "import_commit",
            key: randomUUID(),
            payload: { importId: p.id },
          });
          assert.equal(j.company_id, c);
          await processJob(actors.owner, j.id);
        }
        assert.equal(
          (
            await req("op", "/reconcile", {
              bankImportId: bank.id,
              ledgerImportId: ledger.id,
            })
          ).matched.length,
          1,
        );
        const company = (await req("owner", "/companies")).find(
          (x: any) => x.id === c,
        );
        const headers = {
          cookie: sessions.owner.cookie,
          "x-csrf-token": sessions.owner.csrf,
        };
        const results = await Promise.all(
          [1, 2].map((i) =>
            app.inject({
              method: "POST",
              url: `/api/v1/companies/${c}/template`,
              headers,
              payload: {
                version: company.version,
                checklist: [{ name: "资料" + i, required: true }],
              },
            }),
          ),
        );
        assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
        assert.equal((await detail()).due_date, "2026-02-10");
        const batch = {
          kind: "monthly_batch",
          key: randomUUID(),
          payload: {
            companyIds: [c],
            period: "2026-03",
            dueDate: "2026-04-10",
            assigneeId: actors.op.id,
            reviewerId: actors.review.id,
          },
        };
        const bj = await req("owner", "/jobs", batch);
        assert.equal((await req("owner", "/jobs", batch)).id, bj.id);
        await processJob(actors.owner, bj.id);
        await processJob(actors.owner, bj.id);
        assert.equal(
          (await req("op", `/orders?companyId=${c}&period=2026-03`)).length,
          1,
        );
      },
    );
    await t.test(
      "revocation applies to live sessions, downloads and queued jobs",
      async () => {
        const j = await req("op", "/jobs", {
          kind: "delivery_export",
          key: randomUUID(),
          companyId: c,
          payload: { orderId: oid },
        });
        await req("owner", `/companies/${c}/members`, {
          userId: actors.op.id,
          enabled: false,
        });
        await req("op", "/orders/" + oid, undefined, 404);
        await req("op", `/files/${source.id}/download`, undefined, 404);
        await req("op", `/jobs/${job.id}/download`, undefined, 404);
        await assert.rejects(processJob(actors.op, j.id));
        assert.equal((await req("op", "/companies")).length, 0);
        await req("owner", `/companies/${c}/members`, {
          userId: actors.op.id,
          enabled: true,
        });
        await admin!.query("UPDATE users SET active=false WHERE id=$1", [
          actors.viewer.id,
        ]);
        await req("viewer", "/auth/me", undefined, 401);
      },
    );
    await t.test(
      "client onboarding, default handoff, atomic materials and review queues",
      async () => {
        const oldOrder = oid;
        const draft = {
          name: "新建交接验收",
          code: "onboard-" + randomUUID(),
          profile: {
            contactName: "虚构联系人",
            contactPhone: "",
            serviceNotes: "合成验收",
          },
          checklist: [
            { name: "银行流水", required: true },
            { name: "补充说明", required: false },
          ],
          assigneeId: actors.op.id,
          reviewerId: actors.review.id,
          firstMonth: { period: "2026-10", dueDate: "2026-11-15" },
        };
        await req("op", "/clients/onboard", draft, 403);
        await req(
          "owner",
          "/clients/onboard",
          { ...draft, reviewerId: actors.outsider.id },
          404,
        );
        assert.equal(
          (await req("owner", `/clients?period=2026-10&search=${draft.code}`))
            .total,
          0,
          "failed onboarding rolls back company and grants",
        );
        const created = await req("owner", "/clients/onboard", draft);
        oid = created.orderId;
        await req("owner", "/clients/onboard", draft, 409);
        const client = await req("owner", "/clients/" + created.id);
        assert.equal(client.orders.length, 1);
        assert.ok(client.members.some((u: any) => u.id === actors.review.id));
        await req("outsider", "/clients/" + created.id, undefined, 404);
        assert.equal(
          (
            await req(
              "outsider",
              `/clients?period=2026-10&search=${draft.code}`,
            )
          ).total,
          0,
        );
        await req(
          "review",
          "/clients/" + created.id + "/profile",
          { ...draft, version: client.version },
          403,
        );
        const edits = await Promise.all(
          [1, 2].map((i) =>
            app.inject({
              method: "POST",
              url: `/api/v1/clients/${created.id}/profile`,
              headers: {
                cookie: sessions.owner.cookie,
                "x-csrf-token": sessions.owner.csrf,
              },
              payload: {
                ...draft,
                version: client.version,
                checklist: [{ name: "下月资料" + i, required: true }],
              },
            }),
          ),
        );
        assert.deepEqual(edits.map((r) => r.statusCode).sort(), [200, 409]);
        assert.equal(
          (await detail()).checklist[0].name,
          "银行流水",
          "template update must not change current month",
        );
        const latest = await req("owner", "/clients/" + created.id);
        await req(
          "owner",
          `/clients/${created.id}/start-month`,
          { version: client.version, period: "2026-11", dueDate: "2026-12-10" },
          409,
        );
        const next = await req("review", `/clients/${created.id}/start-month`, {
          version: latest.version,
          period: "2026-11",
          dueDate: "2026-12-10",
        });
        assert.equal(
          (
            await req("review", `/clients/${created.id}/start-month`, {
              version: latest.version,
              period: "2026-11",
              dueDate: "2026-12-10",
            })
          ).id,
          next.id,
        );
        assert.match(
          (await req("op", "/orders/" + next.id)).checklist[0].name,
          /下月资料/,
        );
        const countBefore = (await detail()).files.length;
        await upload("op", "source", "wrong.txt", "bad index", 400, 39);
        assert.equal((await detail()).files.length, countBefore);
        const file = await upload(
          "op",
          "source",
          "材料.txt",
          "虚构流水",
          200,
          0,
        );
        assert.equal(
          (await detail()).checklist[0].fileId,
          file.id,
          "file and material association commit together",
        );
        await action("op", "finish_collection");
        await action("op", "start_processing");
        assert.equal((await detail()).readiness.ready, false);
        const manual = await upload("op", "result", "成果.txt", "虚构成果");
        assert.equal((await detail()).readiness.blockingReady, true);
        assert.equal((await detail()).readiness.ready, false);
        await req("owner", `/companies/${created.id}/members`, {
          userId: actors.review.id,
          enabled: false,
        });
        assert.equal(
          (await req("owner", `/clients?period=2026-10&search=${draft.code}`))
            .unstaffed,
          1,
        );
        assert.equal((await detail()).readiness.ready, false);
        await action(
          "op",
          "submit",
          { checks, manualFileIds: [manual.id] },
          400,
        );
        const revokedClient = await req("owner", "/clients/" + created.id);
        assert.equal(revokedClient.staffed, false);
        await req(
          "owner",
          `/clients/${created.id}/start-month`,
          {
            version: revokedClient.version,
            period: "2026-12",
            dueDate: "2027-01-10",
          },
          400,
        );
        await req("owner", `/companies/${created.id}/members`, {
          userId: actors.review.id,
          enabled: true,
        });
        await action("op", "submit", { checks, manualFileIds: [manual.id] });
        const queue = `/reviews/queue?period=2026-10&companyId=${created.id}`;
        assert.equal((await req("review", queue)).actionable, 1);
        assert.equal((await req("outsider", queue)).total, 0);
        await req("op", queue, undefined, 403);
        await admin!.query("UPDATE users SET role='owner' WHERE id=$1", [
          actors.op.id,
        ]);
        assert.equal(
          (await req("op", queue)).actionable,
          0,
          "promoted contributor excluded from independent queue",
        );
        await admin!.query("UPDATE users SET role='operator' WHERE id=$1", [
          actors.op.id,
        ]);
        await action("review", "reject", { reason: "请补充流水核对说明" });
        const returned = await req("review", queue + "&queue=returned");
        assert.equal(returned.total, 1);
        assert.equal(returned.rows[0].last_review_reason, "请补充流水核对说明");
        await action("op", "submit", { checks, manualFileIds: [manual.id] });
        await action("review", "approve", { reason: "更正后核对通过" });
        assert.equal((await req("review", queue + "&queue=delivery")).total, 1);
        const evidence = await upload(
          "op",
          "evidence",
          "回执.txt",
          "虚构交付回执",
        );
        await action("op", "deliver", {
          delivery: { channel: "虚构交付", evidenceFileId: evidence.id },
        });
        await action("op", "request_reopen", { reason: "虚构更正申请" });
        await action("owner", "request_reopen", { reason: "不能覆盖" }, 409);
        assert.equal((await req("review", queue + "&queue=reopen")).total, 1);
        await action("review", "reopen", { reason: "同意更正" });
        assert.equal((await req("review", queue + "&queue=reopen")).total, 0);
        await req("owner", `/companies/${created.id}/members`, {
          userId: actors.op.id,
          enabled: false,
        });
        await req("op", "/clients/" + created.id, undefined, 404);
        oid = oldOrder;
      },
    );
    await mkdir("/results", { recursive: true });
    await writeFile(
      "/results/acceptance.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          org,
          company: c,
          order: oid,
          sourceId: source.id,
          actors: Object.fromEntries(
            Object.entries(actors).map(([k, v]) => [k, v.id]),
          ),
          status: (await detail()).status,
        },
        null,
        2,
      ),
    );
  },
);
