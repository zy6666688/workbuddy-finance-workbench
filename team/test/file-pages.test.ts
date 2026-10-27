import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import argon2 from "argon2";
import AdmZip from "adm-zip";
import { buildServer } from "../src/server.js";
import { pool, sha, storeFile, type Actor } from "../src/core.js";
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
  "real PostgreSQL: 1205 physical attachments, complete pagination, pins, fixed references and isolation",
  { skip: !enabled },
  async () => {
    app = await buildServer();
    await app.ready();
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      company = randomUUID(),
      foreignCompany = randomUUID(),
      hiddenCompany = randomUUID(),
      order = randomUUID(),
      foreignOrder = randomUUID();
    const owner = randomUUID(),
      operator = randomUUID(),
      viewer = randomUUID();
    const password = "Synthetic-Paging!2026",
      username = "paging_" + owner;
    await admin!.query(
      "INSERT INTO organizations VALUES($1,'分页验收虚构机构'),($2,'分页隔离虚构机构')",
      [org, foreignOrg],
    );
    for (const [id, role] of [
      [owner, "owner"],
      [operator, "operator"],
      [viewer, "viewer"],
    ]) {
      await admin!.query(
        "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
        [
          id,
          org,
          id === owner ? username : "paging_" + id,
          "分页虚构" + role,
          id === owner ? await argon2.hash(password) : "disabled-login",
          role,
        ],
      );
    }
    for (const [id, oid] of [
      [company, org],
      [hiddenCompany, org],
      [foreignCompany, foreignOrg],
    ])
      await admin!.query(
        "INSERT INTO companies(id,org_id,code,name) VALUES($1,$2,$3,'分页虚构客户')",
        [id, oid, id],
      );
    for (const user of [operator, viewer])
      await admin!.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        org,
        company,
        user,
      ]);
    for (const [id, oid, cid] of [
      [order, org, company],
      [foreignOrder, foreignOrg, foreignCompany],
    ])
      await admin!.query(
        "INSERT INTO work_orders(id,org_id,company_id,period,due_date,checklist) VALUES($1,$2,$3,'2026-10','2026-11-10','[]')",
        [id, oid, cid],
      );
    const headers: Record<string, Record<string, string>> = {};
    for (const id of [owner, operator, viewer]) {
      const token = randomUUID(),
        csrf = randomUUID();
      await admin!.query(
        "INSERT INTO sessions VALUES($1,$2,$3,now()+interval '2 hours')",
        [sha(token), id, csrf],
      );
      headers[id] = { cookie: "zy_session=" + token, "x-csrf-token": csrf };
    }
    const actor = { id: owner, org_id: org, role: "owner" } as Actor;
    const stored: any[] = [];
    // Every index below has real private bytes and a matching checksum. The
    // fixture remains valid for the subsequent backup/restore and browser tests.
    for (let start = 0; start < 1205; start += 25) {
      stored.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, 1205 - start) }, async (_, n) => {
            const index = start + n + 1;
            const name =
              index === 1205
                ? "1205银行流水.csv"
                : index === 301
                  ? "0301税率100%.csv"
                  : index === 1001
                    ? "1001AC_01.csv"
                    : String(index).padStart(4, "0") + "资料.csv";
            const bytes = Buffer.from(`fixture,amount\n${index},${index}.00\n`);
            return {
              ...(await storeFile(actor, { company_id: company }, name, bytes)),
              index,
              category: index % 2 ? "银行资料" : "账务资料",
              version: 1,
            };
          }),
        )),
      );
    }
    async function insertFiles(
      rows: any[],
      oid = org,
      cid = company,
      wid = order,
      kind = "source",
    ) {
      await admin!.query(
        `INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version,created_at)
      SELECT x.id,$1,$2,$3,x.name,$4,x.category,x.size,x.hash,x.key,$5,x.version,'2026-10-01T00:00:00Z' FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,name text,category text,size bigint,hash text,key text,version integer)`,
        [oid, cid, wid, kind, owner, JSON.stringify(rows)],
      );
    }
    await insertFiles(stored);
    const foreignFile = {
      ...(await storeFile(
        { ...actor, org_id: foreignOrg },
        { company_id: foreignCompany },
        "foreign.txt",
        Buffer.from("synthetic foreign"),
      )),
      category: "私有",
      version: 1,
    };
    await insertFiles([foreignFile], foreignOrg, foreignCompany, foreignOrder);
    async function request(
      path: string,
      query: Record<string, string> = {},
      user = owner,
      body?: any,
      status = 200,
    ) {
      const r = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: "/api/v1" + path + "?" + new URLSearchParams(query),
        headers: headers[user],
        ...(body === undefined ? {} : { payload: body }),
      });
      assert.equal(r.statusCode, status, r.body);
      return status === 200 ? r.json() : r;
    }
    const pagePath = `/companies/${company}/files/page`,
      orderPath = `/orders/${order}/files/page`;
    const base = { period: "2026-10", sort: "name" };
    const first = await request(pagePath, base);
    assert.equal(first.rows.length, 50);
    assert.equal(first.filteredTotal, 1205);
    assert.equal(first.scopeSummary.total, 1205);
    assert.equal(first.scopeSummary.sheet, 1205);
    assert.deepEqual(
      new Set(first.facets.categories),
      new Set(["账务资料", "银行资料"]),
    );
    assert.equal(
      first.scopeSummary.bytes,
      stored.reduce((sum, f) => sum + f.size, 0),
    );
    assert.ok(
      first.rows.every(
        (f: any) =>
          !Object.hasOwn(f, "storage_key") && !Object.hasOwn(f, "org_id"),
      ),
    );
    const all = [...first.rows];
    for (let offset = 50; offset < 1205; offset += 50) {
      const page = await request(pagePath, {
        ...base,
        offset: String(offset),
        pageVersion: first.pageVersion,
      });
      assert.equal(page.rows.length, Math.min(50, 1205 - offset));
      all.push(...page.rows);
    }
    assert.equal(new Set(all.map((f: any) => f.id)).size, 1205);
    assert.deepEqual(
      new Set(all.map((f: any) => f.id)),
      new Set(stored.map((f) => f.id)),
    );
    for (const sort of ["recent", "size"]) {
      const a = await request(pagePath, {
        period: "2026-10",
        sort,
        limit: "100",
      });
      const b = await request(pagePath, {
        period: "2026-10",
        sort,
        limit: "100",
        offset: "100",
        pageVersion: a.pageVersion,
      });
      assert.equal(
        new Set([...a.rows, ...b.rows].map((f: any) => f.id)).size,
        200,
        sort + " tied values require deterministic id ordering",
      );
    }
    await request(pagePath, { ...base, offset: "50" }, owner, undefined, 400);
    await request(pagePath, { ...base, limit: "101" }, owner, undefined, 400);
    await request(
      pagePath,
      {
        ...base,
        offset: "50",
        search: "changed",
        pageVersion: first.pageVersion,
      },
      owner,
      undefined,
      409,
    );
    for (const [search, index] of [
      ["%", 301],
      ["_", 1001],
    ] as const) {
      const p = await request(pagePath, { ...base, search });
      assert.equal(p.filteredTotal, 1);
      assert.equal(p.rows[0].id, stored[index - 1].id);
    }
    assert.equal(
      (await request(pagePath, { ...base, fileType: "document" }))
        .filteredTotal,
      0,
    );
    assert.equal(
      (await request(pagePath, { ...base, category: "银行资料" }))
        .filteredTotal,
      603,
    );
    assert.equal(
      (await request(pagePath, { ...base, search: "no-file" })).scopeSummary
        .total,
      1205,
    );
    const picked = [stored[0], stored[300], stored[1000], stored[1204]];
    const resolved = await request(
      `/orders/${order}/files/resolve`,
      {},
      owner,
      { ids: [...picked.map((f) => f.id), foreignFile.id] },
    );
    assert.deepEqual(
      resolved.rows.map((f: any) => f.id),
      picked.map((f) => f.id),
    );
    assert.deepEqual(resolved.unavailableIds, [foreignFile.id]);
    await request(
      `/orders/${order}/files/resolve`,
      {},
      owner,
      { ids: Array.from({ length: 101 }, () => randomUUID()) },
      400,
    );
    for (const item of picked) {
      const r = await app.inject({
        url: `/api/v1/files/${item.id}/download`,
        headers: headers[owner],
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(sha(r.rawPayload), item.hash);
    }
    const suggestions = await request(
      `/companies/${company}/files/suggestions`,
      { period: "2026-10", workflowId: "bank-reconcile" },
    );
    assert.ok(
      suggestions.rows.some((f: any) => f.id === stored[1204].id),
      "workflow suggestions reach the 1205th physical file",
    );
    assert.ok(suggestions.rows.length <= 8);
    const stale = first.pageVersion,
      pin = stored[1204];
    const prefs = await request("/preferences/desk", {}, owner, {
      version: 0,
      key: "pinnedFiles",
      value: [pin.id],
    });
    await request(
      pagePath,
      { ...base, offset: "50", pageVersion: stale },
      owner,
      undefined,
      409,
    );
    const pinned = await request(pagePath, base);
    assert.equal(pinned.rows[0].id, pin.id);
    assert.equal(pinned.rows[0].pinned, true);
    assert.equal(
      (await request(pagePath, { ...base, pinnedOnly: "true" })).filteredTotal,
      1,
    );
    assert.equal(
      (await request(pagePath, { ...base, pinnedOnly: "true" }, operator))
        .filteredTotal,
      0,
    );
    await request("/preferences/desk", {}, owner, {
      version: prefs.version,
      key: "pinnedFiles",
      value: [
        `${stored[300].category}/${stored[300].id}/v1/${stored[300].name}`,
      ],
    });
    assert.equal(
      (await request(pagePath, base)).rows[0].id,
      stored[300].id,
      "legacy relative pin remains global",
    );
    const beforeUpload = await request(orderPath, { sort: "name" });
    const boundary = "paging-fixture-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${order}/files?kind=source&version=1&category=测试`,
      headers: {
        ...headers[owner],
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="new-file.csv"\r\nContent-Type: text/csv\r\n\r\nrow,amount\n1,42\n\r\n--${boundary}--\r\n`,
      ),
    });
    assert.equal(upload.statusCode, 200, upload.body);
    await request(
      orderPath,
      { sort: "name", offset: "50", pageVersion: beforeUpload.pageVersion },
      owner,
      undefined,
      409,
    );
    const newer = {
      ...(await storeFile(
        actor,
        { company_id: company },
        stored[0].name,
        Buffer.from("newer,version\n2,2\n"),
      )),
      category: "银行资料",
      version: 2,
    };
    await insertFiles([newer]);
    const latest = await request(orderPath, {
      search: stored[0].name,
      latestOnly: "true",
    });
    assert.deepEqual(
      latest.rows.map((f: any) => f.id),
      [newer.id],
    );
    const oldReference = await request(
      `/orders/${order}/files/resolve`,
      {},
      owner,
      { ids: [stored[0].id] },
    );
    assert.equal(oldReference.rows[0].isLatest, false);
    async function currentOrder() {
      return (
        await admin!.query("SELECT * FROM work_orders WHERE id=$1", [order])
      ).rows[0];
    }
    for (const action of ["finish_collection", "start_processing"])
      await request(`/orders/${order}/action`, {}, owner, {
        version: (await currentOrder()).version,
        action,
      });
    const inputs = [newer, stored[300], stored[1000], stored[1204]];
    const runA = await request(`/orders/${order}/runs`, {}, owner, {
      version: (await currentOrder()).version,
      workflowId: "bank-reconcile",
      fileIds: inputs.map((f) => f.id),
      key: randomUUID(),
    });
    const runB = await request(`/orders/${order}/runs`, {}, owner, {
      version: (await currentOrder()).version,
      workflowId: "excel-cleaning",
      fileIds: [newer.id],
      key: randomUUID(),
    });
    const job = await request("/jobs", {}, owner, {
      kind: "run_export",
      companyId: company,
      key: randomUUID(),
      payload: { runId: runA.id },
    });
    await processJob(actor, job.id);
    const archive = await app.inject({
      url: `/api/v1/jobs/${job.id}/download`,
      headers: headers[owner],
    });
    assert.equal(archive.statusCode, 200, archive.body);
    const zip = new AdmZip(archive.rawPayload);
    for (const f of inputs)
      assert.equal(
        sha(zip.readFile(`inputs/${f.id}-${f.name}`)!),
        f.hash,
        "task package must include fixed versions outside the first 1000 files",
      );
    const results: any[] = [];
    for (let i = 1; i <= 7; i++)
      results.push({
        ...(await storeFile(
          actor,
          { company_id: company },
          "result.csv",
          Buffer.from(`synthetic,result\n${i},${i}\n`),
          "result",
        )),
        category: "成果",
        version: i,
      });
    await insertFiles(results, org, company, order, "result");
    const revision = (await currentOrder()).input_revision;
    for (const [i, origin, rid] of [
      [0, "manual", null],
      [1, "manual", null],
      [2, "workbuddy", runA.id],
      [3, "workbuddy", runA.id],
      [4, "workbuddy", runB.id],
      [6, "excluded", null],
    ] as const)
      await admin!.query(
        "INSERT INTO result_origins(file_id,org_id,company_id,order_id,origin,run_id,input_revision,method,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,'upload',$8)",
        [results[i].id, org, company, order, origin, rid, revision, owner],
      );
    const domains = await request(orderPath, {
      kind: "result",
      latestOnly: "true",
    });
    assert.deepEqual(
      new Set(domains.rows.map((f: any) => f.id)),
      new Set([1, 3, 4, 5, 6].map((i) => results[i].id)),
      "same name in another run must not hide this run's latest result",
    );
    const candidates = await request(orderPath, {
      kind: "result",
      eligibleOnly: "true",
    });
    assert.deepEqual(
      new Set(candidates.rows.map((f: any) => f.id)),
      new Set([1, 3, 4].map((i) => results[i].id)),
    );
    assert.deepEqual(
      (
        await request(orderPath, {
          kind: "result",
          origin: "manual",
          eligibleOnly: "true",
        })
      ).rows.map((f: any) => f.id),
      [results[1].id],
    );
    assert.deepEqual(
      (
        await request(orderPath, {
          kind: "result",
          runId: runA.id,
          eligibleOnly: "true",
        })
      ).rows.map((f: any) => f.id),
      [results[3].id],
    );
    assert.deepEqual(
      (await request(orderPath, { kind: "evidence", eligibleOnly: "true" }))
        .rows,
      [],
      "system task packages are not delivery evidence",
    );
    await request(orderPath, { runId: randomUUID() }, owner, undefined, 404);
    await admin!.query(
      "UPDATE runs SET active=false,version=version+1 WHERE id=$1",
      [runA.id],
    );
    await request(
      orderPath,
      {
        kind: "result",
        eligibleOnly: "true",
        offset: "1",
        pageVersion: candidates.pageVersion,
      },
      owner,
      undefined,
      409,
    );
    assert.deepEqual(
      (
        await request(orderPath, {
          kind: "result",
          runId: runA.id,
          eligibleOnly: "true",
        })
      ).rows,
      [],
    );
    await admin!.query(
      "UPDATE work_orders SET status='delivery',submission=$2 WHERE id=$1",
      [order, JSON.stringify({ files: [{ id: results[1].id }] })],
    );
    const viewerResults = await request(orderPath, { kind: "result" }, viewer);
    assert.deepEqual(
      viewerResults.rows
        .filter((f: any) => f.canDownload)
        .map((f: any) => f.id),
      [results[1].id],
    );
    await admin!.query(
      "UPDATE work_orders SET status='processing',submission=NULL WHERE id=$1",
      [order],
    );
    for (const path of [
      `/companies/${foreignCompany}/files/page`,
      `/orders/${foreignOrder}/files/page`,
      `/companies/${hiddenCompany}/files/page`,
    ])
      await request(path, { period: "2026-10" }, operator, undefined, 404);
    await request(
      `/orders/${foreignOrder}/files/resolve`,
      {},
      owner,
      { ids: [foreignFile.id] },
      404,
    );
    const readOnly = await request(orderPath, {}, viewer);
    assert.ok(
      readOnly.rows.every(
        (f: any) => !f.canDownload && !f.canReference && !f.eligible,
      ),
    );
    const deniedDownload = await app.inject({
      url: `/api/v1/files/${stored[0].id}/download`,
      headers: headers[viewer],
    });
    assert.equal(deniedDownload.statusCode, 403);
    await admin!.query(
      "DELETE FROM memberships WHERE user_id=$1 AND company_id=$2",
      [operator, company],
    );
    await request(pagePath, base, operator, undefined, 404);
    await request(
      `/orders/${order}/files/resolve`,
      {},
      operator,
      { ids: [stored[0].id] },
      404,
    );
    const output = process.env.RESULTS_DIR || "/results";
    await mkdir(output, { recursive: true });
    await writeFile(
      output + "/file-pages-browser.json",
      JSON.stringify(
        {
          owner: { username, password },
          org,
          company,
          order,
          companyId: company,
          orderId: order,
          physicalFiles: Number(
            (
              await admin!.query(
                "SELECT count(*) AS n FROM files WHERE org_id=ANY($1::uuid[])",
                [[org, foreignOrg]],
              )
            ).rows[0].n,
          ),
          period: "2026-10",
          crossPageIds: picked.map((f) => f.id),
        },
        null,
        2,
      ),
    );
  },
);
