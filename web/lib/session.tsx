"use client";
// Who is signed in (GET /api/me), shared by every screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Api, ApiError } from "./api";
import type { Me } from "./types";

export const api = new Api();

type MeState = { status: "loading" } | { status: "signed_out"; message: string } | { status: "error"; message: string } | { status: "ok"; me: Me };

const Ctx = createContext<{ me: MeState; refresh: () => Promise<void> }>({ me: { status: "loading" }, refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const refresh = useCallback(async () => {
    try {
      setMe({ status: "ok", me: await api.me() });
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_signed_in") setMe({ status: "signed_out", message: e.message });
      else setMe({ status: "error", message: e instanceof Error ? e.message : "Something went wrong. Try again." });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ me, refresh }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

/** Run fn every ms while the screen is open; the first run is immediate. null stops it. */
export function useInterval(fn: () => void | Promise<void>, ms: number | null) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (ms === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await latest.current();
      } catch {
        // each screen shows its own errors
      } finally {
        if (alive) timer = setTimeout(tick, ms);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [ms]);
}
