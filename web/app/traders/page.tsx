"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ticker } from "unhuntable-client/hyperliquid";
import { Facts, Notice, Screen } from "../../components/ui";
import { sentence } from "../../lib/api";
import { approveKey, buyKey, checkCopySize, copyShape, MIN_COPY_USD, recordFile } from "../../lib/follow";
import { time, usd } from "../../lib/format";
import { api, useInterval, useSession } from "../../lib/session";
import type { ClosedTrade, FollowKey, KeyKind, MyTrader, TraderCard } from "../../lib/types";
import { currentWallet } from "../../lib/wallet";

const HANDLE = /^[a-z0-9_]{3,20}$/;

function signedUsd(v: string | number): string {
  const n = Number(v);
  return `${n < 0 ? "−" : n > 0 ? "+" : ""}${usd(Math.abs(n))}`;
}

/** The guard's signed totals: every piece the trader ever used, summed inside the enclave. */
function Record({ t, canRefresh, onCard }: { t: TraderCard; canRefresh: boolean; onCard: (c: TraderCard) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const r = t.record;
  return (
    <div className="record" data-testid="trader-record">
      {r ? (
        <>
          <p className="small">
            <strong>Signed by the guard</strong> over {r.shards} {r.shards === 1 ? "piece" : "pieces"}: result {signedUsd(r.pnlUsd)} ({usd(r.netDepositsUsd)}{" "}
            in, {usd(r.equityUsd)} now), {time(r.asOfMs)}. No piece address leaves the guard.
          </p>
          <a
            className="small"
            download={`unhuntable-record-${t.handle}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(recordFile(r))}`}
            data-testid="record-download"
          >
            Download the signed record
          </a>
          <span className="small muted"> · check it: </span>
          <code className="small">node tools/easverify.cjs unhuntable-record-{t.handle}.json</code>
        </>
      ) : (
        <p className="small muted">No record signed by the guard yet.</p>
      )}
      {canRefresh && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              onCard((await api.refreshRecord(t.handle)).trader);
            } catch (e) {
              setError(sentence(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Asking the guard…" : "Sign a fresh record"}
        </button>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

function Trades({ handle }: { handle: string }) {
  const [trades, setTrades] = useState<ClosedTrade[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useInterval(async () => {
    try {
      setTrades((await api.closedTrades(handle)).trades);
      setError(undefined);
    } catch (e) {
      setError(sentence(e));
    }
  }, 60_000);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!trades) return <p className="muted">Loading…</p>;
  if (trades.length === 0) return <p className="small muted">No closed trades yet. Open positions are never shown, to anyone.</p>;
  return (
    <div className="trades-wrap">
      <table className="trades" data-testid="closed-trades">
        <thead>
          <tr>
            <th>Closed</th>
            <th>Trade</th>
            <th>Entry → exit</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i}>
              <td>{t.closedMs ? time(t.closedMs) : "–"}</td>
              <td>
                {t.side === "long" ? "Long" : "Short"} {usd(t.notionalUsd)} {ticker(t.coin)} {t.leverage}x
              </td>
              <td>
                {t.entryPx ?? "–"} → {t.exitPx ?? "–"}
              </td>
              <td className={Number(t.pnlUsd) >= 0 ? "up" : "down"}>{t.pnlUsd === null ? "–" : signedUsd(t.pnlUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Buying a key: the wallet approves paying this trader once, then it pays day by day while it is on. */
function Buy({ t, onDone }: { t: TraderCard; onDone: () => void }) {
  const [kind, setKind] = useState<KeyKind>("copy");
  const [size, setSize] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const bad = kind === "copy" ? checkCopySize(size) : undefined;
  const price = kind === "copy" ? t.copyUsdDay : t.viewUsdDay;
  return (
    <div className="buy" data-testid="buy-key">
      <div className="choice" role="radiogroup" aria-label="Key">
        {(["copy", "view"] as const).map((k) => (
          <label key={k}>
            <input type="radio" name={`kind-${t.handle}`} checked={kind === k} onChange={() => setKind(k)} />
            <span>{k === "copy" ? "Copy key" : "Viewing key"}</span>
          </label>
        ))}
      </div>
      {kind === "copy" ? (
        <>
          <label htmlFor={`size-${t.handle}`}>Size of each copy, in dollars</label>
          <input id={`size-${t.handle}`} inputMode="decimal" autoComplete="off" value={size} onChange={(e) => setSize(e.target.value)} />
          <p className="small">
            Each crypto trade @{t.handle} opens is copied a few minutes later into your own pieces: same market, side and leverage, your size,{" "}
            {copyShape(Number(size) || MIN_COPY_USD)}, at times nobody can tie to the trader or to other followers. It closes when theirs closes. You never see
            their position, and they never see yours.
          </p>
        </>
      ) : (
        <p className="small">
          You see @{t.handle}&rsquo;s closed trades: entry, exit and result. Open positions are never shown, so nothing you see can be hunted.
        </p>
      )}
      <Notice testId="key-price">
        {usd(price)} a day, paid privately from your private balance to the trader&rsquo;s, only while the key is on. Your wallet approves once that your
        balance may pay @{t.handle}; stop the key any time and the payments stop.
      </Notice>
      {(bad || error) && <Notice kind="error">{bad ?? error}</Notice>}
      <button
        type="button"
        disabled={busy || bad !== undefined}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            const w = await currentWallet();
            if (!w) throw new Error("Sign in with your wallet again first.");
            await buyKey(api, w, {
              handle: t.handle,
              kind,
              ...(kind === "copy" ? { copyUsd: Number(size) } : {}),
            });
            onDone();
          } catch (e) {
            setError(sentence(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for your wallet…" : `Approve and buy the ${kind === "copy" ? "copy" : "viewing"} key`}
      </button>
    </div>
  );
}

function Card({ t, me, keys, onChange }: { t: TraderCard; me: string | null; keys: FollowKey[]; onChange: () => void }) {
  const [card, setCard] = useState(t);
  const [open, setOpen] = useState<"buy" | "trades" | null>(null);
  const own = keys.filter((k) => k.handle === card.handle && k.state !== "stopped");
  const on = own.some((k) => k.on);
  return (
    <div className="card" data-testid="trader-card">
      <div className="poshead">
        <h2>@{card.handle}</h2>
        <span className={`badge${Number(card.resultUsd) >= 0 ? " ok" : " bad"}`}>{signedUsd(card.resultUsd)}</span>
      </div>
      <Facts
        rows={[
          ["Closed trades", `${card.closedTrades} (${card.wins} won)`],
          ["Copy key", `${usd(card.copyUsdDay)} a day · ${card.copiers} copying`],
          ["Viewing key", `${usd(card.viewUsdDay)} a day · ${card.viewers} viewing`],
          ["Selling keys", card.open ? "Yes" : "Not now"],
        ]}
      />
      <Record t={card} canRefresh={me !== null} onCard={setCard} />
      {me !== null && (
        <div className="row-buttons">
          {card.open && (
            <button type="button" className="secondary" onClick={() => setOpen(open === "buy" ? null : "buy")}>
              {open === "buy" ? "Close" : "Buy a key"}
            </button>
          )}
          {on && (
            <button type="button" className="secondary" onClick={() => setOpen(open === "trades" ? null : "trades")}>
              {open === "trades" ? "Hide closed trades" : "Closed trades"}
            </button>
          )}
        </div>
      )}
      {me === null && (
        <p className="small">
          <Link href="/signin/">Sign in</Link> to buy a key.
        </p>
      )}
      {open === "buy" && (
        <Buy
          t={card}
          onDone={() => {
            setOpen(null);
            onChange();
          }}
        />
      )}
      {open === "trades" && <Trades handle={card.handle} />}
    </div>
  );
}

function MyKeys({ keys, onChange }: { keys: FollowKey[]; onChange: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(sentence(e));
    }
  };
  const shown = keys.filter((k) => k.state !== "stopped");
  if (shown.length === 0) return null;
  return (
    <section data-testid="my-keys">
      <h2>Your keys</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {shown.map((k) => (
        <div className="card" key={k.id} data-testid="key-row">
          <div className="poshead">
            <h3>
              {k.kind === "copy" ? "Copy key" : "Viewing key"} · @{k.handle}
            </h3>
            <span className={`badge${k.on ? " ok" : k.state === "pending" ? "" : " bad"}`}>
              {k.state === "pending" ? "Waiting for your approval" : k.state === "paused" ? "Paused" : k.on ? "On" : "Paying"}
            </span>
          </div>
          <Facts
            rows={[
              ["Price", `${usd(k.usdDay)} a day`],
              ...(k.copyUsd !== null ? ([["Each copy", usd(k.copyUsd)]] as [string, string][]) : []),
              ["Paid so far", usd(k.paidUsd)],
              ...(k.paidThroughMs ? ([["Paid until", time(k.paidThroughMs)]] as [string, string][]) : []),
            ]}
          />
          {k.state === "paused" && k.pauseReason && (
            <Notice kind="warn">
              Paused:{" "}
              {k.pauseReason === "payment_refused" || k.pauseReason === "payment_failed"
                ? "a day's payment did not go through. Top up your private balance, then switch it back on."
                : "the trader stopped taking payments."}
            </Notice>
          )}
          {k.copies.length > 0 && (
            <ul className="plain small" data-testid="key-copies">
              {k.copies.map((c, i) => (
                <li key={i}>
                  <span className="muted">{time(c.ms)}</span>{" "}
                  {c.state === "needs_app" ? (
                    <>
                      a copy waits for you: <Link href="/positions/">start it in Positions</Link>
                    </>
                  ) : c.state === "skipped" ? (
                    `not copied (${c.reason ?? "skipped"})`
                  ) : (
                    `copy ${c.state}`
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="row-buttons">
            {k.state === "pending" && (
              <button
                type="button"
                onClick={() =>
                  act(async () => {
                    const w = await currentWallet();
                    if (!w) throw new Error("Sign in with your wallet again first.");
                    await approveKey(api, w, k.id);
                  })
                }
              >
                Approve in my wallet
              </button>
            )}
            {k.state === "paused" && (
              <button type="button" onClick={() => act(() => api.resumeKey(k.id))}>
                Switch back on
              </button>
            )}
            <button type="button" className="secondary" onClick={() => act(() => api.stopKey(k.id))}>
              {k.state === "pending" ? "Turn down" : "Stop the key"}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Become a trader: a name and two prices. Income lands in your own private balance. */
function Sell({ mine, onChange }: { mine: MyTrader["trader"]; onChange: () => void }) {
  const [handle, setHandle] = useState(mine?.handle ?? "");
  const [copy, setCopy] = useState(String(mine?.copyUsdDay ?? "0.50"));
  const [view, setView] = useState(String(mine?.viewUsdDay ?? "0.10"));
  const [open, setOpen] = useState(mine?.open ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const bad =
    handle === ""
      ? undefined
      : !HANDLE.test(handle)
        ? "A name is 3 to 20 lowercase letters, digits or _."
        : !(Number(copy) >= 0.01 && Number(copy) <= 100) || !(Number(view) >= 0.01 && Number(view) <= 100)
          ? "Prices are from $0.01 to $100 a day."
          : undefined;
  return (
    <section className="card" data-testid="sell-keys">
      <h2>{mine ? "Your trader profile" : "Sell keys to your trading"}</h2>
      {mine && (
        <Facts
          rows={[
            ["Earned", `${usd(mine.earnedUsd)} from ${mine.payments} ${mine.payments === 1 ? "day" : "days"} of keys`],
            ["Copying you", String(mine.copiers)],
            ["Viewing you", String(mine.viewers)],
          ]}
        />
      )}
      <p className="small">
        Followers pay you day by day into your private balance. They never see your open positions, stops or pieces; a copy key copies your crypto trades into
        their own pieces, a viewing key shows your closed trades. You never learn who they are.
      </p>
      <label htmlFor="handle">Name</label>
      <input
        id="handle"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={20}
        value={handle}
        onChange={(e) => setHandle(e.target.value.toLowerCase())}
      />
      <label htmlFor="copy-price">Copy key, dollars a day</label>
      <input id="copy-price" inputMode="decimal" autoComplete="off" value={copy} onChange={(e) => setCopy(e.target.value)} />
      <label htmlFor="view-price">Viewing key, dollars a day</label>
      <input id="view-price" inputMode="decimal" autoComplete="off" value={view} onChange={(e) => setView(e.target.value)} />
      <label className="check">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Selling new keys
      </label>
      {(bad || error) && <Notice kind="error">{bad ?? error}</Notice>}
      {saved && !error && <Notice kind="ok">Saved.</Notice>}
      <button
        type="button"
        disabled={busy || bad !== undefined || handle === ""}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          setSaved(false);
          try {
            await api.setTrader({
              handle,
              copyUsdDay: Number(copy),
              viewUsdDay: Number(view),
              open,
            });
            setSaved(true);
            onChange();
          } catch (e) {
            setError(sentence(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {mine ? "Save" : "Start selling keys"}
      </button>
    </section>
  );
}

function Traders() {
  const { me } = useSession();
  const signedIn = me.status === "ok";
  const [traders, setTraders] = useState<TraderCard[] | undefined>();
  const [keys, setKeys] = useState<FollowKey[]>([]);
  const [mine, setMine] = useState<MyTrader["trader"] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = async () => {
    try {
      setTraders((await api.traders()).traders);
      if (signedIn) {
        setKeys((await api.myKeys()).keys);
        setMine((await api.myTrader()).trader);
      }
      setError(undefined);
    } catch (e) {
      setError(sentence(e));
    }
  };
  useInterval(load, 30_000);
  // keys and the trader profile come once the session is known
  useEffect(() => {
    if (signedIn) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
  const others = (traders ?? []).filter((t) => t.handle !== mine?.handle);
  return (
    <>
      <p className="lede-s">
        Follow a trader without anyone, even you, seeing their open positions. A copy key copies their trades into your own pieces; a viewing key shows their
        closed trades. Their record is signed by the guard over every piece they ever used.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {signedIn && <MyKeys keys={keys} onChange={load} />}
      {!traders && !error && <p className="muted">Loading…</p>}
      {traders && others.length === 0 && <p className="muted">No other traders sell keys yet.</p>}
      {others.map((t) => (
        <Card key={t.handle} t={t} me={me.status === "ok" ? me.me.accountId : null} keys={keys} onChange={load} />
      ))}
      {signedIn && mine !== undefined && <Sell key={mine?.handle ?? "new"} mine={mine} onChange={load} />}
      {signedIn && mine && (
        <div className="card" data-testid="my-card">
          <h2>How followers see you</h2>
          <Record t={mine} canRefresh onCard={() => void load()} />
        </div>
      )}
    </>
  );
}

export default function TradersPage() {
  return (
    <Screen title="Traders">
      <Traders />
    </Screen>
  );
}
