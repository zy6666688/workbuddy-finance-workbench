#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/team-api-client.mjs
var team_api_client_exports = {};
__export(team_api_client_exports, {
  createTeamClient: () => createTeamClient
});
function createTeamClient({ baseUrl, session, csrf, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || !(base.protocol === "https:" || base.protocol === "http:" && loopback)) {
    throw new Error("\u56E2\u961F\u670D\u52A1\u5730\u5740\u5FC5\u987B\u662F HTTPS \u6839\u5730\u5740\uFF0C\u6216\u672C\u673A HTTP \u6839\u5730\u5740");
  }
  if (!/^[a-f0-9]{64}$/.test(session || "") || !/^[a-f0-9]{64}$/.test(csrf || "")) {
    throw new Error("\u7F3A\u5C11\u6709\u6548\u7684\u5458\u5DE5\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u5B8C\u6210\u56E2\u961F\u7248\u6388\u6743");
  }
  async function request(method, pathname, { query, body, multipart = false, binary = false, expectedType } = {}) {
    const url = new URL("/api/v1" + pathname, base);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== void 0 && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        headers: {
          cookie: `zy_session=${session}`,
          ...method === "POST" ? { "x-csrf-token": csrf, ...multipart ? {} : { "content-type": "application/json" } } : {}
        },
        ...method === "POST" ? { body: multipart ? body : JSON.stringify(body) } : {},
        signal: AbortSignal.timeout(3e4)
      });
    } catch {
      throw Object.assign(new Error(method === "POST" ? "\u670D\u52A1\u54CD\u5E94\u4E2D\u65AD\uFF0C\u672C\u6B21\u63D0\u4EA4\u7ED3\u679C\u5C1A\u4E0D\u80FD\u786E\u8BA4\uFF1B\u8BF7\u67E5\u8BE2\u539F\u4EFB\u52A1\uFF0C\u6216\u4FDD\u7559\u539F\u8BF7\u6C42\u6807\u8BC6\u53CA\u5168\u90E8\u53C2\u6570\u91CD\u8BD5\uFF0C\u4E0D\u8981\u65B0\u5EFA\u91CD\u590D\u4EFB\u52A1\u3002" : "\u670D\u52A1\u54CD\u5E94\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u65B0\u67E5\u8BE2\u3002"), { outcomeUnknown: method === "POST" });
    }
    if (response.ok && binary) {
      if (expectedType && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType)
        throw new Error("\u4EA4\u63A5\u4E0B\u8F7D\u54CD\u5E94\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u672A\u4FDD\u5B58\u6587\u4EF6\uFF1B\u8BF7\u91CD\u65B0\u67E5\u8BE2\u6210\u679C\u540E\u518D\u4E0B\u8F7D\u3002");
      const max = 100 * 1024 * 1024;
      if (Number(response.headers.get("content-length") || 0) > max) throw new Error("\u4E0B\u8F7D\u6587\u4EF6\u8D85\u8FC7\u672C\u673A\u4EA4\u63A5\u4E0A\u9650");
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > max) throw new Error("\u4E0B\u8F7D\u6587\u4EF6\u8D85\u8FC7\u672C\u673A\u4EA4\u63A5\u4E0A\u9650");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    let data;
    try {
      data = await response.json();
      if (data === null || typeof data !== "object") throw new Error("invalid response");
    } catch {
      throw Object.assign(new Error(method === "POST" ? "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4\u56DE\u6267\uFF0C\u4E0D\u80FD\u786E\u8BA4\u662F\u5426\u5DF2\u4FDD\u5B58\uFF1B\u8BF7\u67E5\u8BE2\u539F\u4EFB\u52A1\uFF0C\u6216\u4F7F\u7528\u76F8\u540C\u8BF7\u6C42\u6807\u8BC6\u548C\u53C2\u6570\u91CD\u8BD5\u3002" : "\u56E2\u961F\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\uFF0C\u8BF7\u91CD\u65B0\u67E5\u8BE2\u3002"), { outcomeUnknown: method === "POST", ...!response.ok ? { status: response.status } : {} });
    }
    if (!response.ok) throw Object.assign(new Error(data.error || "\u56E2\u961F\u670D\u52A1\u8BF7\u6C42\u5931\u8D25"), { status: response.status, requestId: data.requestId, outcomeUnknown: method === "POST" && response.status >= 500 });
    return data;
  }
  const id = (value) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "")) throw new Error("\u7F16\u53F7\u683C\u5F0F\u4E0D\u6B63\u786E");
    return value;
  };
  return {
    me: async () => {
      const { csrf: _csrf, ...actor } = await request("GET", "/auth/me");
      return actor;
    },
    logoutCurrent: () => request("POST", "/auth/session/logout", { body: {} }),
    companies: (query) => request("GET", "/companies", { query }),
    dossier: (companyId, period) => request("GET", `/companies/${id(companyId)}/dossier`, { query: { period } }),
    dossierRevision: (companyId, revisionId) => request("GET", `/companies/${id(companyId)}/dossier/revisions/${id(revisionId)}`),
    dossierDraft: (companyId, draftId) => request("GET", `/companies/${id(companyId)}/dossier/drafts/${id(draftId)}`),
    createDossierDraft: (companyId, body) => request("POST", `/companies/${id(companyId)}/dossier/drafts`, { body }),
    orders: (query) => request("GET", "/orders", { query }),
    order: (orderId) => request("GET", `/orders/${id(orderId)}`, { query: { compact: 1 } }),
    files: (orderId, query) => request("GET", `/orders/${id(orderId)}/files/page`, { query }),
    workflows: () => request("GET", "/workflows"),
    workflow: (workflowId) => {
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(workflowId || "")) throw new Error("\u5DE5\u4F5C\u6D41\u7F16\u53F7\u683C\u5F0F\u4E0D\u6B63\u786E");
      return request("GET", `/workflows/${workflowId}`);
    },
    jobs: () => request("GET", "/jobs"),
    createJob: (body) => request("POST", "/jobs", { body }),
    downloadJob: (jobId) => request("GET", `/jobs/${id(jobId)}/download`, { binary: true }),
    downloadFile: (fileId) => request("GET", `/files/${id(fileId)}/download`, { binary: true }),
    accountingTemplate: () => request("GET", "/accounting/template", { binary: true }),
    workflowTemplate: (workflowId) => {
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(workflowId || "")) throw new Error("\u5DE5\u4F5C\u6D41\u7F16\u53F7\u683C\u5F0F\u4E0D\u6B63\u786E");
      return request("GET", `/workflows/${workflowId}/template`, { binary: true });
    },
    uploadAccountingInput: (orderId, { version, key, sourceFileIds, reason, workflowId, name, bytes }) => {
      const form = new FormData();
      form.set("sourceFileIds", sourceFileIds.map(id).join(","));
      form.set("reason", reason);
      if (workflowId) form.set("workflowId", workflowId);
      form.set("file", new Blob([bytes]), name);
      return request("POST", `/orders/${id(orderId)}/accounting-input`, { query: { version, key }, body: form, multipart: true });
    },
    createRun: (orderId, body) => request("POST", `/orders/${id(orderId)}/runs`, { body }),
    startWorkflow: (orderId, body) => request("POST", `/orders/${id(orderId)}/workflow-tasks`, { body }),
    workflowStatus: (runId) => request("GET", `/workflow-tasks/${id(runId)}`),
    calculation: (runId, query) => request("GET", `/workflow-tasks/${id(runId)}/calculation`, { query }),
    returnCalculation: (runId, body) => request("POST", `/workflow-tasks/${id(runId)}/return-calculation`, { body }),
    reviseRun: (runId, body) => request("POST", `/runs/${id(runId)}/revise`, { body }),
    retryJob: (jobId) => request("POST", `/jobs/${id(jobId)}/retry`, { body: {} }),
    invoicingCapabilities: () => request("GET", "/invoicing/capabilities"),
    invoiceRequests: (orderId, query) => request("GET", `/orders/${id(orderId)}/invoice-requests`, { query }),
    prepareInvoice: (orderId, body) => request("POST", `/orders/${id(orderId)}/invoice-requests`, { body }),
    invoiceRequest: (requestId) => request("GET", `/invoice-requests/${id(requestId)}`),
    reviseInvoice: (requestId, body) => request("POST", `/invoice-requests/${id(requestId)}/revise`, { body }),
    invoiceRevisions: (requestId, query) => request("GET", `/invoice-requests/${id(requestId)}/revisions`, { query }),
    invoiceAuthorizations: (companyId, query) => request("GET", `/companies/${id(companyId)}/invoice-authorizations`, { query }),
    invoiceAuthorization: (authorizationId) => request("GET", `/invoice-authorizations/${id(authorizationId)}`),
    prepareInvoiceAuthorization: (orderId, body) => request("POST", `/orders/${id(orderId)}/invoice-authorizations`, { body }),
    prepareInvoiceBatch: (body) => request("POST", "/invoice-batches", { body }),
    invoiceBatches: (query) => request("GET", "/invoice-batches", { query }),
    invoiceBatch: (batchId) => request("GET", `/invoice-batches/${id(batchId)}`),
    invoiceBatchActions: (batchId) => request("GET", `/invoice-batches/${id(batchId)}/actions`),
    continueInvoiceBatch: (batchId, body) => request("POST", `/invoice-batches/${id(batchId)}/continue`, { body }),
    invoiceContinuation: (continuationId) => request("GET", `/invoice-continuations/${id(continuationId)}`),
    invoiceAccountingContext: (companyId, period) => request("GET", `/companies/${id(companyId)}/invoice-accounting-context`, { query: { period } }),
    invoiceAccountingRules: (companyId, query) => request("GET", `/companies/${id(companyId)}/invoice-accounting-rules`, { query }),
    invoiceAccountingRule: (ruleId) => request("GET", `/invoice-accounting-rules/${id(ruleId)}`),
    prepareInvoiceAccountingRule: (companyId, body) => request("POST", `/companies/${id(companyId)}/invoice-accounting-rules`, { body }),
    reviseInvoiceAccountingRule: (ruleId, body) => request("POST", `/invoice-accounting-rules/${id(ruleId)}/revise`, { body }),
    registerInvoiceLedger: (requestId, body) => request("POST", `/invoice-requests/${id(requestId)}/ledger`, { body }),
    invoiceLedger: (orderId, query) => request("GET", `/orders/${id(orderId)}/invoice-ledger`, { query }),
    invoiceLedgerEntry: (ledgerId, query) => request("GET", `/invoice-ledger/${id(ledgerId)}`, { query }),
    prepareInvoiceAccounting: (ledgerId, body) => request("POST", `/invoice-ledger/${id(ledgerId)}/accounting-drafts`, { body }),
    reviseInvoiceAccounting: (draftId, body) => request("POST", `/invoice-accounting-drafts/${id(draftId)}/revise`, { body }),
    invoiceAccountingDraft: (draftId) => request("GET", `/invoice-accounting-drafts/${id(draftId)}`),
    downloadInvoiceAccounting: (draftId, format) => request("GET", `/invoice-accounting-drafts/${id(draftId)}/export`, {
      query: { format },
      binary: true,
      expectedType: format === "json" ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    invoiceResults: (requestId, query) => request("GET", `/invoice-requests/${id(requestId)}/result-records`, { query }),
    prepareInvoiceResult: (requestId, body) => request("POST", `/invoice-requests/${id(requestId)}/result-records`, { body }),
    uploadInvoiceEvidence: (orderId, { version, key, purpose, name, bytes }) => {
      if (!["authorization", "receipt"].includes(purpose)) throw new Error("\u8BF7\u9009\u62E9\u6388\u6743\u51ED\u8BC1\u6216\u5F00\u7968\u56DE\u6267");
      const form = new FormData();
      form.set("file", new Blob([bytes]), name);
      return request("POST", `/orders/${id(orderId)}/files`, { query: { version, key, kind: "evidence", category: purpose === "authorization" ? "\u5BA2\u6237\u5F00\u7968\u6388\u6743\u51ED\u8BC1" : "\u5F00\u7968\u7ED3\u679C\u56DE\u6267" }, body: form, multipart: true });
    },
    returnRun: (runId, body) => request("POST", `/runs/${id(runId)}/return`, { body }),
    uploadRunResult: (runId, { version, key, name, bytes }) => {
      const form = new FormData();
      form.set("file", new Blob([bytes]), name);
      return request("POST", `/runs/${id(runId)}/files`, { query: { version, key }, body: form, multipart: true });
    }
  };
}
var init_team_api_client = __esm({
  "src/team-api-client.mjs"() {
  }
});

