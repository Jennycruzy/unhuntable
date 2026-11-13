"use client";
import Link from "next/link";
import { useState } from "react";
import { AiHunter } from "../../components/AiHunter";
import { HunterView } from "../../components/HunterView";
import { Refills } from "../../components/Refills";
import { Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { num, pct, time, usd } from "../../lib/format";
import { pieceAddress } from "../../lib/pieces";
import { derivedAccount, pieceNumber } from "../../lib/chainsig";
import { chainSigPieceKey } from "unhuntable-client/chainsig";
import { ticker } from "unhuntable-client/hyperliquid";
import { approveBatch, finishPieces } from "../../lib/trade";
import { currentWallet } from "../../lib/wallet";
import { api, useInterval } from "../../lib/session";
import { GUARD_UNREACHABLE, hyperliquidPage, sealLevels, sealOpened, stopCopy } from "../../lib/stops";
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
      return which === "stop" ? stopCopy(p.coin) : "Your take-profit is sealed inside the guard, not on the exchange.";
    });

  const close = (now: boolean) =>
    run(async () => {
      const r = await api.close(p.id, now);
      return `Closing: ${STATE_WORDS[r.state] ?? r.state}.`;
    });

  return (
    <div className="card" data-testid="position">
      <div className="poshead">
        <div>
          <h2>
            {ticker(p.coin)} {p.side === "long" ? "Long" : "Short"} {usd(p.notionalUsd)}
          </h2>
          {p.copyOf && (
            <p className="small" data-testid="copy-of">
              Copy of @{p.copyOf.handle}: it closes when theirs closes.
            </p>
          )}
          <p className="muted small">
            {p.leverage}x · {p.pieces.length} {p.pieces.length === 1 ? "piece" : "pieces"}
            {p.fillSavingsUsd !== undefined && <> · saved {usd(p.fillSavingsUsd)} on fills</>}
          </p>
        </div>
        <span className={`badge${p.state === "open" ? " ok" : p.state === "failed" ? " bad" : ""}`}>{STATE_WORDS[p.state] ?? p.state}</span>
      </div>
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
          <div key={x.shard} className="pc" data-testid="piece">
            <div className="pc-top">
              <strong>
                {num(x.size)} {ticker(p.coin)}
              </strong>
              <span className="muted">{x.entryPx === null ? "–" : usd(x.entryPx)}</span>
              {x.nearControlled && (
                <span className="badge" data-testid="near-controlled" title="This Hyperliquid account has no private key: NEAR's MPC network signs for it, only when your pieces key approves.">
                  NEAR-controlled
                </span>
              )}
              <span className={`badge ${x.guard === "ok" ? "ok" : "bad"}`}>{x.guard === "ok" ? "Watching" : "Not answering"}</span>
            </div>
            <div className="pc-sub">
              <span>Liquidation {x.liqDistance === null ? "–" : `${pct(x.liqDistance)} away`}</span>
              <span>Stop {x.hasStop ? (mine?.stop !== undefined ? num(mine.stop) : "set") : "none"}</span>
              <span>Take-profit {x.hasTp ? (mine?.tp !== undefined ? num(mine.tp) : "set") : "none"}</span>
              {addr && (
                <a href={hyperliquidPage(addr)} target="_blank" rel="noopener noreferrer">
                  Check on Hyperliquid
                </a>
              )}
            </div>
          </div>
        );
      })}
      {(p.state === "open" || p.state === "closing") && <HunterView p={p} levels={levels} />}
      {(p.state === "open" || p.state === "closing" || p.state === "closed") && <AiHunter p={p} levels={levels} />}
      {hiddenLevels(p, levels) && <p className="small muted">Levels show only in the browser that set them.</p>}
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
          <div className="inline">
            <input id={`stop-${p.id}`} inputMode="decimal" autoComplete="off" value={stop} onChange={(e) => setStop(e.target.value)} />
            <button type="button" className="secondary" disabled={busy || !stop} onClick={() => move("stop", stop)}>
              Move stop
            </button>
          </div>
          <label htmlFor={`tp-${p.id}`}>Move take-profit to</label>
          <div className="inline">
            <input id={`tp-${p.id}`} inputMode="decimal" autoComplete="off" value={tp} onChange={(e) => setTp(e.target.value)} />
            <button type="button" className="secondary" disabled={busy || !tp} onClick={() => move("tp", tp)}>
              Move take-profit
            </button>
          </div>
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
          const near = r.positions.some((p) => p.pieces.some((x) => x.label === label && x.nearControlled));
          try {
            const a = near
              ? await derivedAccount((...f) => fetch(...f), chainSigPieceKey(key, pieceNumber(label)).publicKey)
              : await pieceAddress({ api, key, account: me.accountId }, label);
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
      {positions
        ?.filter((p) => (p.needChainSig ?? []).length > 0)
        .map((p) => (
          <Notice key={`sign-${p.id}`} kind="error" testId="sign-again">
            {ticker(p.coin)}: a NEAR-controlled piece needs your pieces key to sign again.{" "}
            <button
              type="button"
              className="secondary"
              disabled={!key}
              onClick={async () => {
                try {
                  const w = await currentWallet();
                  if (!w || !key) throw new Error("Sign in with your wallet again first.");
                  await finishPieces({ api, wallet: w, key, account: me.accountId }, await api.continuePosition(p.id));
                } catch (e) {
                  setError(sentence(e));
                }
              }}
            >
              Sign again
            </button>
          </Notice>
        ))}
      {positions
        ?.filter((p) => (p.copyOf && p.state === "planned") || p.state === "policy_wait")
        .map((p) => (
          <Notice key={`copy-${p.id}`} kind="warn" testId={p.copyOf ? "start-copy" : "approve-locks"}>
            {p.copyOf ? (
              <>
                Your copy of @{p.copyOf.handle}&rsquo;s {ticker(p.coin)} {p.side} ({usd(p.notionalUsd)}) needs your approval once
                {p.state === "planned" ? ": new pieces are made in this browser, then your wallet locks them." : ": your wallet locks its new pieces."}
              </>
            ) : (
              <>
                Your {ticker(p.coin)} pieces are funded. Approve their locks in your wallet to open the position: your private balance may then send only to your
                pieces and to you.
              </>
            )}{" "}
            <button
              type="button"
              disabled={!key}
              onClick={async () => {
                try {
                  const w = await currentWallet();
                  if (!w || !key) throw new Error("Sign in with your wallet again first.");
                  const a = await finishPieces({ api, wallet: w, key, account: me.accountId }, await api.continuePosition(p.id));
                  if (a.policyBatch) await approveBatch(api, w, a.policyBatch, { positionId: p.id });
                } catch (e) {
                  setError(sentence(e));
                }
              }}
            >
              {p.copyOf ? "Start my copy" : "Approve in my wallet"}
            </button>
          </Notice>
        ))}
      {positions?.map((p) => <PositionCard key={p.id} p={p} account={me.accountId} record={record} onRecord={reloadRecord} />)}
      {positions && positions.length > 0 && <Refills />}
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
