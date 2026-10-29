// Only form drafts, never sessions or passwords. The caller must first load the
// authenticated actor and the currently accessible batch from the server.
export function continuationStorage(
  storage: Storage,
  scope: string,
  allowedIds: string[],
) {
  const key = `zy.invoice-continuation.v1:${scope}`;
  let baseline = storage.getItem(key);
  let restored = false;
  let value: any = {
    selections: {},
    reason: "",
    editorId: null,
    pendingSubmission: null,
  };
  if (baseline) {
    try {
      const saved = JSON.parse(baseline);
      if (saved.schema !== 1 || !saved.value?.selections)
        throw Error("invalid");
      value = saved.value;
      restored = true;
      const allowed = new Set(allowedIds);
      value.selections = Object.fromEntries(
        Object.entries(value.selections).filter(([id]) => allowed.has(id)),
      );
      if (!allowed.has(value.editorId)) value.editorId = null;
      if (
        value.pendingSubmission?.items?.some(
          (item: any) => !allowed.has(item.itemId),
        )
      ) {
        // Never replay a smaller request under the original key, or expose the
        // saved fields of a customer whose access has been revoked.
        value.pendingSubmission = null;
        value.unavailableSubmission = true;
      }
    } catch {
      throw Error(
        "未能读取上次填写，请保留当前页面并联系负责人核实，避免重复提交。",
      );
    }
  }
  return {
    value,
    restored,
    write(next: any) {
      if (storage.getItem(key) !== baseline)
        throw Error(
          "另一页面已保存了更新内容。本页填写仍在，请重新打开批次查看最新暂存，勿重复提交。",
        );
      const encoded = JSON.stringify({
        schema: 1,
        updatedAt: new Date().toISOString(),
        value: next,
      });
      storage.setItem(key, encoded);
      baseline = encoded;
    },
  };
}
