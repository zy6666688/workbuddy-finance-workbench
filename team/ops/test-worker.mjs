import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
const docker = process.env.DOCKER_BIN || "docker",
  base = [
    "compose",
    "-p",
    "zy-finance-test",
    "-f",
    "compose.yaml",
    "-f",
    "compose.test.yaml",
  ];
await unlink(".test/results/queue-stage.json").catch(() => {});
const child = spawn(
  docker,
  [
    ...base,
    "run",
    "--rm",
    "--no-deps",
    "acceptance",
    "node",
    "test/queue-interruption.mjs",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
const done = new Promise((resolve) => child.on("exit", resolve));
let ready;
const until = Date.now() + 55000;
while (Date.now() < until) {
  try {
    ready = JSON.parse(
      await readFile(".test/results/queue-stage.json", "utf8"),
    );
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!ready) throw Error("Worker did not start test job: " + output);
for (const args of [
  ["kill", "-s", "SIGKILL", "worker"],
  ["start", "worker"],
]) {
  const r = spawnSync(docker, [...base, ...args], { encoding: "utf8" });
  if (r.status) throw Error(r.stderr);
}
await writeFile(".test/results/queue-release-" + ready.job, "release");
if ((await done) !== 0) throw Error(output);
console.log(output);