// src/team-adapter.mjs
init_team_api_client();
import { realpath, readFile as readFile2, stat, writeFile as writeFile2, open, link, unlink as unlink2 } from "node:fs/promises";
import path2 from "node:path";
import { randomUUID as randomUUID2, createHash } from "node:crypto";

// src/team-credentials.mjs
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
function crypt(input, operation) {
  if (process.platform !== "win32") throw new Error("\u672C\u673A\u6388\u6743\u76EE\u524D\u4EC5\u652F\u6301 Windows\uFF1B\u8BF7\u4F7F\u7528\u72EC\u7ACB Windows \u8D26\u53F7");
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $x=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[System.Security.Cryptography.ProtectedData]::${operation}($x,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($v))`;
  const p = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { input: Buffer.from(input).toString("base64"), encoding: "utf8", windowsHide: true, maxBuffer: 65536 });
  if (p.error || p.status !== 0) throw new Error("Windows \u7528\u6237\u51ED\u636E\u4FDD\u62A4\u4E0D\u53EF\u7528\uFF0C\u672A\u4FDD\u5B58\u6388\u6743");
  return Buffer.from(p.stdout.trim(), "base64");
}
function sessionFile() {
  if (!process.env.LOCALAPPDATA) throw new Error("\u65E0\u6CD5\u627E\u5230\u5F53\u524D Windows \u7528\u6237\u76EE\u5F55");
  return path.join(process.env.LOCALAPPDATA, "ZYFinance", "workbuddy-session.dat");
}
async function saveTeamSession(value) {
  const file = sessionFile(), dir = path.dirname(file);
  const encrypted = crypt(Buffer.from(JSON.stringify(value)), "Protect");
  await mkdir(dir, { recursive: true, mode: 448 });
  const temp = path.join(dir, `session-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, encrypted, { flag: "wx", mode: 384 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {
    });
  }
}
async function loadTeamSession() {
  if (process.platform !== "win32") throw new Error("\u5C1A\u672A\u6388\u6743\uFF1A\u672C\u673A\u5458\u5DE5\u6388\u6743\u76EE\u524D\u4EC5\u652F\u6301 Windows");
  let encrypted;
  try {
    encrypted = await readFile(sessionFile());
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("\u5C1A\u672A\u6388\u6743\uFF1A\u8BF7\u5728\u672C\u4EBA Windows \u8D26\u53F7\u4E2D\u8FD0\u884C zy-finance-team login");
    throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u672C\u673A\u5458\u5DE5\u6388\u6743");
  }
  try {
    const value = JSON.parse(crypt(encrypted, "Unprotect").toString("utf8"));
    if (!value || typeof value !== "object" || !value.baseUrl || !value.session || !value.csrf) throw new Error("invalid");
    return value;
  } catch {
    throw new Error("\u672C\u673A\u5458\u5DE5\u6388\u6743\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
  }
}
async function clearTeamSession() {
  await unlink(sessionFile()).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}
function defaultWorkspace() {
  return path.join(os.homedir(), "Documents", "ZY-Finance-WorkBuddy");
}
async function authorizeEmployee({ baseUrl, username, password, workspace }) {
  const { createTeamClient: createTeamClient2 } = await Promise.resolve().then(() => (init_team_api_client(), team_api_client_exports));
  createTeamClient2({ baseUrl, session: "0".repeat(64), csrf: "0".repeat(64) });
  if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(username || "")) throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u7684\u56E2\u961F\u8D26\u53F7");
  if (typeof password !== "string" || password.length > 128) throw new Error("\u5BC6\u7801\u683C\u5F0F\u4E0D\u6B63\u786E");
  const response = await fetch(new URL("/api/v1/auth/login", baseUrl), { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(3e4) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "\u767B\u5F55\u5931\u8D25");
  if (result.user?.must_change_password) throw new Error("\u8BF7\u5148\u5728\u56E2\u961F\u7248\u7F51\u9875\u4FEE\u6539\u521D\u59CB\u5BC6\u7801\uFF0C\u518D\u8FDB\u884C\u6388\u6743");
  const session = response.headers.get("set-cookie")?.match(/(?:^|,\s*)zy_session=([a-f0-9]{64})/i)?.[1];
  if (!session || !/^[a-f0-9]{64}$/.test(result.csrf || "")) throw new Error("\u56E2\u961F\u670D\u52A1\u672A\u8FD4\u56DE\u6709\u6548\u5458\u5DE5\u4F1A\u8BDD");
  workspace = path.resolve(workspace || defaultWorkspace());
  await mkdir(workspace, { recursive: true, mode: 448 });
  await saveTeamSession({ baseUrl, session, csrf: result.csrf, workspace });
  return { ok: true, name: result.user.name, role: result.user.role, workspace };
}

// src/team-adapter.mjs
async function teamClientFromEnvironment(env = process.env) {
  const synthetic = env.ZY_BRIDGE_SYNTHETIC_TEST === "1" && env.ZY_TEAM_URL === "http://127.0.0.1:8081";
  const auth = synthetic ? { baseUrl: env.ZY_TEAM_URL, session: env.ZY_TEAM_SESSION, csrf: env.ZY_TEAM_CSRF, workspace: env.ZY_TEAM_WORKSPACE } : await loadTeamSession();
  const client = createTeamClient(auth);
  client.workspace = auth.workspace || defaultWorkspace();
  return client;
}
async function workspacePath(file, forOutput = false, workspace) {
  workspace ||= process.env.ZY_TEAM_WORKSPACE;
  if (!workspace) throw new Error("\u8BF7\u5148\u8BBE\u7F6E\u7528\u4E8E\u4EA4\u63A5\u7684\u672C\u673A\u5DE5\u4F5C\u76EE\u5F55");
  if (typeof file !== "string" || !file || path2.isAbsolute(file)) throw new Error("\u6587\u4EF6\u5FC5\u987B\u4F7F\u7528\u5DE5\u4F5C\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84");
  const root = await realpath(workspace);
  const absolute = path2.resolve(root, file);
  const parent = await realpath(forOutput ? path2.dirname(absolute) : absolute);
  const relative = path2.relative(root, parent);
  if (relative === ".." || relative.startsWith(".." + path2.sep) || path2.isAbsolute(relative)) throw new Error("\u6587\u4EF6\u4E0D\u5728\u6388\u6743\u4EA4\u63A5\u76EE\u5F55\u5185");
  return forOutput ? path2.join(parent, path2.basename(absolute)) : parent;
}
async function saveHandoff(dest, bytes) {
  const temporary = path2.join(path2.dirname(dest), `.invoice-handoff-${randomUUID2()}.tmp`);
  const handle = await open(temporary, "wx", 384);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, dest);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("\u4EA4\u63A5\u6587\u4EF6\u5DF2\u5B58\u5728\uFF0C\u672A\u8986\u76D6\uFF1B\u8BF7\u6838\u5B9E\u4E0A\u6B21\u4E0B\u8F7D\u6216\u6307\u5B9A\u53E6\u4E00\u4E2A\u8F93\u51FA\u6587\u4EF6\u540D\u3002");
      throw error;
    }
  } finally {
    await unlink2(temporary).catch(() => {
    });
  }
}
async function executeTeamCommand(client, command, args = {}) {
  switch (command) {
    case "me":
      return client.me();
    case "companies":
      return client.companies(args);
    case "client-dossier":
      return client.dossier(args.companyId, args.period);
    case "client-dossier-revision":
      return client.dossierRevision(args.companyId, args.revisionId);
    case "client-dossier-draft":
      return client.dossierDraft(args.companyId, args.draftId);
    case "prepare-client-dossier": {
      const { companyId, ...body } = args;
      return client.createDossierDraft(companyId, body);
    }
    case "orders":
      return client.orders(args);
    case "order":
      return client.order(args.orderId);
    case "files": {
      const { orderId, ...query } = args;
      return client.files(orderId, query);
    }
    case "workflows":
      return client.workflows();
    case "workflow":
      return client.workflow(args.workflowId);
    case "jobs":
      return client.jobs();
    case "download-file":
    case "workflow-template":
    case "accounting-template": {
      const dest = await workspacePath(args.filePath, true, client.workspace);
      const bytes = command === "download-file" ? await client.downloadFile(args.fileId) : command === "workflow-template" ? await client.workflowTemplate(args.workflowId) : await client.accountingTemplate();
      await writeFile2(dest, bytes, { flag: "wx", mode: 384 });
      return { filePath: args.filePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    case "start-accounting":
    case "start-prepared-workflow":
    case "upload-accounting-input": {
      const source = await workspacePath(args.filePath, false, client.workspace);
      const info = await stat(source);
      if (!info.isFile() || info.size > 10 * 1024 * 1024 || !/\.xlsx$/i.test(source)) throw new Error("\u6574\u7406\u5E95\u7A3F\u5FC5\u987B\u4E3A 10 MB \u4EE5\u5185\u7684\u6807\u51C6 XLSX");
      if (command === "start-accounting" && !["monthly-management-report", "vat-monthly-check"].includes(args.workflowId)) throw new Error("\u8BF7\u9009\u62E9\u652F\u6301\u540E\u53F0\u8D26\u52A1\u8BA1\u7B97\u7684\u5DE5\u4F5C\u6D41");
      if (command === "start-prepared-workflow" && !/^[a-z][a-z0-9-]{0,99}$/.test(args.workflowId || "")) throw new Error("\u8BF7\u6307\u5B9A\u5DE5\u4F5C\u6D41\u7F16\u53F7");
      return client.uploadAccountingInput(args.orderId, { ...args, name: path2.basename(source), bytes: await readFile2(source) });
    }
    case "package":
      return client.createJob({ kind: "run_export", key: args.key, companyId: args.companyId, payload: { runId: args.runId } });
    case "download-package": {
      const dest = await workspacePath(args.filePath, true, client.workspace);
      const bytes = await client.downloadJob(args.jobId);
      await writeFile2(dest, bytes, { flag: "wx", mode: 384 });
      return { filePath: args.filePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    case "upload-result": {
      const source = await workspacePath(args.filePath, false, client.workspace);
      const info = await stat(source);
      if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error("\u6210\u679C\u5FC5\u987B\u662F 50 MB \u4EE5\u5185\u7684\u666E\u901A\u6587\u4EF6");
      const bytes = await readFile2(source);
      return client.uploadRunResult(args.runId, { version: args.version, key: args.key || randomUUID2(), name: path2.basename(source), bytes });
    }
    case "create-run": {
      const { orderId, ...body } = args;
      return client.createRun(orderId, body);
    }
    case "start-workflow": {
      const { orderId, ...body } = args;
      return client.startWorkflow(orderId, body);
    }
    case "workflow-status":
      return client.workflowStatus(args.runId);
    case "calculation": {
      const { runId, ...query } = args;
      return client.calculation(runId, query);
    }
    case "return-calculation": {
      const { runId, ...body } = args;
      return client.returnCalculation(runId, body);
    }
    case "revise-workflow": {
      const { runId, ...body } = args;
      return client.reviseRun(runId, body);
    }
    case "retry-job":
      return client.retryJob(args.jobId);
    case "invoicing-capabilities":
      return client.invoicingCapabilities();
    case "invoice-requests": {
      const { orderId, ...query } = args;
      return client.invoiceRequests(orderId, query);
    }
    case "prepare-invoice": {
      const { orderId, ...body } = args;
      return client.prepareInvoice(orderId, body);
    }
    case "invoice-request":
      return client.invoiceRequest(args.requestId);
    case "revise-invoice": {
      const { requestId, ...body } = args;
      return client.reviseInvoice(requestId, body);
    }
    case "invoice-revisions": {
      const { requestId, ...query } = args;
      return client.invoiceRevisions(requestId, query);
    }
    case "invoice-authorizations": {
      const { companyId, ...query } = args;
      return client.invoiceAuthorizations(companyId, query);
    }
    case "invoice-authorization":
      return client.invoiceAuthorization(args.authorizationId);
    case "prepare-invoice-authorization": {
      const { orderId, ...body } = args;
      return client.prepareInvoiceAuthorization(orderId, body);
    }
    case "prepare-invoice-batch":
      return client.prepareInvoiceBatch(args);
    case "invoice-batches":
      return client.invoiceBatches(args);
    case "invoice-batch":
      return client.invoiceBatch(args.batchId);
    case "invoice-batch-actions":
      return client.invoiceBatchActions(args.batchId);
    case "continue-invoice-batch": {
      const { batchId, ...body } = args;
      return client.continueInvoiceBatch(batchId, body);
    }
    case "invoice-continuation":
      return client.invoiceContinuation(args.continuationId);
    case "invoice-accounting-context":
      return client.invoiceAccountingContext(args.companyId, args.period);
    case "invoice-accounting-rules": {
      const { companyId, ...query } = args;
      return client.invoiceAccountingRules(companyId, query);
    }
    case "invoice-accounting-rule":
      return client.invoiceAccountingRule(args.ruleId);
    case "prepare-invoice-accounting-rule": {
      const { companyId, ...body } = args;
      return client.prepareInvoiceAccountingRule(companyId, body);
    }
    case "revise-invoice-accounting-rule": {
      const { ruleId, ...body } = args;
      return client.reviseInvoiceAccountingRule(ruleId, body);
    }
    case "register-invoice-ledger": {
      const { requestId, ...body } = args;
      return client.registerInvoiceLedger(requestId, body);
    }
    case "invoice-ledger": {
      const { orderId, ...query } = args;
      return client.invoiceLedger(orderId, query);
    }
    case "invoice-ledger-entry": {
      const { ledgerId, ...query } = args;
      return client.invoiceLedgerEntry(ledgerId, query);
    }
    case "prepare-invoice-accounting": {
      const { ledgerId, ...body } = args;
      return client.prepareInvoiceAccounting(ledgerId, body);
    }
    case "revise-invoice-accounting": {
      const { draftId, ...body } = args;
      return client.reviseInvoiceAccounting(draftId, body);
    }
    case "invoice-accounting-draft":
      return client.invoiceAccountingDraft(args.draftId);
    case "download-invoice-accounting": {
      if (!["json", "xlsx"].includes(args.format)) throw new Error("\u4EA4\u63A5\u6210\u679C\u683C\u5F0F\u987B\u4E3A json \u6216 xlsx");
      if (path2.extname(args.filePath).toLowerCase() !== "." + args.format) throw new Error("\u8F93\u51FA\u6587\u4EF6\u6269\u5C55\u540D\u987B\u4E0E\u4EA4\u63A5\u6210\u679C\u683C\u5F0F\u4E00\u81F4");
      const dest = await workspacePath(args.filePath, true, client.workspace);
      const bytes = await client.downloadInvoiceAccounting(args.draftId, args.format);
      await saveHandoff(dest, bytes);
      return {
        draftId: args.draftId,
        format: args.format,
        filePath: args.filePath,
        absolutePath: dest,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        state: "downloaded",
        posted: false,
        nextAction: "\u5DF2\u4FDD\u5B58\u4EBA\u5DE5\u6838\u9A8C\u540E\u7684\u4EA4\u63A5\u6210\u679C\uFF0C\u53EF\u5411\u7528\u6237\u8FD4\u56DE\u4FDD\u5B58\u4F4D\u7F6E\u3002\u672A\u5199\u5165\u6B63\u5F0F\u8D26\u5957\uFF1B\u65E0\u9700\u91CD\u65B0\u4E0A\u4F20\u4E3A\u539F\u59CB\u8D44\u6599\u3002"
      };
    }
    case "invoice-results": {
      const { requestId, ...query } = args;
      return client.invoiceResults(requestId, query);
    }
    case "prepare-invoice-result": {
      const { requestId, ...body } = args;
      return client.prepareInvoiceResult(requestId, body);
    }
    case "upload-invoice-evidence": {
      const source = await workspacePath(args.filePath, false, client.workspace);
      const info = await stat(source);
      if (!info.isFile() || info.size > 50 * 1024 * 1024 || !/\.(pdf|png|jpe?g)$/i.test(source)) throw new Error("\u6388\u6743\u6216\u5F00\u7968\u51ED\u8BC1\u987B\u4E3A 50 MB \u4EE5\u5185\u7684 PDF\u3001PNG \u6216 JPG \u539F\u4EF6");
      return client.uploadInvoiceEvidence(args.orderId, { ...args, name: path2.basename(source), bytes: await readFile2(source) });
    }
    case "return-run": {
      const { runId, ...body } = args;
      return client.returnRun(runId, body);
    }
    default:
      throw new Error("\u672A\u77E5\u56E2\u961F\u547D\u4EE4");
  }
}

// src/team-cli.mjs
async function parseParameters(values, command) {
  if (values.length === 0) return {};
  if (values.length === 1 && values[0] === "--json-stdin") {
    if (command === "login") throw new Error("\u5458\u5DE5\u767B\u5F55\u5BC6\u7801\u53EA\u80FD\u4ECE\u672C\u673A\u4EA4\u4E92\u7EC8\u7AEF\u8F93\u5165");
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > 6 * 1024 * 1024) throw new Error("\u53C2\u6570\u8FC7\u5927");
    }
    return JSON.parse(data);
  }
  if (values.every((value) => value.startsWith("--") && value.includes("="))) {
    return Object.fromEntries(values.map((value) => {
      const i = value.indexOf("=");
      return [value.slice(2, i), value.slice(i + 1)];
    }));
  }
  if (values.length === 1) return JSON.parse(values[0]);
  throw new Error("\u8BF7\u4F7F\u7528 --\u5B57\u6BB5=\u503C \u6216 --json-stdin \u8F93\u5165\u53C2\u6570");
}
async function passwordPrompt() {
  if (!process.stdin.isTTY) throw new Error("\u5458\u5DE5\u767B\u5F55\u5FC5\u987B\u5728\u672C\u673A\u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u4E2D\u8F93\u5165\u5BC6\u7801\uFF0C\u4E0D\u80FD\u7531 AI \u4F20\u5165");
  process.stderr.write("\u56E2\u961F\u8D26\u53F7\u5BC6\u7801\uFF08\u4E0D\u663E\u793A\uFF09\uFF1A");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let password = "";
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", input);
      process.stderr.write("\n");
    };
    const input = (chunk) => {
      for (const char of chunk) {
        if (char === "") {
          done();
          reject(new Error("\u5DF2\u53D6\u6D88\u767B\u5F55"));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          resolve(password);
          return;
        }
        if (char === "\x7F" || char === "\b") password = password.slice(0, -1);
        else if (char >= " " && password.length < 128) password += char;
      }
    };
    process.stdin.on("data", input);
  });
}
async function login(args) {
  const baseUrl = args.url || "http://127.0.0.1:8080";
  const password = await passwordPrompt();
  console.log(JSON.stringify(await authorizeEmployee({ baseUrl, username: args.username, password, workspace: args.workspace })));
}
try {
  const [command, ...values] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log("\u56E2\u961F\u7248\uFF1Alogin\u3001logout\u3001local-logout\u3001me\u3001companies\u3001client-dossier\u3001client-dossier-revision\u3001client-dossier-draft\u3001prepare-client-dossier\u3001orders\u3001order\u3001files\u3001workflows\u3001workflow\u3001jobs\u3001start-workflow\u3001workflow-status\u3001calculation\u3001return-calculation\u3001revise-workflow\u3001retry-job\u3001accounting-template\u3001download-file\u3001upload-accounting-input\u3001start-accounting\u3001start-prepared-workflow\u3001workflow-template\u3001create-run\u3001package\u3001download-package\u3001upload-result\u3001return-run\u3001invoicing-capabilities\u3001invoice-requests\u3001prepare-invoice\u3001invoice-request\u3001revise-invoice\u3001invoice-revisions\u3001invoice-authorizations\u3001invoice-authorization\u3001prepare-invoice-authorization\u3001prepare-invoice-batch\u3001invoice-batches\u3001invoice-batch\u3001upload-invoice-evidence\u3001prepare-invoice-result\u3001invoice-results\u3001invoice-batch-actions\u3001continue-invoice-batch\u3001invoice-continuation\u3001invoice-accounting-context\u3001invoice-accounting-rules\u3001invoice-accounting-rule\u3001prepare-invoice-accounting-rule\u3001revise-invoice-accounting-rule\u3001register-invoice-ledger\u3001invoice-ledger\u3001invoice-ledger-entry\u3001prepare-invoice-accounting\u3001revise-invoice-accounting\u3001invoice-accounting-draft\u3001download-invoice-accounting\u3002\u5F00\u7968\u5DE5\u5177\u767B\u8BB0\u6388\u6743\u3001\u51C6\u5907\u7533\u8BF7\u3001\u56DE\u5F55\u5B9E\u9645\u7ED3\u679C\u8349\u7A3F\uFF1B\u4E0D\u6838\u9A8C\u3001\u4E0D\u5F00\u5177\uFF1B\u6863\u6848\u8349\u7A3F\u987B\u5728\u7F51\u9875\u7531\u5458\u5DE5\u786E\u8BA4\uFF1B\u53C2\u6570\u53EF\u7531 --\u5B57\u6BB5=\u503C \u6216 --json-stdin \u8F93\u5165\u3002");
  } else if (command === "login") {
    await login(await parseParameters(values, command));
  } else if (command === "local-logout") {
    await clearTeamSession();
    console.log("\u672C\u673A\u6388\u6743\u5DF2\u6E05\u9664\uFF1B\u8981\u64A4\u9500\u670D\u52A1\u7AEF\u4F1A\u8BDD\uFF0C\u8BF7\u5728\u56E2\u961F\u7248\u7F51\u9875\u9000\u51FA\u767B\u5F55\u3002");
  } else if (command === "logout") {
    const client = await teamClientFromEnvironment();
    try {
      await client.logoutCurrent();
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    await clearTeamSession();
    console.log("\u672C\u673A\u6388\u6743\u5DF2\u6E05\u9664\uFF0C\u5F53\u524D\u8BBE\u5907\u4F1A\u8BDD\u5DF2\u64A4\u9500\u6216\u5DF2\u8FC7\u671F\u3002");
  } else {
    const result = await executeTeamCommand(await teamClientFromEnvironment(), command, await parseParameters(values, command));
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
