"use client";
import { useCallback, useEffect, useState } from "react";
import type { PiecesKey } from "unhuntable-client/keys";
import { loadPiecesKey } from "./vault";

export type KeyState = { status: "loading" } | { status: "missing" } | { status: "ok"; key: PiecesKey } | { status: "error"; message: string };

/** The pieces key kept on this device for the account, if any. */
export function usePiecesKey(account: string | undefined) {
  const [state, setState] = useState<KeyState>({ status: "loading" });
  const reload = useCallback(async () => {
    if (!account) return;
    try {
      const key = await loadPiecesKey(account);
      setState(key ? { status: "ok", key } : { status: "missing" });
    } catch {
      setState({ status: "error", message: "This browser could not open its saved pieces key. Restore it from your 12 words." });
    }
  }, [account]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { state, reload };
}
