// Runs only against the explicitly named synthetic test project. Does not remove volumes.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const docker = process.env.DOCKER_BIN || "docker";
const env = {
  ...process.env,
  ...Object.fromEntries(
    (await readFile(".env", "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ),
};
const base = [
  "compose",
  "-p",
  "zy-finance-test",
  "-f",
  "compose.yaml",
  "-f",
  "compose.test.yaml",
];
if (process.env.TEAM_TEST_CANDIDATE === '1') base.push('-f', 'compose.candidate.yaml');
function run(args, extra = {}) {
  const r = spawnSync(docker, args, {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0)
    throw Error(
      (r.stderr || r.stdout || "docker failed").replaceAll(
        env.DB_PASSWORD,
        "[redacted]",
      ),
    );
  return r.stdout;
}
const dc = (...args) => run([...base, ...args]);
dc("stop", "app", "worker");
dc(
  "run",
  "--rm",
  "--no-deps",
  "acceptance",
  "node",
  "test/verify-restore.mjs",
  "/results/before-recreate.json",
);
dc("up", "-d", "--force-recreate", "db");
dc("up", "-d", "migrate");
// compose waits for database health before the migration service exits.
dc(
  "run",
  "--rm",
  "--no-deps",
  "acceptance",
  "node",
  "test/verify-restore.mjs",
  "/results/after-recreate.json",
);
assert.deepEqual(
  JSON.parse(await readFile(".test/results/before-recreate.json")),
  JSON.parse(await readFile(".test/results/after-recreate.json")),
);
dc("run", "--rm", "--no-deps", "backup", "bash", "/backup.sh");
const latest = JSON.parse(await readFile(".test/backups/latest.json", "utf8"));
assert.equal(latest.status, "completed");
const stamp = Date.now(),
  database = "zy_restore_" + stamp,
  volume = "zy-finance-test-restore-" + stamp;
dc(
  "exec",
  "-T",
  "db",
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  `CREATE DATABASE ${database}`,
);
run(["volume", "create", volume]);
run(
  [
    "run",
    "--rm",
    "--network",
    "zy-finance-test_default",
    "-e",
    "PGHOST=db",
    "-e",
    "PGUSER=postgres",
    "-e",
    "PGDATABASE=" + database,
    "-e",
    "PGPASSWORD",
    "-v",
    volume + ":/files",
    "-v",
    path.resolve(".test/backups") + ":/backups:ro",
    "-v",
    path.resolve("ops/restore.sh") + ":/restore.sh:ro",
    "postgres:17-bookworm",
    "bash",
    "/restore.sh",
    "/backups/" + latest.directory,
  ],
  { PGPASSWORD: env.DB_PASSWORD },
);
run(
  [
    ...base,
    "run",
    "--rm",
    "--no-deps",
    "-e",
    "ADMIN_DATABASE_URL",
    "-v",
    volume + ":/data/files",
    "acceptance",
    "node",
    "test/verify-restore.mjs",
    "/results/restored.json",
  ],
  {
    ADMIN_DATABASE_URL: `postgresql://postgres:${env.DB_PASSWORD}@db:5432/${database}`,
  },
);
assert.deepEqual(
  JSON.parse(await readFile(".test/results/before-recreate.json")),
  JSON.parse(await readFile(".test/results/restored.json")),
);
dc("up", "-d", "app", "worker", "gateway");
dc(
  "run",
  "--rm",
  "--no-deps",
  "acceptance",
  "node",
  "-e",
  "require('node:fs').writeFileSync('/results/recovery.json',process.argv[1])",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      containerRecreation: "passed",
      emptyDatabaseAndFileVolumeRestore: "passed",
      fileHashesAndBusinessSnapshots: "identical",
      restoredDatabase: database,
      restoredVolume: volume,
      backupPoint: latest.directory,
    },
    null,
    2,
  ),
);
console.log(
  "Container recreation and independent restore passed. Recovery database and volume retained for inspection.",
);
