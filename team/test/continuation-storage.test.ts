import { test } from "node:test";
import assert from "node:assert/strict";
import { continuationStorage } from "../web/continuation-storage.js";
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } as unknown as Storage;
}
test("关闭后恢复补件、说明和原提交；账号、机构与批次隔离", () => {
  const storage = memory(),
    scope = "org:actor:batch";
  const store = continuationStorage(storage, scope, ["item"]);
  const value = {
    selections: {
      item: {
        changes: { payload: { buyerName: "虚构购方" } },
        expected: { orderVersion: 3 },
      },
    },
    reason: "补齐原资料",
    editorId: "item",
    pendingSubmission: {
      key: "original",
      items: [{ itemId: "item", orderVersion: 3 }],
    },
  };
  store.write(value);
  assert.deepEqual(continuationStorage(storage, scope, ["item"]).value, value);
  for (const other of [
    "org:other:batch",
    "other:actor:batch",
    "org:actor:other",
  ])
    assert.deepEqual(
      continuationStorage(storage, other, ["item"]).value.selections,
      {},
    );
});
test("客户撤权后不恢复其资料，也不缩小原请求重发", () => {
  const storage = memory();
  continuationStorage(storage, "scope", ["a", "b"]).write({
    selections: { a: { text: "A" }, b: { text: "B" } },
    editorId: "b",
    pendingSubmission: {
      key: "original",
      items: [{ itemId: "a" }, { itemId: "b" }],
    },
  });
  const restored = continuationStorage(storage, "scope", ["a"]).value;
  assert.deepEqual(Object.keys(restored.selections), ["a"]);
  assert.equal(restored.editorId, null);
  assert.equal(restored.pendingSubmission, null);
  assert.equal(restored.unavailableSubmission, true);
});
test("两个页面不会静默覆盖，损坏及空间不足不会报告已暂存", () => {
  const storage = memory(),
    first = continuationStorage(storage, "scope", []),
    second = continuationStorage(storage, "scope", []);
  first.write({ selections: {}, reason: "first" });
  assert.throws(
    () => second.write({ selections: {}, reason: "second" }),
    /另一页面/,
  );
  storage.setItem("zy.invoice-continuation.v1:bad", "broken");
  assert.throws(() => continuationStorage(storage, "bad", []), /未能读取/);
  const failed = continuationStorage(
    {
      getItem: () => null,
      setItem: () => {
        throw Error("quota");
      },
    } as unknown as Storage,
    "scope",
    [],
  );
  assert.throws(() => failed.write({}), /quota/);
});
