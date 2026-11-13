"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ticker } from "unhuntable-client/hyperliquid";
import { HunterView } from "../../components/HunterView";
import { Mark } from "../../components/icons";
import { Notice } from "../../components/ui";
import { sentence } from "../../lib/api";
import { usd } from "../../lib/format";
import { px } from "../../lib/huntmap";
import { DEFAULT_STOP, STOP_CHOICES, clock, entryOf, stepLine, stopPrice } from "../../lib/judge";
import { api, useInterval } from "../../lib/session";
import { buildBoxes } from "../../lib/stops";
import type { Coin, JudgeRun, JudgeStatus, Side } from "../../lib/types";

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="choice" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label key={o.v}>
          <input type="radio" name={name} checked={value === o.v} onChange={() => onChange(o.v)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function Run({ run, now, onClose, closing }: { run: JudgeRun; now: number; onClose: () => void; closing: boolean }) {
  const p = run.position;
  const entry = entryOf(run);
  const [stop, setStop] = useState<number | undefined>();
  const [sealError, setSealError] = useState<string | undefined>();
  const sealing = useRef(false);
  const distance = useRef(DEFAULT_STOP);
  useEffect(() => {
    distance.current = Number(sessionStorageGet("judge-stop") ?? DEFAULT_STOP);
  }, []);

  // Seal the stop in this browser as soon as the position is open: the server only passes the box on.
  useEffect(() => {
    if (!p || p.state !== "open" || run.stopSealed || sealing.current || entry === null) return;
    sealing.current = true;
    const level = stopPrice(entry, p.side, distance.current);
    (async () => {
      try {
        const { boxPub } = await api.judgeBoxPub();
        const boxes = buildBoxes(boxPub, { coin: p.coin, side: p.side, pieces: p.pieces.map((x) => ({ shard: x.shard, size: x.size })) }, { stop: level });
        await api.judgeStop(boxes);
        setStop(level);
        sessionStorageSet(`judge-level-${run.id}`, String(level));
      } catch (e) {
        sealing.current = false;
        setSealError(sentence(e));
      }
    })();
  }, [p, run.stopSealed, run.id, entry]);

  const level = stop ?? (Number(sessionStorageGet(`judge-level-${run.id}`)) || undefined);
  const done = !p || p.state === "closed" || p.state === "failed";
  const shown = p && run.stopSealed ? { ...p, pieces: p.pieces.map((x) => ({ ...x, hasStop: true })) } : p;
  const levels = Object.fromEntries((p?.pieces ?? []).map((x) => [x.shard, level !== undefined ? { stop: level } : undefined]));

  return (
    <section className="card jd-run" data-testid="judge-run" aria-label="Your judge trade">
      {p && (
        <p className="stat-label">
          {p.side === "long" ? "Long" : "Short"} {usd(p.notionalUsd)} {ticker(p.coin)} at {p.leverage}x · {p.pieces.length === 1 ? "one piece" : `${p.pieces.length} pieces`}
        </p>
      )}
      <p className="jd-step" data-testid="judge-step" aria-live="polite">
        {stepLine(run)}
        {p?.state === "open" && entry !== null && <> Entry {px(entry)}.</>}
      </p>
      {p?.state === "open" && (
        <p data-testid="judge-stop">
          {run.stopSealed
            ? `Your stop${level !== undefined ? ` at ${px(level)}` : ""} is sealed. It was locked in this browser for the guard alone; our server passed on a box it cannot open, and Hyperliquid's book holds no stop.`
            : "Sealing your stop in this browser…"}
        </p>
      )}
      {sealError && <Notice kind="error">{sealError}</Notice>}
      {!done && run.live && (
        <p className="hu-clock num" data-testid="judge-clock">
          Closes by itself in {clock(run.endsMs - now)}
        </p>
      )}
      {!done && (
        <button type="button" onClick={onClose} disabled={closing} data-testid="judge-close">
          {closing ? "Closing…" : "Close now"}
        </button>
      )}
      {p?.result && (
        <p data-testid="judge-result">
          Result {usd(p.result.pnlUsd)}, fees {usd(p.result.feesUsd)}, read from Hyperliquid&apos;s fills.
        </p>
      )}
      {shown && shown.state !== "planned" && shown.state !== "funding" && shown.state !== "failed" && (
        <HunterView p={shown} levels={levels} read={() => api.judgeHunter()} />
      )}
    </section>
  );
}

function sessionStorageGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function sessionStorageSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    // the stop is still sealed; only the number shown here is lost on reload
  }
}

