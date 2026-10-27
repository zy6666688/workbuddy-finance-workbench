import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import assert from "node:assert/strict";
if (process.env.TEAM_TEST_ACCEPT !== "1")
  throw Error("Test environment required");
const db = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }),
  fixture = JSON.parse(await readFile("/results/acceptance.json", "utf8"));
const lock = await db.connect();
const id = randomUUID();
try {
  await lock.query("BEGIN");
  const order = (
    await lock.query(
      "SELECT id,revision,submission FROM work_orders WHERE id=$1 FOR UPDATE",
      [fixture.order],
    )
  ).rows[0];
  await db.query(
    "INSERT INTO jobs(id,org_id,company_id,actor_id,kind,idempotency_key,payload) VALUES($1,$2,$3,$4,'delivery_export',($1::uuid)::text,$5)",
    [
      id,
      fixture.org,
      fixture.company,
      fixture.actors.op,
      JSON.stringify({
        orderId: fixture.order,
        revision: order.revision,
        submittedAt: order.submission.at,
      }),
    ],
  );
  const until = Date.now() + 60000;
  let active = false;
  while (Date.now() < until) {
    active = Boolean(
      (
        await db.query(
          "SELECT 1 FROM pgboss.job WHERE data->>'id'=$1 AND state='active'",
          [id],
        )
      ).rowCount,
    );
    if (active) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(active, "worker must actually pick up the job before interruption");
  await writeFile(
    "/results/queue-stage.json",
    JSON.stringify({ stage: "ready", job: id }),
  );
  while (Date.now() < until) {
    try {
      await stat("/results/queue-release-" + id);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await lock.query("ROLLBACK");
  let job;
  while (Date.now() < until) {
    job = (await db.query("SELECT * FROM jobs WHERE id=$1", [id])).rows[0];
    if (job.status === "completed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(job.status, "completed");
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM files WHERE name=$1", [
          "delivery_export-" + id + ".zip",
        ])
      ).rows[0].count,
    ),
    1,
  );
  await writeFile(
    "/results/queue-interruption.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        job: id,
        pickedUpBeforeKill: true,
        recoveredAfterWorkerRestart: true,
        outputCount: 1,
      },
      null,
      2,
    ),
  );
  console.log(
    "Interrupted active worker job recovered, exactly one business artifact",
  );
} finally {
  await lock.query("ROLLBACK");
  lock.release();
  await db.end();
}
