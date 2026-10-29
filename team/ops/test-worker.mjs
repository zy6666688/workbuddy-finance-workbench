import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
// Write test markers as the same container user that owns the result directory.
// Linux CI hosts need not share the container's uid; keep application file modes strict.
function marker(script, ...args) {
  const result = spawnSync(
    docker,
    [
      ...base,
      "run",
      "--rm",
      "--no-deps",
      "acceptance",
      "node",
      "-e",
      script,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.status) throw Error(result.stderr);
}
marker("require('node:fs').rmSync('/results/queue-stage.json',{force:true})");
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
marker(
  "require('node:fs').writeFileSync('/results/queue-release-'+process.argv[1],'release')",
  ready.job,
);
if ((await done) !== 0) throw Error(output);
console.log(output);
