"use client";
import Link from "next/link";
import { useState } from "react";
import { Facts, Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { DEFAULT_JITTER_BPS } from "../../lib/config";
import { usd } from "../../lib/format";
import { api, useInterval } from "../../lib/session";
import { STOP_COPY, checkLevel, keepUntilOpen, sealOpened } from "../../lib/stops";
import { approveBatch, checkTrade, openPosition, reviewRows } from "../../lib/trade";
import type { Balance, Coin, Hiding, Me, PlanAnswer, PositionAnswer, Side, TradeRequest } from "../../lib/types";
import { usePiecesKey } from "../../lib/usekey";
import { currentWallet } from "../../lib/wallet";

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

function optionalNumber(s: string): number | undefined {
  return s.trim() === "" ? undefined : Number(s);
}

type Stage =
  | { kind: "form" }
  | { kind: "review"; req: TradeRequest; plan: PlanAnswer }
  | { kind: "working"; text: string }
  | { kind: "policy"; answer: PositionAnswer }
  | { kind: "opened"; answer: PositionAnswer; sealed: boolean; levels: boolean };

function Trade({ me }: { me: Me }) {
  const { state: keyState } = usePiecesKey(me.accountId);
  const [coin, setCoin] = useState<Coin>("BTC");
  const [side, setSide] = useState<Side>("long");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(3);
  const [hiding, setHiding] = useState<Hiding>("normal");
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");
  const [jitter, setJitter] = useState(String(DEFAULT_JITTER_BPS));
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState<string | undefined>();
  const [balance, setBalance] = useState<Balance | undefined>();

  useInterval(async () => {
    try {
      setBalance(await api.balance());
    } catch {
      // the balance line just stays hidden
    }
  }, 30_000);

  const levels = () => ({ stop: optionalNumber(stop), tp: optionalNumber(tp), jitterBps: Number(jitter) });

  async function review() {
    setError(undefined);
    const req: TradeRequest = { coin, side, notionalUsd: Number(size), leverage, hiding };
    const bad = checkTrade(req);
    if (bad) return setError(bad);
    try {
      const l = levels();
      checkLevel("stop", l.stop);
      checkLevel("take-profit", l.tp);
      if (!Number.isInteger(l.jitterBps) || l.jitterBps < 0 || l.jitterBps > 100) throw new Error("The tolerance must be a whole number of basis points from 0 to 100.");
      setStage({ kind: "working", text: "Planning your pieces…" });
      setStage({ kind: "review", req, plan: await api.plan(req) });
    } catch (e) {
      setError(sentence(e));
      setStage({ kind: "form" });
    }
  }

  async function afterOpen(answer: PositionAnswer) {
    const l = levels();
    const hasLevels = l.stop !== undefined || l.tp !== undefined;
    await keepUntilOpen(me.accountId, answer.positionId, l);
    let sealed = false;
    if (hasLevels) {
      setStage({ kind: "working", text: "Waiting for the position to open, then sealing your invisible stop…" });
      for (let i = 0; i < 40 && !sealed; i++) {
        const { positions } = await api.positions();
        sealed = (await sealOpened(api, me.accountId, positions)).includes(answer.positionId);
        if (!sealed) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    setStage({ kind: "opened", answer, sealed, levels: hasLevels });
  }

  async function confirm(req: TradeRequest) {
    setError(undefined);
    if (keyState.status !== "ok") return setError("Your pieces key is not on this device. Restore it from your 12 words first.");
    try {
      const wallet = await currentWallet();
      if (!wallet) throw new Error("Sign in with your wallet again first.");
      setStage({ kind: "working", text: "Starting…" });
      const answer = await openPosition({ api, wallet, key: keyState.key, account: me.accountId, onStep: (text) => setStage({ kind: "working", text }) }, req);
      if (answer.policyBatch) setStage({ kind: "policy", answer });
      else await afterOpen(answer);
    } catch (e) {
      setError(sentence(e));
      setStage({ kind: "form" });
    }
  }

  async function approve(answer: PositionAnswer) {
    setError(undefined);
    try {
      const wallet = await currentWallet();
      if (!wallet || !answer.policyBatch) throw new Error("Sign in with your wallet again first.");
      setStage({ kind: "working", text: "Waiting for your wallet…" });
      await approveBatch(api, wallet, answer.policyBatch, { positionId: answer.positionId });
      await afterOpen(answer);
    } catch (e) {
      setError(sentence(e));
      setStage({ kind: "policy", answer });
    }
  }

  return (
    <>
      {keyState.status === "missing" && (
        <Notice kind="warn">
          Your pieces key is not on this device. <Link href="/setup/">Restore it from your 12 words</Link> before you trade.
        </Notice>
      )}
      {balance && <p className="muted">Private balance: {usd(balance.privateUsdc)}</p>}
      {error && (
        <Notice kind="error" testId="trade-error">
          {error}
        </Notice>
      )}

      {stage.kind === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          <label>Market</label>
          <Choice name="Market" value={coin} onChange={setCoin} options={[{ v: "BTC", label: "BTC" }, { v: "ETH", label: "ETH" }, { v: "SOL", label: "SOL" }]} />
          <label>Side</label>
          <Choice name="Side" value={side} onChange={setSide} options={[{ v: "long", label: "Long" }, { v: "short", label: "Short" }]} />
          <label htmlFor="size">Size in USD</label>
          <input id="size" inputMode="decimal" required value={size} onChange={(e) => setSize(e.target.value)} />
          <label htmlFor="lev">Leverage: {leverage}x</label>
          <input id="lev" type="range" min={1} max={10} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
          <label>Hiding level</label>
          <Choice
            name="Hiding level"
            value={hiding}
            onChange={setHiding}
            options={[
              { v: "normal", label: "Normal (1 piece)" },
              { v: "whale", label: "Whale (several pieces)" },
            ]}
          />
          <h2>Invisible stop (optional)</h2>
          <p className="muted small">A stop that doesn&apos;t exist until it fires: no order sits on the exchange for anyone to see.</p>
          <label htmlFor="stop">Stop price</label>
          <input id="stop" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
          <label htmlFor="tp">Take-profit price</label>
          <input id="tp" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} />
          <label htmlFor="jitter">Tolerance in basis points (1 bp = 0.01%)</label>
          <input id="jitter" inputMode="numeric" value={jitter} onChange={(e) => setJitter(e.target.value)} />
          <p className="muted small">The guard moves your stop by a random amount up to this far, so nobody can guess the exact level. 0 to 100.</p>
          <button type="submit">Review</button>
        </form>
      )}

      {stage.kind === "working" && <Notice testId="trade-working">{stage.text}</Notice>}

      {stage.kind === "review" && <Review stage={stage} onBack={() => setStage({ kind: "form" })} onConfirm={() => confirm(stage.req)} />}

      {stage.kind === "policy" && stage.answer.policyBatch && (
        <>
          <h2>Approve your new pieces</h2>
          <p>Your wallet will ask once, for all of these. Each sets what a piece&apos;s account may do, so it can only trade and send money back to you.</p>
          <ul className="plain" data-testid="policy-summary">
            {stage.answer.policyBatch.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <button type="button" onClick={() => approve(stage.answer)}>
            Approve in my wallet
          </button>
        </>
      )}

      {stage.kind === "opened" && (
        <>
          <Notice kind="ok" testId="trade-opened">
            Your position is on its way. You can follow it on Positions.
          </Notice>
          {stage.levels && stage.sealed && <Notice testId="stop-sealed">{STOP_COPY}</Notice>}
          {stage.levels && !stage.sealed && <Notice kind="warn">Your stop will be sealed as soon as the position is open. Keep Positions open on this device.</Notice>}
          <Link className="button" href="/positions/">
            See positions
          </Link>
        </>
      )}
    </>
  );
}

function Review({ stage, onBack, onConfirm }: { stage: { req: TradeRequest; plan: PlanAnswer }; onBack: () => void; onConfirm: () => void }) {
  const r = reviewRows(stage.plan);
  const coin = stage.req.coin;
  return (
    <div data-testid="review">
      <h2>
        {r.count} {r.count === 1 ? "piece" : "pieces"}
      </h2>
      <p className="muted small">Each piece is a separate small account on Hyperliquid with its own part of your position.</p>
      {r.pieces.map((p) => (
        <div className="card" key={p.n} data-testid="review-piece">
          <Facts
            rows={[
              [`Piece ${p.n}`, `${p.size} ${coin}`],
              ["Size in USD", `$${p.notional}`],
              ["Funded with", `$${p.funding}`],
            ]}
          />
        </div>
      ))}
      <div className="card">
        <Facts
          rows={[
            ["Fees", <span key="f" data-testid="fees">${r.feesUsd}</span>],
            ["Exit fee, when you send home", <span key="x" data-testid="exit-fee">${r.exitFeeUsd}</span>],
          ]}
        />
      </div>
      <h2>As the world sees it</h2>
      <p className="muted small">Separate small accounts, with nothing linking them to each other or to you.</p>
      <div className="world" data-testid="world">
        {stage.plan.world.map((w) => (
          <div className="acct" key={w.name}>
            <strong>{w.name}</strong>
            <div>
              {w.side === "long" ? "Long" : "Short"} ${w.sizeUsd}
            </div>
          </div>
        ))}
      </div>
      <button type="button" onClick={onConfirm}>
        Confirm
      </button>
      <button type="button" className="secondary" onClick={onBack}>
        Change
      </button>
    </div>
  );
}

export default function TradePage() {
  return (
    <Screen title="Trade">
      <SignedIn>{(me) => <Trade me={me} />}</SignedIn>
    </Screen>
  );
}
