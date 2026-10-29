import { Pool } from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
if (process.env.TEAM_TEST_ACCEPT !== "1")
  throw Error("Acceptance environment required");
const db = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
try {
  const files = (await db.query("SELECT storage_key,sha256 FROM files")).rows;
  const hasDossier = (await db.query("SELECT to_regclass('public.client_dossier_documents') AS t")).rows[0].t;
  if (hasDossier) files.push(...(await db.query('SELECT storage_key,sha256 FROM client_dossier_documents')).rows);
  for (const f of files) {
    const bytes = await readFile("/data/files/" + f.storage_key);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), f.sha256);
  }
  const report = {};
  const accountingTables = [];
  for (const table of ['accounting_snapshots', 'invoice_requests', 'invoice_request_revisions',
    'invoice_authorizations', 'invoice_batches', 'invoice_batch_items', 'invoice_result_records',
    'invoice_continuations', 'invoice_continuation_items', 'invoice_ledger',
    'invoice_accounting_rules', 'invoice_accounting_drafts']) {
    if ((await db.query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t)
      accountingTables.push(table);
  }
  for (const table of [
    "users",
    "companies",
    "memberships",
    "work_orders",
    "files",
    "runs",
    "result_origins",
    "reviews",
    "material_followups",
    "audit_events",
    "jobs",
    "finance_workspaces",
    "user_preferences",
    ...accountingTables,
    ...(hasDossier ? ['client_dossier_documents', 'client_dossier_revisions', 'client_dossier_drafts', 'client_dossier_bindings'] : []),
  ])
    report[table] = (
      await db.query(
        `SELECT count(*)::integer AS count,md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${table} t`,
      )
    ).rows[0];
  report.verifiedFileHashes = files.length;
  const queueOwners = (
    await db.query(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='pgboss'",
    )
  ).rows;
  assert.ok(
    queueOwners.every((r) => r.tableowner === "zy_queue"),
    "queue ownership must survive restore",
  );
  const fixture = JSON.parse(
    await readFile("/results/acceptance.json", "utf8"),
  );
  const appUrl = new URL(process.env.DATABASE_URL);
  appUrl.pathname = new URL(process.env.ADMIN_DATABASE_URL).pathname;
  const runtime = new Pool({ connectionString: appUrl.toString() });
  try {
    report.authorization = {};
    for (const key of ["op", "outsider"]) {
      const c = await runtime.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('zy.actor',$1,true)", [
          fixture.actors[key],
        ]);
        const count = Number(
          (
            await c.query("SELECT count(*) FROM work_orders WHERE id=$1", [
              fixture.order,
            ])
          ).rows[0].count,
        );
        assert.equal(count, key === "op" ? 1 : 0);
        report.authorization[key] = count;
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    }
  } finally {
    await runtime.end();
  }
  const destination = process.argv[2] || "/results/restored.json";
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log("verified all files and business-table snapshots:", files.length);
} finally {
  await db.end();
}
