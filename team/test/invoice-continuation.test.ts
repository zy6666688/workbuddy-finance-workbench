import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import argon2 from "argon2";
import { mkdtemp, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTeamClient } from "../../src/team-api-client.mjs";
import { executeTeamCommand } from "../../src/team-adapter.mjs";
import { buildServer } from "../src/server.js";
import { pool } from "../src/core.js";

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

test("all routes compile, including continuation unions with defaulted inputs", async () => {
  app = await buildServer();
  await app.ready();
});

test(
  "invoice continuation: retry, repair, rejection, scope, rule changes and reviewed handoff",
  { skip: !enabled },
  async (t) => {
    const org = randomUUID(),
      otherOrg = randomUUID(),
      company = randomUUID(),
      order = randomUUID();
    const op = randomUUID(),
      reviewer = randomUUID(),
      outsider = randomUUID();
    const source = randomUUID(),
      evidence = randomUUID(),
      dossier = randomUUID();
    const password = "Synthetic-Invoice!2026",
      hash = await argon2.hash(password);
    await admin!.query(
      "INSERT INTO organizations VALUES($1,'虚构续办机构'),($2,'虚构外部机构')",
      [org, otherOrg],
    );
    for (const [id, oid, role] of [
      [op, org, "owner"],
      [reviewer, org, "reviewer"],
      [outsider, otherOrg, "owner"],
    ])
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3,$4,false)",
        [id, oid, hash, role],
      );
    await admin!.query(
      "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$1::uuid::text,'虚构续办客户')",
      [company, org],
    );
    await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
      org,
      company,
      reviewer,
    ]);
    await admin!.query(
      "INSERT INTO work_orders(id,org_id,company_id,period,status,due_date,checklist,assignee_id,reviewer_id) VALUES($1,$2,$3,'2026-10','processing','2026-11-01','[]',$4,$5)",
      [order, org, company, op, reviewer],
    );
    const seller = {
      sellerName: "虚构续办客户",
      sellerTaxId: "SYNTHETIC-SELLER",
    };
    await admin!.query(
      "INSERT INTO client_dossier_revisions(id,org_id,company_id,version,effective_from,payload,reason,actor_id) VALUES($1,$2,$3,1,'2026-10',$4,'虚构验收',$5)",
      [
        dossier,
        org,
        company,
        JSON.stringify({
          legalName: seller.sellerName,
          creditCode: seller.sellerTaxId,
        }),
        op,
      ],
    );
    await admin!.query(
      "INSERT INTO client_dossier_bindings(org_id,company_id,period,revision_id,actor_id) VALUES($1,$2,'2026-10',$3,$4)",
      [org, company, dossier, op],
    );
    for (const [id, kind] of [
      [source, "source"],
      [evidence, "evidence"],
    ])
      await admin!.query(
        "INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) VALUES($1,$2,$3,$4,$5,$5,'other',1,$6,$1::uuid::text,$7,1)",
        [id, org, company, order, kind, "a".repeat(64), op],
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
    const sessions = {
      op: await login(op),
      reviewer: await login(reviewer),
      outsider: await login(outsider),
    };
    async function call(
      who: keyof typeof sessions,
      path: string,
      body?: any,
      expected = 200,
    ) {
      const r = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: `/api/v1${path}`,
        headers: sessions[who],
        payload: body,
      });
      assert.equal(r.statusCode, expected, `${path}: ${r.body}`);
      return r.json();
    }
    const post = (path: string, body: any, expected = 200) =>
      call("op", path, body, expected);
    const review = (path: string, version: number, reason = "虚构资料已核实") =>
      call("reviewer", path, { version, reason });
    const auth = await post(`/orders/${order}/invoice-authorizations`, {
      key: randomUUID(),
      evidenceFileIds: [evidence],
      payload: {
        ...seller,
        agencyName: "虚构代账",
        representative: "虚构人员",
        region: "虚构地区",
        channelLabel: "线下演示",
        validFrom: "2020-01-01",
        validUntil: "2099-12-31",
        scopes: ["prepare_applications", "record_results"],
        note: "仅虚构验收",
      },
    });
    const verifiedAuth = await review(
      `/invoice-authorizations/${auth.id}/verify`,
      auth.version,
    );
    const authorization = { id: auth.id, version: verifiedAuth.version };
    const invoice = {
      ...seller,
      buyerName: "虚构购方",
      buyerTaxId: "SYNTHETIC-BUYER",
      buyerKind: "enterprise",
      invoiceType: "ordinary",
      businessDescription: "虚构已交付服务",
      lines: [
        {
          name: "虚构服务",
          taxCode: "SYNTHETIC-CODE",
          taxRate: "0.13",
          net: "100",
          tax: "13",
          gross: "113",
          evidenceNote: "虚构合同第一条",
        },
      ],
    };
    const orderVersion = async () =>
      (
        await admin!.query("SELECT version FROM work_orders WHERE id=$1", [
          order,
        ])
      ).rows[0].version;
    const initialVersion = await orderVersion();
    const batch = await post("/invoice-batches", {
      key: randomUUID(),
      title: "虚构续办体检",
      items: [
        {
          orderId: order,
          itemKey: randomUUID(),
          key: randomUUID(),
          version: initialVersion,
          businessRef: "A",
          sourceFileIds: [source],
          authorization,
          payload: { ...invoice, buyerName: "" },
        },
        {
          orderId: order,
          itemKey: randomUUID(),
          key: randomUUID(),
          version: initialVersion,
          businessRef: "B",
          sourceFileIds: [randomUUID()],
          authorization,
          payload: invoice,
        },
      ],
    });
    const idA = batch.items.find((i: any) => i.payload.businessRef === "A").id;
    const idB = batch.items.find((i: any) => i.payload.businessRef === "B").id;
    const actions = () => call("op", `/invoice-batches/${batch.id}/actions`);
    const selected = async (id: string, action: string, extra: any = {}) => {
      const row = (await actions()).items.find((i: any) => i.id === id);
      const b: any = {
        itemId: id,
        action,
        expectedAttemptId: row.expected.attemptId,
        orderVersion: row.expected.orderVersion,
        reason: "沿用虚构原资料继续办理",
        ...extra,
      };
      if (action !== "retry") b.requestVersion = row.expected.requestVersion;
      if (action === "accounting") b.draftVersion = row.expected.draftVersion;
      return b;
    };
    const continueBatch = (body: any) =>
      post(`/invoice-batches/${batch.id}/continue`, body);
    const changes = {
      sourceFileIds: [source],
      authorization,
      payload: invoice,
    };
    let request: any, record: any, ledger: any, rule: any, draft: any;
    let replayBody: any, replayId: string;

    await t.test(
      "partial failure keeps payload and stable retry does not create another attempt",
      async () => {
        assert.equal(
          batch.items.find((i: any) => i.id === idA).group,
          "application_materials",
        );
        const retry = await selected(idB, "retry", { changes });
        retry.orderVersion++;
        const body = { key: randomUUID(), items: [retry] };
        const failed = await continueBatch(body);
        assert.equal(failed.items[0].status, "blocked");
        assert.deepEqual((await continueBatch(body)).items, failed.items);
        const row = (await actions()).items.find((i: any) => i.id === idB);
        assert.equal(row.resume.canPrefill, true);
        assert.equal(row.resume.changes.payload.buyerName, invoice.buyerName);
        const repaired = await selected(idB, "retry", {
          changes: row.resume.changes,
        });
        const next = { key: randomUUID(), items: [repaired] };
        const [a, b] = await Promise.all([
          continueBatch(next),
          continueBatch(next),
        ]);
        assert.equal(a.id, b.id);
        replayBody = next;
        replayId = a.id;
        assert.equal(a.items[0].status, "completed");
        await post(
          `/invoice-batches/${batch.id}/continue`,
          { ...next, items: [{ ...repaired, reason: "不同内容" }] },
          409,
        );
      },
    );
    await t.test(
      "source supplement repairs only selected original request and requires independent review",
      async () => {
        await admin!.query(
          "UPDATE work_orders SET input_revision=input_revision+1,version=version+1 WHERE id=$1",
          [order],
        );
        const repaired = await continueBatch({
          key: randomUUID(),
          items: [await selected(idA, "repair", { changes })],
        });
        assert.equal(repaired.items[0].status, "completed");
        const current = await actions();
        request = current.items.find((i: any) => i.id === idA).request;
        assert.equal(
          request.id,
          batch.items.find((i: any) => i.id === idA).request.id,
        );
        assert.equal(
          current.items.find((i: any) => i.id === idB).request.stale,
          true,
        );
        assert.equal(
          (await call("op", `/invoice-requests/${request.id}/revisions`))
            .length,
          1,
        );
        await post(
          `/invoice-requests/${request.id}/confirm`,
          { version: request.version, reason: "不能自审" },
          403,
        );
        request = await review(
          `/invoice-requests/${request.id}/confirm`,
          request.version,
        );
      },
    );
    await t.test(
      "rejected receipt returns its reason, preserves original evidence and can be corrected",
      async () => {
        const body = {
          key: randomUUID(),
          version: request.version,
          authorization,
          evidenceFileIds: [evidence],
          payload: {
            outcome: "issued",
            channelLabel: "线下演示",
            invoiceNumber: `SYNTHETIC-${randomUUID()}`,
            invoiceDate: "2026-10-10",
            sellerTaxId: seller.sellerTaxId,
            buyerName: invoice.buyerName,
            buyerTaxId: invoice.buyerTaxId,
            net: "100",
            tax: "13",
            gross: "113",
            note: "虚构回执",
          },
        };
        record = await post(
          `/invoice-requests/${request.id}/result-records`,
          body,
        );
        await review(
          `/invoice-result-records/${record.id}/reject`,
          record.version,
          "请补充回执说明",
        );
        const records = await call(
          "op",
          `/invoice-requests/${request.id}/result-records`,
        );
        assert.equal(records[0].review_reason, "请补充回执说明");
        assert.equal(
          (await actions()).items.find((i: any) => i.id === idA).group,
          "receipt_correction",
        );
        const correction = {
          ...body,
          key: randomUUID(),
          payload: { ...records[0].payload, note: "已补齐虚构回执说明" },
          evidenceFileIds: records[0].evidence.map((f: any) => f.id),
        };
        record = await post(
          `/invoice-requests/${request.id}/result-records`,
          correction,
        );
        assert.equal(
          (
            await post(
              `/invoice-requests/${request.id}/result-records`,
              correction,
            )
          ).id,
          record.id,
        );
        await post(
          `/invoice-requests/${request.id}/ledger`,
          { version: request.version },
          404,
        );
        await review(
          `/invoice-result-records/${record.id}/verify`,
          record.version,
        );
        ledger = await post(`/invoice-requests/${request.id}/ledger`, {
          version: request.version,
        });
        assert.equal(
          (
            await post(`/invoice-requests/${request.id}/ledger`, {
              version: request.version,
            })
          ).id,
          ledger.id,
        );
        assert.equal(
          (
            await admin!.query(
              "SELECT count(*)::int n FROM invoice_ledger WHERE result_id=$1",
              [record.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    const context: any = {
      businessType: "已验收服务",
      handlingDate: "2026-10-10",
      currency: "CNY",
      businessMode: "standard_sale",
      decision: "new_entry",
      recognitionBasis: "虚构客户已验收，按合同确认",
      conditionsConfirmed: true,
      note: "保留填写内容",
      evidence: [
        { requirement: "验收依据", fileId: evidence, note: "虚构验收附件" },
      ],
    };
    const getDraft = (id: string) =>
      call("op", `/invoice-accounting-drafts/${id}`);
    await t.test(
      "missing chart does not guess accounts; blocked draft retains supplied context",
      async () => {
        const result = await continueBatch({
          key: randomUUID(),
          items: [await selected(idA, "accounting", { context })],
        });
        assert.equal(result.items[0].status, "completed");
        draft = await getDraft(result.items[0].draft_id);
        assert.equal(draft.status, "blocked");
        assert.equal(draft.context.recognitionBasis, context.recognitionBasis);
        assert.equal(draft.lines.length, 0);
      },
    );
    await t.test(
      "rules are versioned and author cannot self-review; changes require fresh draft",
      async () => {
        const accounts = [
          { code: "1122", name: "应收账款", category: "asset", opening: "0" },
          {
            code: "6001",
            name: "主营业务收入",
            category: "revenue",
            opening: "0",
          },
          {
            code: "2221",
            name: "应交税费",
            category: "liability",
            opening: "0",
          },
        ];
        await admin!.query(
          "INSERT INTO accounting_snapshots(id,org_id,company_id,period,version,payload,actor_id) VALUES($1,$2,$3,'2026-10',1,$4,$5)",
          [
            randomUUID(),
            org,
            company,
            JSON.stringify({ accounts, vouchers: [], invoices: [] }),
            op,
          ],
        );
        const body = {
          key: randomUUID(),
          version: 0,
          period: "2026-10",
          businessType: context.businessType,
          reason: "虚构规则",
          payload: {
            name: "虚构服务规则",
            validFrom: "2026-01-01",
            validUntil: "2026-12-31",
            conditions: "服务已验收",
            requiredEvidence: ["验收依据"],
            lines: [
              {
                account: "1122",
                side: "debit",
                amountBasis: "gross",
                description: "应收",
              },
              {
                account: "6001",
                side: "credit",
                amountBasis: "net",
                description: "收入",
              },
              {
                account: "2221",
                side: "credit",
                amountBasis: "tax",
                description: "税款",
              },
            ],
          },
        };
        rule = await post(
          `/companies/${company}/invoice-accounting-rules`,
          body,
        );
        await post(
          `/invoice-accounting-rules/${rule.id}/verify`,
          { version: rule.version, reason: "不能自审" },
          403,
        );
        rule = await review(
          `/invoice-accounting-rules/${rule.id}/verify`,
          rule.version,
        );
        context.ruleId = rule.id;
        context.ruleVersion = rule.version;
        const result = await continueBatch({
          key: randomUUID(),
          items: [await selected(idA, "accounting", { context })],
        });
        draft = await getDraft(result.items[0].draft_id);
        assert.equal(
          draft.status,
          "pending",
          JSON.stringify(draft.currentIssues),
        );
        const nextRule = await post(
          `/companies/${company}/invoice-accounting-rules`,
          {
            ...body,
            key: randomUUID(),
            version: rule.version,
            reason: "修订核验依据",
            payload: { ...body.payload, name: "虚构服务规则二" },
          },
        );
        rule = await review(
          `/invoice-accounting-rules/${nextRule.id}/verify`,
          nextRule.version,
        );
        assert.equal((await getDraft(draft.id)).stale, true);
        await call(
          "reviewer",
          `/invoice-accounting-drafts/${draft.id}/verify`,
          { version: draft.version, reason: "过期草稿不能通过" },
          409,
        );
        context.ruleId = rule.id;
        context.ruleVersion = rule.version;
        const fixed = await continueBatch({
          key: randomUUID(),
          items: [await selected(idA, "accounting", { context })],
        });
        draft = await getDraft(fixed.items[0].draft_id);
        assert.equal(draft.status, "pending");
      },
    );
    await t.test(
      "rejected accounting draft keeps all inputs; independent approval unlocks exports",
      async () => {
        await post(
          `/invoice-accounting-drafts/${draft.id}/verify`,
          { version: draft.version, reason: "不能自审" },
          403,
        );
        await review(
          `/invoice-accounting-drafts/${draft.id}/reject`,
          draft.version,
          "补充业务确认说明",
        );
        const row = (await actions()).items.find((i: any) => i.id === idA);
        assert.equal(row.accountingDraft.review_reason, "补充业务确认说明");
        assert.equal(row.accountingDraft.context.evidence[0].fileId, evidence);
        const corrected = {
          ...row.accountingDraft.context,
          recognitionBasis: "虚构验收已复查，补充确认说明",
        };
        const result = await continueBatch({
          key: randomUUID(),
          items: [await selected(idA, "accounting", { context: corrected })],
        });
        draft = await getDraft(result.items[0].draft_id);
        assert.equal(draft.context.note, context.note);
        await review(
          `/invoice-accounting-drafts/${draft.id}/verify`,
          draft.version,
        );
        const done = (await actions()).items.find((i: any) => i.id === idA);
        assert.equal(done.group, "handoff_ready");
        assert.equal(done.handoff.tool, "team_download_invoice_accounting");
        for (const format of ["json", "xlsx"]) {
          const r = await app.inject({
            method: "GET",
            url: `/api/v1/invoice-accounting-drafts/${draft.id}/export?format=${format}`,
            headers: sessions.op,
          });
          assert.equal(r.statusCode, 200, r.body);
          assert.ok(r.rawPayload.length > 100);
          if (format === "json") assert.equal(r.json().posted, false);
        }
        assert.equal(
          (
            await admin!.query(
              "SELECT count(*)::int n FROM accounting_snapshots WHERE company_id=$1",
              [company],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "WorkBuddy uses the same progress and downloads reviewed handoff to its authorized workspace",
      async () => {
        const client: any = createTeamClient({
          baseUrl: "http://127.0.0.1:8097",
          session: sessions.op.cookie.split("=")[1],
          csrf: sessions.op["x-csrf-token"],
          fetchImpl: async (url: any, options: any) => {
            const r = await app.inject({
              method: options.method,
              url: url.pathname + url.search,
              headers: options.headers,
              payload: options.body,
            });
            return new Response(new Uint8Array(r.rawPayload), {
              status: r.statusCode,
              headers: r.headers as any,
            });
          },
        });
        client.workspace = await mkdtemp(
          path.join(tmpdir(), "invoice-review-"),
        );
        try {
          const progress = await executeTeamCommand(
            client,
            "invoice-batch-actions",
            { batchId: batch.id },
          );
          assert.equal(
            progress.items.find((i: any) => i.id === idA).handoff.draftId,
            draft.id,
          );
          const result = await executeTeamCommand(
            client,
            "download-invoice-accounting",
            { draftId: draft.id, format: "json", filePath: "handoff.json" },
          );
          assert.equal(result.state, "downloaded");
          assert.equal(result.posted, false);
          const bytes = await readFile(result.absolutePath);
          assert.equal(bytes.length, result.bytes);
          assert.equal(JSON.parse(bytes.toString()).posted, false);
          await assert.rejects(
            executeTeamCommand(client, "download-invoice-accounting", {
              draftId: draft.id,
              format: "json",
              filePath: "handoff.json",
            }),
            /已存在/,
          );
          assert.deepEqual(await readFile(result.absolutePath), bytes);
          assert.deepEqual(await readdir(client.workspace), ["handoff.json"]);
        } finally {
          await unlink(path.join(client.workspace, "handoff.json")).catch(
            () => {},
          );
          await rmdir(client.workspace);
        }
      },
    );
    await t.test(
      "duplicate business retries link original; technical failure rolls back all attempts",
      async () => {
        const duplicate = await post("/invoice-batches", {
          key: randomUUID(),
          title: "重复业务虚构验证",
          items: [
            {
              orderId: order,
              itemKey: randomUUID(),
              key: randomUUID(),
              version: await orderVersion(),
              businessRef: "A",
              sourceFileIds: [source],
              authorization,
              payload: invoice,
            },
          ],
        });
        assert.equal(duplicate.items[0].status, "blocked");
        const item = duplicate.items[0];
        const retry = {
          key: randomUUID(),
          items: [
            {
              itemId: item.id,
              action: "retry",
              expectedAttemptId: null,
              orderVersion: item.expected.orderVersion,
              reason: "核对已有业务",
              changes,
            },
          ],
        };
        const linked = await post(
          `/invoice-batches/${duplicate.id}/continue`,
          retry,
        );
        assert.equal(linked.items[0].request_id, request.id);
        assert.equal(linked.items[0].payload.outcome.state, "linked_existing");
        assert.equal(
          (
            await admin!.query(
              "SELECT count(*)::int n FROM invoice_requests WHERE company_id=$1 AND business_ref='A'",
              [company],
            )
          ).rows[0].n,
          1,
        );
        // Inject a database fault after a valid first item; the enclosing transaction must roll back.
        const faultKey = randomUUID();
        await admin!.query(
          `CREATE FUNCTION review_invoice_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.item_id='${idB}'::uuid THEN RAISE EXCEPTION 'synthetic technical failure'; END IF; RETURN NEW; END $$`,
        );
        await admin!.query(
          "CREATE TRIGGER review_invoice_fault BEFORE INSERT ON invoice_continuation_items FOR EACH ROW EXECUTE FUNCTION review_invoice_fault()",
        );
        try {
          const body = {
            key: faultKey,
            items: [
              await selected(idA, "ledger"),
              await selected(idB, "repair", { changes }),
            ],
          };
          await post(`/invoice-batches/${batch.id}/continue`, body, 500);
          assert.equal(
            (
              await admin!.query(
                "SELECT count(*)::int n FROM invoice_continuations WHERE request_key=$1",
                [faultKey],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          await admin!.query(
            "DROP TRIGGER review_invoice_fault ON invoice_continuation_items",
          );
          await admin!.query("DROP FUNCTION review_invoice_fault()");
        }
      },
    );
    await t.test(
      "customer and organization revocation blocks reads and continuation payloads",
      async () => {
        await call(
          "outsider",
          `/invoice-batches/${batch.id}/actions`,
          undefined,
          404,
        );
        await call(
          "outsider",
          `/invoice-accounting-drafts/${draft.id}`,
          undefined,
          404,
        );
        await admin!.query(
          "DELETE FROM memberships WHERE company_id=$1 AND user_id=$2",
          [company, reviewer],
        );
        await call(
          "reviewer",
          `/invoice-accounting-drafts/${draft.id}`,
          undefined,
          404,
        );
        await call(
          "reviewer",
          `/invoice-requests/${request.id}/result-records`,
          undefined,
          404,
        );
        await admin!.query("UPDATE users SET role='operator' WHERE id=$1", [op]);
        const replay = await continueBatch(replayBody);
        assert.equal(replay.id, replayId);
        assert.equal(replay.scopeComplete, false);
        assert.equal(replay.visibleItems, 0);
        assert.equal(replay.totalItems, 1);
        assert.deepEqual(replay.items, []);
        assert.deepEqual((await actions()).items, []);
      },
    );
  },
);
