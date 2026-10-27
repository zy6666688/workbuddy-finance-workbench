import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { pool } from "../src/core.ts";
if (process.env.TEAM_TEST_ACCEPT !== "1")
  throw Error("Isolated acceptance environment required");
const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
const org = randomUUID();
const app = await buildServer();
await app.ready();
try {
  await admin.query("INSERT INTO organizations VALUES($1,$2)", [
    org,
    "容量测试虚构机构",
  ]);
  await admin.query(
    `INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) SELECT gen_random_uuid(),$1,($1::uuid)::text||'-'||i,'虚构员工'||i,'disabled-login','operator',false FROM generate_series(1,100) i`,
    [org],
  );
  await admin.query(
    `INSERT INTO companies(id,org_id,code,name) SELECT gen_random_uuid(),$1,'S'||i,'容量客户'||lpad(i::text,4,'0') FROM generate_series(1,2000) i`,
    [org],
  );
  const users = (
    await admin.query("SELECT id FROM users WHERE org_id=$1 ORDER BY id", [org])
  ).rows;
  const companies = (
    await admin.query(
      "SELECT id FROM companies WHERE org_id=$1 ORDER BY code",
      [org],
    )
  ).rows;
  for (let i = 0; i < 100; i++)
    await admin.query(
      "INSERT INTO memberships SELECT $1,id,$2 FROM companies WHERE id=ANY($3::uuid[])",
      [
        org,
        users[i].id,
        companies.slice((i % 50) * 40, ((i % 50) + 1) * 40).map((c) => c.id),
      ],
    );
  await admin.query(
    `INSERT INTO work_orders(id,org_id,company_id,period,due_date,checklist) SELECT gen_random_uuid(),$1,c.id,'2026-'||lpad(m::text,2,'0'),('2026-'||lpad(m::text,2,'0')||'-28')::date,'[]'::jsonb FROM companies c CROSS JOIN generate_series(1,12) m WHERE c.org_id=$1`,
    [org],
  );
  await admin.query(
    `INSERT INTO files(id,org_id,company_id,order_id,name,kind,category,size,sha256,storage_key,uploaded_by,version) SELECT gen_random_uuid(),$1,w.company_id,w.id,'synthetic-index-'||g,'source','容量测试占位索引',0,'index-only',gen_random_uuid()::text,$2,1 FROM work_orders w CROSS JOIN generate_series(1,5) g WHERE w.org_id=$1 LIMIT 100000`,
    [org, users[0].id],
  );
  await admin.query("ANALYZE");
  const sessions = [];
  for (const u of users.slice(0, 50)) {
    const token = randomUUID(),
      csrf = randomUUID();
    await admin.query(
      "INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour')",
      [createHash("sha256").update(token).digest("hex"), u.id, csrf],
    );
    sessions.push({ cookie: "zy_session=" + token, "x-csrf-token": csrf });
  }
  const samples = [],
    start = performance.now();
  await Promise.all(
    sessions.map(async (headers, i) => {
      for (const url of [
        "/orders?period=2026-06",
        "/companies?search=容量&limit=30",
        "/orders?offset=30",
        "/jobs",
      ]) {
        const at = performance.now();
        let r;
        if (process.env.SCALE_HTTP === "1") {
          const response = await fetch(
            "http://gateway/api/v1" + encodeURI(url),
            { headers },
          );
          const body = await response.text();
          r = {
            statusCode: response.status,
            body,
            json: () => JSON.parse(body),
          };
        } else
          r = await app.inject({
            url: "/api/v1" + url,
            headers,
            remoteAddress: `192.0.2.${i + 1}`,
          });
        assert.equal(r.statusCode, 200, r.body);
        samples.push(performance.now() - at);
        if (url.startsWith("/companies"))
          assert.ok(
            r
              .json()
              .every((c) =>
                companies
                  .slice(i * 40, (i + 1) * 40)
                  .some((x) => x.id === c.id),
              ),
          );
      }
    }),
  );
  samples.sort((a, b) => a - b);
  const result = {
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
    data: {
      users: 100,
      companies: 2000,
      orders: 24000,
      fileIndexes: 100000,
      fileContents: "index-only synthetic rows, not actual uploaded files",
    },
    concurrency: 50,
    requests: samples.length,
    elapsedMs: performance.now() - start,
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples.at(-1),
    scope:
      process.env.SCALE_HTTP === "1"
        ? "HTTP via Caddy, app and real PostgreSQL; local Docker network, TLS excluded"
        : "Fastify inject + real PostgreSQL; excludes network/TLS latency",
  };
  await writeFile(
    process.env.SCALE_HTTP === "1"
      ? "/results/scale-http.json"
      : "/results/scale.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  // Remove only this generated organization's index-only file records so restore tests can check every real file.
  await admin.query("DELETE FROM files WHERE org_id=$1", [org]);
} finally {
  await app.close();
  await pool.end();
  await admin.end();
}
