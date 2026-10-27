import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configureStore,
  clearStore,
  writeFinanceStore,
  readFinanceStore,
  getDraft,
  flushStore,
  storageIssueSnapshot,
} from "../web/server-store.js";

function config(
  companyId: string,
  version: number,
  request: any,
  extra: any = {},
) {
  return {
    companyId,
    period: "2026-10",
    saved: { version, state: {} },
    prefs: { _version: 0 },
    profile: { entity: companyId, period: "2026-10" },
    readOnly: false,
    request,
    onNotice: () => {},
    ...extra,
  };
}
afterEach(() => clearStore());

test("earlier team preferences remain available before desk preferences are first saved", () => {
  configureStore(
    config("A", 0, async () => ({}), {
      prefs: {
        favorites: ["bank-reconcile"],
        recent: ["old-order"],
        theme: "jade",
      },
    }),
  );
  assert.deepEqual(readFinanceStore("favorites", []), ["bank-reconcile"]);
  assert.deepEqual(readFinanceStore("recentOrders", []), ["old-order"]);
  assert.equal(readFinanceStore("theme", "indigo"), "jade");
});

test("company/account switch ignores late save responses and cancels unsent old-account writes", async () => {
  let finish: (value: any) => void = () => {};
  const oldCalls: any[] = [],
    newCalls: any[] = [];
  configureStore(
    config("A", 4, async (path: string, body: any) => {
      oldCalls.push({ path, body });
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  );
  writeFinanceStore("todos", [{ id: "A1" }]);
  writeFinanceStore("exceptions", [{ id: "A2" }]);
  await Promise.resolve();
  const oldFlush = flushStore();
  clearStore();
  configureStore(
    config("B", 7, async (path: string, body: any) => {
      newCalls.push({ path, body });
      return { version: body.version + 1 };
    }),
  );
  writeFinanceStore("todos", [{ id: "B1" }]);
  await flushStore();
  finish({ version: 5 });
  await oldFlush;
  writeFinanceStore("todos", [{ id: "B2" }]);
  await flushStore();
  assert.equal(
    oldCalls.length,
    1,
    "queued old-account write must not use the next login session",
  );
  assert.deepEqual(
    newCalls.map((c) => c.body.version),
    [7, 8],
  );
  assert.ok(newCalls.every((c) => c.path.includes("/B/")));
  assert.deepEqual(getDraft().todos, [{ id: "B2" }]);
});

test("late failure in a previous company cannot freeze the newly selected company", async () => {
  let rejectOld: (error: Error) => void = () => {};
  configureStore(
    config(
      "A",
      0,
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    ),
  );
  writeFinanceStore("todos", [{ id: "old" }]);
  await Promise.resolve();
  const oldFlush = flushStore();
  configureStore(config("B", 0, async () => ({ version: 1 })));
  rejectOld(new Error("记录已被其他同事修改"));
  await oldFlush;
  assert.equal(storageIssueSnapshot(), "");
  assert.equal(writeFinanceStore("todos", [{ id: "new" }]), true);
  await flushStore();
});

test("after save conflict exportable draft retains later edits without retrying stale data", async () => {
  let calls = 0;
  configureStore(
    config("A", 0, async () => {
      calls++;
      throw new Error("记录已被其他同事修改");
    }),
  );
  writeFinanceStore("todos", [{ id: "first" }]);
  await assert.rejects(flushStore(), /保存冲突/);
  assert.equal(
    writeFinanceStore("todos", [{ id: "edited-after-conflict" }]),
    false,
  );
  assert.deepEqual(getDraft().todos, [{ id: "edited-after-conflict" }]);
  assert.equal(calls, 1);
});

test("partial legacy settings merge defaults exactly as the personal plugin does", () => {
  configureStore(
    config("A", 1, async () => ({}), {
      saved: { version: 1, state: { settings: { varianceRate: 20 } } },
    }),
  );
  const defaults = { largeAmount: 100000, dateTolerance: 3, varianceRate: 10 };
  assert.deepEqual(readFinanceStore("settings", defaults), {
    ...defaults,
    varianceRate: 20,
  });
  assert.deepEqual(defaults, {
    largeAmount: 100000,
    dateTolerance: 3,
    varianceRate: 10,
  });
});

test("business saves use sequential versions and personal preferences keep a separate version", async () => {
  const calls: any[] = [];
  configureStore(
    config(
      "A",
      4,
      async (path: string, body: any) => {
        calls.push({ path, body });
        return { version: body.version + 1 };
      },
      { prefs: { _version: 9 } },
    ),
  );
  writeFinanceStore("todos", []);
  writeFinanceStore("favorites", ["bank-reconcile"]);
  writeFinanceStore("snapshots", [
    { period: "2026-09", income: "5" },
    { period: "2026-10", income: "6" },
  ]);
  await flushStore();
  assert.deepEqual(
    calls.map((c) => c.body.version),
    [4, 9, 5],
  );
  assert.deepEqual(calls[2].body.value, [{ period: "2026-10", income: "6" }]);
});
