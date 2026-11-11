"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Facts, Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { DEFAULT_JITTER_BPS } from "../../lib/config";
import { usd } from "../../lib/format";
import { api, useInterval } from "../../lib/session";
import { checkLevel, keepUntilOpen, sealOpened, stopCopy } from "../../lib/stops";
import { ASSETS, asset, ticker } from "unhuntable-client/hyperliquid";
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

type Group = "crypto" | "stocks";
const inGroup = (g: Group) => ASSETS.filter((a) => (g === "crypto" ? a.dex === "" : a.dex !== ""));

/** Crypto on Hyperliquid, or US stocks and indexes on trade.xyz. */
function Market({ coin, onChange }: { coin: Coin; onChange: (c: Coin) => void }) {
  const group: Group = asset(coin)?.dex ? "stocks" : "crypto";
  return (
    <>
      <Choice
        name="Market"
        value={group}
        onChange={(g) => onChange(inGroup(g)[0].coin)}
        options={[
          { v: "crypto", label: "Crypto" },
          { v: "stocks", label: "US stocks" },
        ]}
      />
      {group === "crypto" ? (
        <Choice name="Coin" value={coin} onChange={onChange} options={inGroup("crypto").map((a) => ({ v: a.coin, label: a.label }))} />
      ) : (
        <>
          <select id="market" aria-label="Stock or index" value={coin} onChange={(e) => onChange(e.target.value)}>
            {inGroup("stocks").map((a) => (
              <option key={a.coin} value={a.coin}>
                {ticker(a.coin)} · {a.label}
              </option>
            ))}
          </select>
          <p className="muted small" data-testid="stocks-note">
            Trades on trade.xyz. Stops fire only while US prices are live, 4:00 to 20:00 New York time on weekdays.
          </p>
        </>
      )}
    </>
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
          <Market coin={coin} onChange={setCoin} />
          <div className="labelrow">
            <label htmlFor="size">Size</label>
            {balance && <output className="muted">{usd(balance.privateUsdc)} available</output>}
          </div>
          <div className="unit big">
            <input id="size" inputMode="decimal" autoComplete="off" required value={size} onChange={(e) => setSize(e.target.value)} />
            <span>USD</span>
          </div>
          <label>Side</label>
          <Choice name="Side" value={side} onChange={setSide} options={[{ v: "long", label: "Long" }, { v: "short", label: "Short" }]} />
          <div className="labelrow">
            <label htmlFor="lev">Leverage</label>
            <output htmlFor="lev">{leverage}x</output>
          </div>
          <input id="lev" type="range" min={1} max={10} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
          <label>Pieces</label>
          <Choice
            name="Pieces"
            value={hiding}
            onChange={setHiding}
            options={[
              { v: "normal", label: "One" },
              { v: "whale", label: "Several" },
            ]}
          />
          <details className="more" open={stop !== "" || tp !== ""}>
            <summary>Invisible stop</summary>
            <div className="two">
              <div>
                <label htmlFor="stop">Stop price</label>
                <input id="stop" inputMode="decimal" autoComplete="off" value={stop} onChange={(e) => setStop(e.target.value)} />
              </div>
              <div>
                <label htmlFor="tp">Take-profit</label>
                <input id="tp" inputMode="decimal" autoComplete="off" value={tp} onChange={(e) => setTp(e.target.value)} />
              </div>
            </div>
            <label htmlFor="jitter">Tolerance (bp)</label>
            <input id="jitter" inputMode="numeric" autoComplete="off" value={jitter} onChange={(e) => setJitter(e.target.value)} />
          </details>
          <button type="submit">Review</button>
        </form>
      )}

      {stage.kind === "working" && (
        <Notice testId="trade-working" live>
          {stage.text}
        </Notice>
      )}

      {stage.kind === "review" && <Review stage={stage} onBack={() => setStage({ kind: "form" })} onConfirm={() => confirm(stage.req)} />}

      {stage.kind === "policy" && stage.answer.policyBatch && (
        <>
          <h2>Approve your new pieces</h2>
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
            Your position is on its way.
          </Notice>
          {stage.levels && stage.sealed && <Notice testId="stop-sealed">{stopCopy(coin)}</Notice>}
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
  const coin = ticker(stage.req.coin);
  const isolated = stage.plan.plan.openLeverage !== undefined && asset(stage.req.coin)?.dex === "xyz";
  return (
    <div data-testid="review">
      <h2>
        {r.count} {r.count === 1 ? "piece" : "pieces"}
      </h2>
      <div className="card table">
        <div className="trow head">
          <span>Piece</span>
          <span>Size</span>
          <span>USD</span>
          <span>Funded</span>
        </div>
        {r.pieces.map((p) => (
          <div className="trow" key={p.n} data-testid="review-piece">
            <span>{p.n}</span>
            <span>
              {p.size} {coin}
            </span>
            <span>${p.notional}</span>
            <span>${p.funding}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <Facts
          rows={[
            ["Fees", <span key="f" data-testid="fees">${r.feesUsd}</span>],
            ["Exit fee", <span key="x" data-testid="exit-fee">${r.exitFeeUsd}</span>],
            ...(r.builderFee
              ? [
                  [
                    "Builder fee",
                    <span key="b" data-testid="builder-fee">
                      {r.builderFee.rate} when opening, at most ${r.builderFee.usd}
                    </span>,
                  ] as [string, ReactNode],
                ]
              : []),
            ...(isolated
              ? ([["Margin", <span key="m" data-testid="isolated">Isolated, {stage.plan.plan.openLeverage}x on trade.xyz</span>]] as [string, ReactNode][])
              : []),
          ]}
        />
      </div>
      <h2>As the world sees it</h2>
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
      <div className="row-buttons">
        <button type="button" className="secondary" onClick={onBack}>
          Change
        </button>
        <button type="button" onClick={onConfirm}>
          Confirm
        </button>
      </div>
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
