"use client";
import Link from "next/link";
import { useState } from "react";
import { Facts, Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { num, pct, time, usd } from "../../lib/format";
import { pieceAddress } from "../../lib/pieces";
import { api, useInterval } from "../../lib/session";
import { GUARD_UNREACHABLE, STOP_COPY, hyperliquidPage, sealLevels, sealOpened } from "../../lib/stops";
import type { Me, Position } from "../../lib/types";
import { usePiecesKey } from "../../lib/usekey";
import { loadRecord, updateRecord, type DeviceRecord } from "../../lib/vault";


const STATE_WORDS: Record<string, string> = {
  planned: "Planned",
  funding: "Funding the pieces",
  policy_wait: "Waiting for your wallet approval",
  opening: "Opening",
  open: "Open",
  closing: "Closing",
  closed: "Closed",
  failed: "Stopped",
};

function PositionCard({ p, account, record, onRecord }: { p: Position; account: string; record: DeviceRecord; onRecord: () => void }) {
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const levels = record.levels[p.id] ?? {};
  const unreachable = p.pieces.some((x) => x.guard === "unreachable");
  const guardSentence = p.alerts.find((a) => /guard/i.test(a.text))?.text ?? GUARD_UNREACHABLE;
  const live = p.state !== "closed" && p.state !== "failed";

  async function run(f: () => Promise<string>) {
    setBusy(true);
    setMsg(undefined);
    try {
      setMsg({ kind: "ok", text: await f() });
      onRecord();
    } catch (e) {
      setMsg({ kind: "error", text: sentence(e) });
    } finally {
      setBusy(false);
    }
  }

  const move = (which: "stop" | "tp", value: string) =>
    run(async () => {
      const v = Number(value);
      await sealLevels(api, account, p.id, p, which === "stop" ? { stop: v, jitterBps: Object.values(levels)[0]?.jitterBps } : { tp: v });
      which === "stop" ? setStop("") : setTp("");
      return which === "stop" ? STOP_COPY : "Your take-profit is sealed inside the guard, not on the exchange.";
    });

  const close = (now: boolean) =>
    run(async () => {
      const r = await api.close(p.id, now);
      return `Closing: ${STATE_WORDS[r.state] ?? r.state}.`;
    });

  return (
    <div className="card" data-testid="position">
      <h2>
        {p.coin} {p.side === "long" ? "Long" : "Short"} {usd(p.notionalUsd)} at {p.leverage}x
      </h2>
      <p>
        <span className="badge">{STATE_WORDS[p.state] ?? p.state}</span> <span className="muted small">{p.hiding === "whale" ? "Whale" : "Normal"} hiding</span>
      </p>
      {p.fillSavingsUsd !== undefined && <p className="small muted">Saved on fills by splitting: {usd(p.fillSavingsUsd)}</p>}
      {unreachable && live && (
        <>
          <Notice kind="error" testId="guard-unreachable">
            {guardSentence}
          </Notice>
          <button type="button" className="danger" disabled={busy} onClick={() => close(true)}>
            Close now
          </button>
        </>
      )}
      {p.pieces.map((x) => {
        const mine = levels[x.shard];
        const addr = record.addresses[x.label];
        return (
          <div key={x.shard} className="card" data-testid="piece">
            <Facts
              rows={[
                ["Piece", x.label],
                ["Size", `${num(x.size)} ${p.coin}`],
                ["Entry", x.entryPx === null ? "–" : usd(x.entryPx)],
                ["Liquidation", x.liqDistance === null ? "–" : `${pct(x.liqDistance)} away`],
                ["Guard", <span key="g" className={`badge ${x.guard === "ok" ? "ok" : "bad"}`}>{x.guard === "ok" ? "Watching" : "Not answering"}</span>],
                ["Invisible stop", x.hasStop ? (mine?.stop !== undefined ? `Set at ${num(mine.stop)}` : "Set") : "None"],
                ["Take-profit", x.hasTp ? (mine?.tp !== undefined ? `Set at ${num(mine.tp)}` : "Set") : "None"],
              ]}
            />
            {addr && (
              <a href={hyperliquidPage(addr)} target="_blank" rel="noopener noreferrer" className="small">
                Check it yourself: no stop is listed for this account on Hyperliquid
              </a>
            )}
          </div>
        );
      })}
      {hiddenLevels(p, levels) && <p className="small muted">Levels are kept only in the browser that set them.</p>}
      {p.alerts.length > 0 && (
        <>
          <h2>Alerts</h2>
          <ul className="plain" data-testid="alerts">
            {p.alerts.map((a, i) => (
              <li key={i}>
                <span className="muted small">{time(a.ms)}</span> {a.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {live && p.state === "open" && (
        <>
          <label htmlFor={`stop-${p.id}`}>Move stop to</label>
          <input id={`stop-${p.id}`} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
          <button type="button" className="secondary" disabled={busy || !stop} onClick={() => move("stop", stop)}>
            Move stop
          </button>
          <label htmlFor={`tp-${p.id}`}>Move take-profit to</label>
          <input id={`tp-${p.id}`} inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} />
          <button type="button" className="secondary" disabled={busy || !tp} onClick={() => move("tp", tp)}>
            Move take-profit
          </button>
        </>
      )}
      {live && (
        <div className="row-buttons">
          <button type="button" className="secondary" disabled={busy} onClick={() => close(false)}>
            Close
          </button>
          {!unreachable && (
            <button type="button" className="secondary" disabled={busy} onClick={() => close(true)}>
              Close now
            </button>
          )}
        </div>
      )}
      <Link className="button secondary" href="/home/">
        Send home
      </Link>
    </div>
  );
}

function hiddenLevels(p: Position, levels: Record<string, unknown>): boolean {
  return p.pieces.some((x) => (x.hasStop || x.hasTp) && !levels[x.shard]);
}

function Positions({ me }: { me: Me }) {
  const { state: keyState } = usePiecesKey(me.accountId);
  const [positions, setPositions] = useState<Position[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [record, setRecord] = useState<DeviceRecord>({ levels: {}, addresses: {}, waitingLevels: {} });
  const key = keyState.status === "ok" ? keyState.key : undefined;

  const reloadRecord = async () => setRecord(await loadRecord(me.accountId));

  useInterval(async () => {
    try {
      const r = await api.positions();
      setPositions(r.positions);
      setError(undefined);
      if (key) {
        await sealOpened(api, me.accountId, r.positions).catch((e) => setError(sentence(e)));
        const rec = await loadRecord(me.accountId);
        for (const label of new Set(r.positions.flatMap((p) => p.pieces.map((x) => x.label)))) {
          if (rec.addresses[label]) continue;
          try {
            const a = await pieceAddress({ api, key, account: me.accountId }, label);
            await updateRecord(me.accountId, (x) => void (x.addresses[label] = a));
          } catch {
            // the "Check it yourself" link shows once the address is known
          }
        }
      }
      await reloadRecord();
    } catch (e) {
      setError(sentence(e));
    }
  }, 10_000);

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {!positions && !error && <p className="muted">Loading…</p>}
      {positions && positions.length === 0 && (
        <>
          <p>You have no positions.</p>
          <Link className="button" href="/trade/">
            Trade
          </Link>
        </>
      )}
      {positions?.map((p) => <PositionCard key={p.id} p={p} account={me.accountId} record={record} onRecord={reloadRecord} />)}
    </>
  );
}

export default function PositionsPage() {
  return (
    <Screen title="Positions">
      <SignedIn>{(me) => <Positions me={me} />}</SignedIn>
    </Screen>
  );
}
