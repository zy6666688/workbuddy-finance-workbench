import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toggleFileSelection,
  fileScopeKey,
  filePageQuery,
} from "../web/file-selection.js";

test("cross-page selection retains UUIDs and distinct same-name versions", () => {
  let ids = toggleFileSelection([], "page1-version1", true);
  ids = toggleFileSelection(ids, "page2-version2", true);
  ids = toggleFileSelection(ids, "page1-version1", true);
  assert.deepEqual(ids, ["page1-version1", "page2-version2"]);
  assert.deepEqual(toggleFileSelection(ids, "page1-version1", false), [
    "page2-version2",
  ]);
});

test("100-file boundary rejects additional choices without mutating previous selections", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(i));
  assert.throws(() => toggleFileSelection(ids, "101", true), /100/);
  assert.equal(ids.length, 100);
  assert.equal(toggleFileSelection(ids, "1", true).length, 100);
  assert.equal(toggleFileSelection(ids, "1", false).length, 99);
  assert.throws(() => toggleFileSelection(["one"], "two", true, 1), /1/);
});

test("scope identity separates company, period and order", () => {
  const base = { companyId: "a", period: "2026-01", orderId: "1" };
  assert.notEqual(
    fileScopeKey(base),
    fileScopeKey({ ...base, companyId: "b" }),
  );
  assert.notEqual(
    fileScopeKey(base),
    fileScopeKey({ ...base, period: "2026-02" }),
  );
  assert.notEqual(fileScopeKey(base), fileScopeKey({ ...base, orderId: "2" }));
});

test("paged queries keep ownership filters and revision token, first page drops old token", () => {
  const options = {
    scope: { companyId: "a", period: "2026-01" },
    purpose: "result",
    origin: "workbuddy",
    runId: "run-a",
    eligibleOnly: true,
    latestOnly: true,
    offset: 1000,
    pageVersion: "v1",
    search: "流水 & 核对",
    pinned: true,
  };
  const query = filePageQuery(options);
  assert.equal(query.get("period"), "2026-01");
  assert.equal(query.get("runId"), "run-a");
  assert.equal(query.get("origin"), "workbuddy");
  assert.equal(query.get("eligibleOnly"), "true");
  assert.equal(query.get("pageVersion"), "v1");
  assert.equal(query.get("search"), "流水 & 核对");
  assert.equal(query.get("pinnedOnly"), "true");
  assert.equal(
    filePageQuery({ ...options, offset: 0 }).has("pageVersion"),
    false,
  );
});

test("delivery evidence only lists eligible documents and order scope has no period override", () => {
  const q = filePageQuery({
    scope: { companyId: "a", period: "2026-01", orderId: "o" },
    purpose: "evidence",
  });
  assert.equal(q.get("eligibleOnly"), "true");
  assert.equal(q.has("period"), false);
});