export default function JudgePage() {
  const [status, setStatus] = useState<JudgeStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [coin, setCoin] = useState<Coin>("ETH");
  const [side, setSide] = useState<Side>("long");
  const [dist, setDist] = useState<string>(String(DEFAULT_STOP));
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = async () => {
    try {
      setStatus(await api.judge());
    } catch (e) {
      setError(sentence(e));
    }
  };
  useInterval(refresh, 3_000);
  useInterval(() => setNow(Date.now()), 1_000);

  const run = status?.run ?? null;
  const running = run !== null && run.position !== null && !["closed", "failed"].includes(run.position.state);

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      sessionStorageSet("judge-stop", dist);
      const r = await api.judgeOpen(code.trim(), coin, side);
      setStatus((s) => (s ? { ...s, run: r.run } : s));
      await refresh();
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setClosing(true);
    try {
      await api.judgeClose();
      await refresh();
    } catch (e) {
      setError(sentence(e));
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="cover open">
      <header className="cover-top">
        <Link href="/" className="mark" aria-label="Unhuntable">
          <Mark />
          Unhuntable
        </Link>
        <nav aria-label="Site">
          <Link href="/hunt-map/" className="hide-s">
            Hunt Map
          </Link>
          <Link href="/judge/" aria-current="page" className="hide-s">
            Judges
          </Link>
          <Link href="/signin/" className="pill">
            Sign in
          </Link>
        </nav>
      </header>
      <main>
        <section className="wrap hero hm-hero">
          <h1>Open a real trade</h1>
          <p className="lede">
            For judges: a real {status ? usd(status.notionalUsd) : "$15"} position on Hyperliquid at {status?.leverage ?? 2}x, from Unhuntable&apos;s own demo account. No
            wallet and no money needed. It takes the same path as every trade: a piece controlled by NEAR Chain Signatures, a stop sealed in your browser that only the
            guard can open, and a close by the guard. It closes by itself after {status?.minutes ?? 10} minutes.
          </p>
          {error && <Notice kind="error">{error}</Notice>}

          {status && !running && (
            <form
              className="card jd-form"
              data-testid="judge-form"
              onSubmit={(e) => {
                e.preventDefault();
                void open();
              }}
            >
              <label>
                Judge code
                <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} required data-testid="judge-code" />
                <span className="small muted">It is in the judging notes of the submission.</span>
              </label>
              <Choice name="Market" value={coin} options={status.coins.map((c) => ({ v: c, label: c }))} onChange={setCoin} />
              <Choice
                name="Side"
                value={side}
                options={[
                  { v: "long", label: "Long" },
                  { v: "short", label: "Short" },
                ]}
                onChange={setSide}
              />
              <Choice name="Stop distance" value={dist} options={STOP_CHOICES.map((d) => ({ v: String(d), label: `Stop ${d * 100}% away` }))} onChange={setDist} />
              {status.busyUntilMs !== null && <Notice>Another judge trade is running. The next one can open in {clock(status.busyUntilMs - now)}.</Notice>}
              {status.leftToday === 0 && <Notice>Today&apos;s judge trades are used up. More open within 24 hours.</Notice>}
              <button type="submit" disabled={busy || status.busyUntilMs !== null || status.leftToday === 0 || code.trim() === ""} data-testid="judge-open">
                {busy ? "Opening…" : "Open the trade"}
              </button>
            </form>
          )}
          {run && <Run run={run} now={now} onClose={close} closing={closing} />}
        </section>
      </main>
      <footer className="wrap cover-foot">
        <span>Every address opens its public page on Hyperliquid, where you can check each line yourself.</span>
        <nav aria-label="Footer">
          <Link href="/">Unhuntable</Link>
          <Link href="/hunt-map/">Hunt Map</Link>
        </nav>
      </footer>
    </div>
  );
}
