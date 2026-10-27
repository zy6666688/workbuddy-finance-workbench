// Explicit isolated acceptance only. Public HTTP + real Worker; no real customer data.
import { Pool } from "pg";
import argon2 from "argon2";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
if (process.env.TEAM_TEST_ACCEPT !== "1")
  throw Error("Synthetic acceptance only");
const db = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
const base = "http://gateway/api/v1",
  origin = "http://127.0.0.1:8081",
  people = {},
  events = [];
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function request(who, path, body, expected = 200, raw = false) {
  const p = people[who],
    headers = {
      origin,
      ...(p?.cookie ? { cookie: p.cookie, "x-csrf-token": p.csrf } : {}),
    };
  if (body !== undefined && !(body instanceof FormData))
    headers["content-type"] = "application/json";
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(
    r.status,
    expected,
    `${who} ${path}: ${bytes.toString().slice(0, 500)}`,
  );
  return raw ? { bytes, headers: r.headers } : JSON.parse(bytes.toString());
}
let oid, cid;
const detail = () => request("op", "/orders/" + oid);
const action = async (who, action, extra = {}, expected = 200) =>
  request(
    who,
    `/orders/${oid}/action`,
    { version: (await detail()).version, action, ...extra },
    expected,
  );
async function upload(
  kind,
  name,
  content,
  { key = randomUUID(), version, index, expected = 200, who = "op" } = {},
) {
  const form = new FormData();
  form.set("file", new Blob([content]), name);
  return request(
    who,
    `/orders/${oid}/files?kind=${kind}&version=${version ?? (await detail()).version}&key=${key}${kind === "result" ? "&origin=manual" : ""}${index === undefined ? "" : "&materialIndex=" + index}`,
    form,
    expected,
  );
}
async function uploadTask(runId,name,content,expected=200) {
  const r=(await detail()).runs.find(x=>x.id===runId), form=new FormData();
  form.set("file",new Blob([content]),name);
  return request("op",`/runs/${runId}/files?version=${r.version}&key=${randomUUID()}`,form,expected);
}
async function reviseRun(runId) {
  const d=await detail(),r=d.runs.find(x=>x.id===runId);
  return request("op",`/runs/${runId}/revise`,{version:r.version,reason:"按复核意见补充逐笔说明",fileIds:r.input_files.map(f=>f.id),key:randomUUID()});
}
async function returnTask(runId,manifest,ids) {
  const r=(await detail()).runs.find(x=>x.id===runId);
  return request("op",`/runs/${runId}/return`,{version:r.version,inputHashes:manifest.inputHashes,resultFileIds:ids,summary:"虚构资料逐笔核对完成，无未解决事项"});
}
async function packageFor(runId) {
  const body = {
    kind: "run_export",
    key: "run-export-" + runId,
    companyId: cid,
    payload: { runId },
  };
  const job = await request("op", "/jobs", body);
  assert.equal((await request("op", "/jobs", body)).id, job.id);
  let done;
  for (let n = 0; n < 90; n++) {
    done = (await request("op", "/jobs")).find((j) => j.id === job.id);
    if (done.status === "completed") break;
    if (done.status === "failed") throw Error(done.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(done.status, "completed");
  const { bytes } = await request(
      "op",
      `/jobs/${job.id}/download`,
      undefined,
      200,
      true,
    ),
    zip = new AdmZip(bytes);
  const manifest = JSON.parse(zip.readAsText("manifest.json")),
    ret = JSON.parse(zip.readAsText("return-manifest.json"));
  assert.equal(manifest.companyId, cid);
  assert.equal(manifest.orderId, oid);
  for (const f of manifest.files) {
    const entry = zip
      .getEntries()
      .find((e) => e.entryName.startsWith("inputs/" + f.id + "-"));
    assert.ok(entry);
    assert.equal(hash(entry.getData()), f.sha256);
  }
  assert.match(zip.readAsText("任务说明.md"), /只处理虚构流水/);
  events.push({
    step: "任务包下载",
    fileCount: manifest.files.length,
    zipBytes: bytes.length,
    sha256: hash(bytes),
  });
  return ret;
}
try {
  const org = randomUUID(),
    password = "Synthetic-" + randomUUID(),
    passwordHash = await argon2.hash(password);
  await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
    org,
    "虚构验收 · 青禾代账团队",
  ]);
  for (const [key, name, role] of [
    ["owner", "陈主管", "owner"],
    ["op", "李会计", "operator"],
    ["review", "王复核", "reviewer"],
    ["replacement", "周会计", "operator"],
  ]) {
    const id = randomUUID(),
      username = "lifecycle_" + id;
    await db.query(
      "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
      [id, org, username, name, passwordHash, role],
    );
    const res = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200);
    const session = await res.json();
    people[key] = {
      id,
      name,
      role,
      username,
      cookie: res.headers.get("set-cookie").split(";")[0],
      csrf: session.csrf,
    };
  }
  const client = await request("owner", "/clients/onboard", {
    name: "虚构客户 · 青禾商贸",
    code: "SYN-" + randomUUID().slice(0, 8),
    profile: {
      contactName: "虚构联系人",
      contactPhone: "",
      serviceNotes: "仅用于验收，不联系真实客户",
    },
    checklist: [
      { name: "银行流水", required: true },
      { name: "账务明细", required: true },
    ],
    assigneeId: people.op.id,
    reviewerId: people.review.id,
    firstMonth: { period: "2026-10", dueDate: "2026-11-10" },
  });
  oid = client.orderId;
  cid = client.id;
  events.push({ step: "客户建档与月度分工", status: "passed" });
  await action("op", "finish_collection", {}, 400);
  const before = (await detail()).version;
  await request("op", `/orders/${oid}/followups`, {
    version: before,
    index: 0,
    note: "虚构客户答复明天补发流水",
    channel: "微信",
    nextDate: "2026-10-28",
  });
  await request(
    "op",
    `/orders/${oid}/followups`,
    { version: before, index: 0, note: "过期操作应拒绝", channel: "电话" },
    409,
  );
  assert.equal((await detail()).followups.length, 1);
  const initial = (await detail()).version,
    key = randomUUID(),
    csv = "date,amount\n2026-10-01,100.25\n2026-10-02,200.75\n";
  const source = await upload("source", "bank.csv", csv, {
    index: 0,
    key,
    version: initial,
  });
  const replay = await upload("source", "bank.csv", csv, {
    index: 0,
    key,
    version: initial,
  });
  assert.equal(replay.id, source.id);
  assert.equal(replay.replayed, true);
  await upload("source", "bank.csv", "different", {
    index: 0,
    key,
    version: initial,
    expected: 409,
  });
  await upload("source", "bad.exe", "invalid", { expected: 400 });
  const ledger = await upload("source", "ledger.csv", csv, { index: 1 });
  assert.equal(
    (await detail()).files.filter((f) => f.kind === "source").length,
    2,
  );
  await request(
    "op",
    `/orders/${oid}/followups`,
    {
      version: (await detail()).version,
      index: 0,
      note: "已解决不得继续作为缺件",
      channel: "电话",
    },
    409,
  );
  events.push({ step: "缺件跟进、批量逐文件保存与重试去重", status: "passed" });
  // Cross-company and cross-organization boundaries for new followups/team routes.
  await request("replacement", `/orders/${oid}`, undefined, 404);
  await request("op", "/team/directory", undefined, 403);
  await action("op", "finish_collection");
  await action("op", "start_processing");
  const workflows = await request("op", "/workflows"),
    runBody = {
      version: (await detail()).version,
      key: randomUUID(),
      workflowId: workflows[0].id,
      fileIds: [source.id, ledger.id],
      taskBrief: { requirements: "只处理虚构流水，金额 301.00，生成核对说明" },
    };
  const run = await request("op", `/orders/${oid}/runs`, runBody);
  assert.equal(
    (await request("op", `/orders/${oid}/runs`, runBody)).id,
    run.id,
  );
  const manifest = await packageFor(run.id);
  // Deterministic simulation of external WorkBuddy processing, not an AI invocation.
  await upload("result", "internal-draft.txt", "未选中内部草稿，不得送审交付");
  const obsolete = await uploadTask(run.id, "reconciliation.txt", "旧草稿");
  const output = await uploadTask(
    run.id,
    "reconciliation.txt",
    "虚构流水 2 笔，合计 301.00；账务明细 2 笔，合计 301.00；差异 0.00。",
  );
  let r = (await detail()).runs.find((r) => r.id === run.id);
  await request(
    "op",
    `/runs/${run.id}/return`,
    {
      version: r.version,
      inputHashes: { ...manifest.inputHashes, unexpected: "x" },
      resultFileIds: [output.id],
      summary: "错误清单",
    },
    400,
  );
  await request(
    "op",
    `/runs/${run.id}/return`,
    {
      version: r.version,
      inputHashes: manifest.inputHashes,
      resultFileIds: [obsolete.id],
      summary: "旧版本",
    },
    400,
  );
  const returned = {
    version: r.version,
    inputHashes: manifest.inputHashes,
    resultFileIds: [output.id],
    summary: "2 笔；金额 301.00；差异 0.00；无未解决事项",
  };
  await request("op", `/runs/${run.id}/return`, returned);
  assert.equal(
    (await request("op", `/runs/${run.id}/return`, returned)).replayed,
    true,
  );
  // A second concurrent execution owns its own identically named files.
  const parallel=await request("op",`/orders/${oid}/runs`,{...runBody,key:randomUUID(),version:(await detail()).version});
  const parallelManifest=await packageFor(parallel.id);
  const parallelOutput=await uploadTask(parallel.id,"reconciliation.txt","独立任务B的同名核对说明");
  const parallelCheck=await uploadTask(parallel.id,"checks.csv","检查项,结果\n金额,通过");
  assert.equal((await detail()).runs.find(x=>x.id===run.id).status,"returned","B upload must not invalidate A");
  await returnTask(parallel.id,parallelManifest,[parallelOutput.id,parallelCheck.id]);
  const manual=await upload("result","人工补充说明.txt","人工判断及复核补充，不属于AI任务");
  const checks = {
    passed: true,
    summary: "两表均为 2 笔 301.00，差异 0.00",
    unresolved: "",
  };
  await action("op", "submit", { checks, manualFileIds:[manual.id] });
  await action("op", "approve", { reason: "自审不得通过" }, 403);
  await action("review", "reject", {
    reason: "请补充逐笔核对说明，保留金额合计",
  });
  const run2 = await reviseRun(run.id);
  const parallel2=await reviseRun(parallel.id);
  const manifest2 = await packageFor(run2.id);
  const revised = await uploadTask(
    run2.id,
    "reconciliation.txt",
    "虚构逐笔核对：2026-10-01 100.25；2026-10-02 200.75；两表一致；合计 301.00。",
  );
  r = (await detail()).runs.find((r) => r.id === run2.id);
  await request("op", `/runs/${run2.id}/return`, {
    version: r.version,
    inputHashes: manifest2.inputHashes,
    resultFileIds: [revised.id],
    summary: "逐笔及汇总已核对，差异 0.00，无未解决事项",
  });
  const parallelManifest2=await packageFor(parallel2.id);
  const parallelRevised=await uploadTask(parallel2.id,"reconciliation.txt","任务B修订后独立成果");
  await returnTask(parallel2.id,parallelManifest2,[parallelRevised.id]);
  const manual2=await upload("result","人工补充说明.txt","经退回更正的人工补充判断");
  await action("op", "submit", { checks,manualFileIds:[manual2.id] });
  const submitted=(await detail()).submission;
  assert.deepEqual(new Set(submitted.files.map(f=>f.id)),new Set([revised.id,parallelRevised.id,manual2.id]));
  assert.equal(submitted.files.filter(f=>f.name==="reconciliation.txt").length,2);
  await action("review", "approve", { reason: "已逐笔复核，金额及来源一致" });
  await action("review", "approve", { reason: "重复审批" }, 409);
  const deliveryJob=await request("op","/jobs",{kind:"delivery_export",key:randomUUID(),companyId:cid,payload:{orderId:oid}});
  let delivered;
  for(let n=0;n<90;n++){delivered=(await request("op","/jobs")).find(j=>j.id===deliveryJob.id);if(delivered.status==="completed")break;if(delivered.status==="failed")throw Error(delivered.error);await new Promise(r=>setTimeout(r,1000));}
  assert.equal(delivered.status,"completed");
  const deliveryBytes=(await request("op",`/jobs/${deliveryJob.id}/download`,undefined,200,true)).bytes;
  const deliveryZip=new AdmZip(deliveryBytes);
  const deliveryManifest=JSON.parse(deliveryZip.readAsText("交付清单.json"));
  assert.deepEqual(new Set(deliveryManifest.submission.files.map(f=>f.id)),new Set([revised.id,parallelRevised.id,manual2.id]));
  for(const f of deliveryManifest.submission.files) assert.equal(hash(deliveryZip.getEntry(`results/${f.id}-${f.name}`).getData()),f.sha256);
  events.push({step:"并行任务同名成果与人工成果混合送审、固定快照交付包",status:"passed",files:3});
  const evidence = await upload(
    "evidence",
    "delivery-receipt.txt",
    "虚构交付记录：演练渠道、客户确认收到。不实际发送消息。",
  );
  await action("op", "deliver", {
    delivery: { channel: "虚构演练渠道", evidenceFileId: evidence.id },
  });
  const archived = await detail();
  assert.equal(archived.status, "archived");
  assert.equal(archived.reviews.length, 2);
  assert.ok(archived.submission.files.some(f=>f.id===revised.id));
  assert.equal(
    archived.submission.files.length,
    3,
    "only returned task files and explicitly selected manual files enter approval",
  );
  await upload("result", "frozen.txt", "不得修改", { expected: 409 });
  events.push({
    step: "回传、退回更正、独立复核、交付归档",
    status: "passed",
    reviewCount: archived.reviews.length,
  });
  // Staff handoff: no silent orphan work, no self review through reassignment.
  let clientNow = await request("owner", "/clients/" + cid);
  const next = await request("owner", `/clients/${cid}/start-month`, {
    version: clientNow.version,
    period: "2026-11",
    dueDate: "2026-12-10",
  });
  const directory = await request("owner", "/team/directory"),
    op = directory.find((u) => u.id === people.op.id);
  await request(
    "owner",
    "/users/" + op.id,
    { version: op.version, active: false, role: "operator" },
    409,
  );
  let work = await request("owner", `/team/users/${op.id}/workload`);
  clientNow = work.companies.find((c) => c.id === cid);
  const handoff = {
    sourceId: op.id,
    targetId: people.replacement.id,
    sourceVersion: work.user.version,
    companyId: cid,
    companyVersion: clientNow.version,
    orders: work.orders
      .filter((o) => o.company_id === cid)
      .map((o) => ({ id: o.id, version: o.version })),
    reason: "虚构调岗交接",
    revokeSource: true,
  };
  await request(
    "owner",
    "/team/handoff",
    { ...handoff, targetId: people.review.id },
    400,
  );
  await request("owner", "/team/handoff", { ...handoff, orders: [] }, 409);
  await request("owner", "/team/handoff", handoff);
  await request("op", "/orders/" + next.id, undefined, 404);
  const transferred = await request("replacement", "/orders/" + next.id);
  assert.equal(transferred.assignee_id, people.replacement.id);
  assert.ok(transferred.contributors.includes(op.id));
  await request("owner", "/users/" + op.id, {
    version: op.version,
    active: false,
    role: "operator",
  });
  await request("op", "/companies", undefined, 401);
  const reviewWork = await request(
      "owner",
      `/team/users/${people.review.id}/workload`,
    ),
    reviewCompany = reviewWork.companies.find((c) => c.id === cid);
  await request(
    "owner",
    "/team/handoff",
    {
      sourceId: people.review.id,
      targetId: people.replacement.id,
      companyId: cid,
      sourceVersion: reviewWork.user.version,
      companyVersion: reviewCompany.version,
      orders: reviewWork.orders
        .filter((o) => o.company_id === cid)
        .map((o) => ({ id: o.id, version: o.version })),
      reason: "不能把复核交给经办",
      revokeSource: false,
    },
    400,
  );
  assert.equal(
    (await request("owner", "/orders/" + oid)).assignee_id,
    op.id,
    "archive assignment unchanged",
  );
  events.push({
    step: "员工工作量、原子交接、撤权及停用保护",
    status: "passed",
  });
  const foreignOrg = randomUUID(),
    foreignUser = randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
    foreignOrg,
    "虚构隔离机构",
  ]);
  await db.query(
    "INSERT INTO users(id,org_id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
    [
      foreignUser,
      foreignOrg,
      "foreign_" + foreignUser,
      "跨机构测试人员",
      passwordHash,
      "owner",
    ],
  );
  const boundary = await db.connect();
  try {
    await boundary.query("BEGIN");
    await boundary.query("SET LOCAL ROLE zy_app");
    await boundary.query("SELECT set_config('zy.actor',$1,true)", [
      foreignUser,
    ]);
    assert.equal(
      (
        await boundary.query(
          "SELECT id FROM material_followups WHERE order_id=$1",
          [oid],
        )
      ).rowCount,
      0,
    );
    await boundary.query("ROLLBACK");
  } finally {
    boundary.release();
  }
  events.push({ step: "新增跟进记录的跨机构行级隔离", status: "passed" });
  const oldSnapshot=JSON.stringify(archived.submission),oldReviews=archived.reviews.map(x=>JSON.stringify(x.snapshot));
  const reopenReq=await request("replacement","/orders/"+oid);
  await request("replacement",`/orders/${oid}/action`,{version:reopenReq.version,action:"request_reopen",reason:"虚构归档更正演练"});
  const reopenNow=await request("review","/orders/"+oid);
  await request("review",`/orders/${oid}/action`,{version:reopenNow.version,action:"reopen",reason:"独立复核同意重开演练"});
  const reopened=await request("replacement","/orders/"+oid);
  assert.equal(reopened.status,"processing");
  assert.ok(reopened.runs.filter(x=>x.active).every(x=>x.status==="stale"));
  assert.deepEqual(reopened.reviews.map(x=>JSON.stringify(x.snapshot)),oldReviews);
  assert.equal(JSON.stringify(deliveryManifest.submission),oldSnapshot);
  events.push({step:"归档重开新轮次，历史审批和已下载交付包不变",status:"passed"});
  const report = {
    at: new Date().toISOString(),
    customer: "虚构客户 · 青禾商贸",
    period: "2026-10",
    status: "archived_then_reopened",
    externalProcessing:
      "按 WorkBuddy 交接协议模拟外部处理，未调用 WorkBuddy AI",
    events,
  };
  await writeFile(
    "/results/collection-lifecycle.json",
    JSON.stringify(report, null, 2),
  );
  // Local-only browser fixtures; never commit or print credentials.
  await writeFile(
    "/results/collection-browser.json",
    JSON.stringify({
      org,
      companyId: cid,
      orderId: oid,
      nextOrderId: next.id,
      people: Object.fromEntries(
        Object.entries(people).map(([k, p]) => [
          k,
          { username: p.username, password, name: p.name },
        ]),
      ),
    }),
  );
  console.log(JSON.stringify(report));
} finally {
  await db.end();
}
