"use client";
import { useEffect, useState } from "react";
import { sentence } from "../lib/api";
import { usd } from "../lib/format";
import { api } from "../lib/session";
import type { Settings } from "../lib/types";
import { Notice } from "./ui";

/** Auto-refill: when the guard cuts a piece, top it back up from the private balance, within a daily limit. */
export function Refills() {
  const [s, setS] = useState<Settings | undefined>();
  const [on, setOn] = useState(false);
  const [cap, setCap] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setS(r);
        setOn(r.autoRefill);
        setCap(r.refillCapUsdPerDay ? String(r.refillCapUsdPerDay) : "50");
      })
      .catch((e) => setMsg({ kind: "error", text: sentence(e) }));
  }, []);

  async function save() {
    setBusy(true);
    setMsg(undefined);
    try {
      const n = Number(cap);
      if (!Number.isFinite(n) || n < 0) throw new Error("The daily limit must be an amount in dollars.");
      const r = await api.saveSettings({ autoRefill: on, refillCapUsdPerDay: n });
      setS(r);
      setMsg({ kind: "ok", text: r.autoRefill ? `Auto-refill is on, up to ${usd(r.refillCapUsdPerDay)} a day.` : "Auto-refill is off." });
    } catch (e) {
      setMsg({ kind: "error", text: sentence(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="refills">
      <h2>Auto-refill</h2>
      <p className="small muted">
        When the guard cuts a piece to keep it away from liquidation, it can top that piece back up from your private balance, never from another piece, up to a
        daily limit you set.
      </p>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!s} />
        Refill cut pieces
      </label>
      <label htmlFor="refill-cap">Daily limit, in dollars</label>
      <div className="inline">
        <input id="refill-cap" inputMode="decimal" autoComplete="off" value={cap} onChange={(e) => setCap(e.target.value)} disabled={!s} />
        <button type="button" className="secondary" disabled={busy} onClick={save}>
          Save
        </button>
      </div>
      {s && s.autoRefill && (
        <p className="small muted" data-testid="refilled-today">
          Refilled today: {usd(s.refilledTodayUsd)} of {usd(s.refillCapUsdPerDay)}
        </p>
      )}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
    </div>
  );
}
