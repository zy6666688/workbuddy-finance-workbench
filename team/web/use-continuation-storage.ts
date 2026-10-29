import { useRef, useState } from "preact/hooks";
import { continuationStorage } from "./continuation-storage.js";

export function useContinuationStorage(scope: string, ids: string[]) {
  const store = useRef<any>(null);
  const [error, setError] = useState("");
  const [value, setValue] = useState<any>(() => {
    try {
      store.current = continuationStorage(localStorage, scope, ids);
      return store.current.value;
    } catch {
      return {
        selections: {},
        reason: "",
        editorId: null,
        pendingSubmission: null,
      };
    }
  });
  const current = useRef(value);
  const update = (patch: any) => {
    const next =
      typeof patch === "function"
        ? patch(current.current)
        : { ...current.current, ...patch };
    current.current = next;
    setValue(next);
    try {
      if (!store.current)
        throw Error(
          "浏览器暂存不可用，请保留当前页面；恢复暂存后才能提交续办。",
        );
      store.current.write(next);
      setError("");
      return true;
    } catch (e: any) {
      setError(e.message || "暂存失败，请勿关闭页面。");
      return false;
    }
  };
  return {
    value,
    update,
    restored: !!store.current?.restored,
    error:
      error ||
      (!store.current
        ? "浏览器暂存不可用，当前填写尚未保存，请勿关闭页面。"
        : ""),
  };
}
