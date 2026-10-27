// Run only in the isolated acceptance container. Index-only fixtures are scoped
// to one fresh organization and removed in finally before restore verification.
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool, sha } from "../src/core.ts";
if (process.env.TEAM_TEST_ACCEPT !== "1")
  throw Error("Isolated acceptance environment required");
const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
const org = randomUUID(),
  app = await buildServer();
await app.ready();
try {
  await admin.query(
    "INSERT INTO organizations VALUES($1,'附件分页容量虚构机构')",
    [org],
  );
  await admin.query(
    `INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password)
    SELECT gen_random_uuid(),$1,($1::uuid)::text||'-'||i,'分页容量员工'||i,'disabled-login','operator',false FROM generate_series(1,100) i`,
    [org],
  );
  await admin.query(
    `INSERT INTO companies(id,org_id,code,name)
    SELECT gen_random_uuid(),$1,'P'||lpad(i::text,4,'0'),'分页容量客户'||i FROM generate_series(1,2000) i`,
    [org],
  );
  await admin.query(
    `INSERT INTO work_orders(id,org_id,company_id,period,due_date,checklist)
    SELECT gen_random_uuid(),$1,c.id,'2026-'||lpad(m::text,2,'0'),('2026-'||lpad(m::text,2,'0')||'-28')::date,'[]'::jsonb
    FROM companies c CROSS JOIN generate_series(1,12) m WHERE c.org_id=$1`,
    [org],
  );
  const users = (
    await admin.query(
      "SELECT id FROM users WHERE org_id=$1 ORDER BY username",
      [org],
    )
  ).rows;
  const companies = (
    await admin.query(
      "SELECT id FROM companies WHERE org_id=$1 ORDER BY code LIMIT 100",
      [org],
    )
  ).rows;
  for (let i = 0; i < 100; i++)
    await admin.query("INSERT INTO memberships VALUES($1,$2,$3)", [
      org,
      companies[i].id,
      users[i].id,
    ]);
  await admin.query(
    `INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version)
    SELECT gen_random_uuid(),$1,w.company_id,w.id,'file-'||lpad(g::text,4,'0')||CASE WHEN g%100=0 THEN '_100%' ELSE '' END||'.csv',
    'source',CASE WHEN g%2=0 THEN '银行资料' ELSE '账务资料' END,0,'pagination-index-only',
    ($1::uuid)::text||'/'||w.company_id::text||'/source/'||gen_random_uuid()::text,$2,1
    FROM work_orders w CROSS JOIN generate_series(1,1000) g WHERE w.company_id=ANY($3::uuid[]) AND w.period='2026-06'`,
    [org, users[0].id, companies.map((c) => c.id)],
  );
  await admin.query("ANALYZE files");
  await admin.query("ANALYZE work_orders");
  const sessions = [];
  for (const user of users.slice(0, 50)) {
    const token = randomUUID(),
      csrf = randomUUID();
    await admin.query(
      "INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour')",
      [sha(token), user.id, csrf],
    );
    sessions.push({ cookie: "zy_session=" + token, "x-csrf-token": csrf });
  }
  const samples = [],
    errors = [],
    started = performance.now();
  async function get(i, query) {
    const url =
      `/api/v1/companies/${companies[i].id}/files/page?` +
      new URLSearchParams({ period: "2026-06", ...query });
    const at = performance.now();
    const response =
      process.env.SCALE_HTTP === "1"
        ? await fetch("http://gateway" + url, { headers: sessions[i] })
        : null;
    const injected = response
      ? null
      : await app.inject({
          url,
          headers: sessions[i],
          remoteAddress: `192.0.2.${i + 1}`,
        });
    const body = response ? await response.text() : injected.body,
      status = response ? response.status : injected.statusCode;
    samples.push({
      ms: performance.now() - at,
      bytes: Buffer.byteLength(body),
      status,
      kind: query.search
        ? "search"
        : query.offset
          ? "last-page"
          : query.category
            ? "category"
            : "page",
    });
    assert.equal(status, 200, body);
    assert.ok(Buffer.byteLength(body) < 128 * 1024, "bounded page response");
    return JSON.parse(body);
  }
  await Promise.all(
    sessions.map(async (_, i) => {
      try {
        const first = await get(i, {});
        assert.equal(first.filteredTotal, 1000);
        assert.equal(first.scopeSummary.total, 1000);
        assert.equal(first.rows.length, 50);
        const last = await get(i, {
          offset: "950",
          pageVersion: first.pageVersion,
        });
        assert.equal(last.rows.length, 50);
        assert.equal(last.hasMore, false);
        assert.equal(
          new Set([...first.rows, ...last.rows].map((f) => f.id)).size,
          100,
        );
        const searched = await get(i, { search: "%" });
        assert.equal(searched.filteredTotal, 10);
        assert.equal(searched.scopeSummary.total, 1000);
        const category = await get(i, { category: "银行资料" });
        assert.equal(category.filteredTotal, 500);
        assert.ok(category.rows.every((f) => f.company_id === companies[i].id));
      } catch (e) {
        errors.push({ session: i, message: e.message });
      }
    }),
  );
  const durations = samples.map((s) => s.ms).sort((a, b) => a - b);
  const report = {
    at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
      postgres: (await admin.query("SHOW server_version")).rows[0]
        .server_version,
    },
    dataset: {
      users: 100,
      companies: 2000,
      monthlyOrders: 24000,
      fileIndexes: 100000,
      filesPerMeasuredCompany: 1000,
      filesPhysical: false,
      physicalFileAcceptance:
        "file-pages.test.ts separately verifies 1205 private files, their checksums and task-package export",
    },
    concurrency: 50,
    requests: samples.length,
    elapsedMs: performance.now() - started,
    p50Ms: durations[Math.floor(durations.length * 0.5)],
    p95Ms: durations[Math.floor(durations.length * 0.95)],
    maxMs: durations.at(-1),
    maxResponseBytes: Math.max(...samples.map((s) => s.bytes)),
    errors,
    scope:
      process.env.SCALE_HTTP === "1"
        ? "50 authenticated sessions through Caddy/app/PostgreSQL on local Docker network; TLS excluded"
        : "50 authenticated sessions through Fastify inject and real PostgreSQL; network/TLS excluded",
  };
  const output =
    (process.env.RESULTS_DIR || "/results") +
    (process.env.SCALE_HTTP === "1"
      ? "/file-pages-scale-http.json"
      : "/file-pages-scale.json");
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(
    errors.length,
    0,
    "all 50 sessions must pass the bounded-page and complete-summary assertions",
  );
} finally {
  await admin.query(
    "DELETE FROM files WHERE org_id=$1 AND sha256='pagination-index-only'",
    [org],
  );
  await app.close();
  await pool.end();
  await admin.end();
}
