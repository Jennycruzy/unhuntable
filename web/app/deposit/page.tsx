"use client";
import { useEffect, useState } from "react";
import { Qr } from "../../components/Qr";
import { Facts, Notice, Screen } from "../../components/ui";
import { ApiError, sentence } from "../../lib/api";
import { ROUTES, depositView } from "../../lib/deposit";
import { bpsPercent, countdown, num, usd } from "../../lib/format";
import { api, useInterval, useSession } from "../../lib/session";
import type { DepositState, Quote, Route } from "../../lib/types";

export default function DepositPage() {
  const { me } = useSession();
  const [route, setRoute] = useState<Route>("near");
  const [chain, setChain] = useState("near");
  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<Quote | undefined>();
  const [status, setStatus] = useState<DepositState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pollError, setPollError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  /** Back to the form: a quote nobody sent to simply runs out. */
  const startOver = () => {
    setQuote(undefined);
    setStatus(undefined);
    setPollError(undefined);
    setError(undefined);
    setCopied(false);
  };

  const routeDef = ROUTES.find((r) => r.id === route)!;
  const chainDef = routeDef.chains.find((c) => c.id === chain) ?? routeDef.chains[0];

  useEffect(() => {
    if (me.status === "ok" && route === "near" && !refundTo) setRefundTo(me.me.accountId);
  }, [me, route, refundTo]);

  const view = quote ? depositView(status?.status ?? "waiting", quote.expiresMs, now, status?.amountOut) : { kind: "form" as const };
  const live = quote && (view.kind === "waiting" || view.kind === "seen");

  useInterval(() => setNow(Date.now()), live ? 1000 : null);
  useInterval(async () => {
    if (!quote) return;
    try {
      setStatus(await api.deposit(quote.id));
      setPollError(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === "quote_expired") setStatus({ id: quote.id, status: "expired" });
      setPollError(sentence(e));
    }
  }, live ? 5000 : null);

  async function getQuote() {
    setBusy(true);
    setError(undefined);
    setPollError(undefined);
    setStatus(undefined);
    try {
      const q = await api.quote({ route, chain: chainDef.id, token, amount: amount.trim(), refundTo: refundTo.trim() });
      setNow(Date.now());
      setQuote(q);
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Deposit">
      {!quote && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void getQuote();
          }}
        >
          <fieldset>
            <legend>From</legend>
            <div className="choice">
              {ROUTES.map((r) => (
                <label key={r.id}>
                  <input
                    type="radio"
                    name="route"
                    checked={route === r.id}
                    onChange={() => {
                      setRoute(r.id);
                      setChain(r.chains[0].id);
                      setToken(r.chains[0].tokens[0]);
                      setRefundTo("");
                    }}
                  />
                  <span>{r.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {routeDef.chains.length > 1 && (
            <>
              <label htmlFor="chain">Chain</label>
              <select
                id="chain"
                value={chainDef.id}
                onChange={(e) => {
                  setChain(e.target.value);
                  const c = routeDef.chains.find((x) => x.id === e.target.value)!;
                  if (!c.tokens.includes(token)) setToken(c.tokens[0]);
                }}
              >
                {routeDef.chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="amount">Amount</label>
          <div className="amount">
            <div className="unit big">
              <input id="amount" inputMode="decimal" autoComplete="off" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <select id="token" aria-label="Coin" value={token} onChange={(e) => setToken(e.target.value)}>
              {chainDef.tokens.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <label htmlFor="refund">Refund to</label>
          <input
            id="refund"
            required
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby="refund-hint"
            value={refundTo}
            onChange={(e) => setRefundTo(e.target.value)}
          />
          <p className="small muted" id="refund-hint" data-testid="refund-hint">
            {route === "near"
              ? "Your NEAR account, like alice.near."
              : chainDef.id === "sol"
                ? "Your own address on Solana, from Phantom."
                : `Your own address on ${chainDef.name}, starting with 0x, from MetaMask.`}{" "}
            If the deposit can&apos;t go through, it is sent back there.
          </p>
          {error && (
            <Notice kind="error" testId="deposit-error">
              {error}
            </Notice>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Getting a quote…" : "Get quote"}
          </button>
        </form>
      )}

      {quote && (
        <>
          <div className="card">
            <Facts
              rows={[
                ["You send", `${num(quote.amountIn)} ${token}`],
                ["You get", <span key="o" data-testid="amount-out">{usd(quote.amountOut)} USDC</span>],
                ["Fee", usd(quote.feeUsd)],
                ["Minimum", `${num(quote.minAmount)} ${token}`],
              ]}
            />
          </div>
          <p className="muted small" data-testid="fee-line">
            The fee includes our {bpsPercent(quote.ourFeeBps)}.
          </p>

          {(view.kind === "waiting" || view.kind === "seen") && (
            <>
              <p>
                Send exactly {num(quote.amountIn)} {token} on {chainDef.name} to:
              </p>
              <div className="addr" data-testid="deposit-address">
                {quote.depositAddress}
              </div>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(quote.depositAddress);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              <Qr text={quote.depositAddress} label="Deposit address as a QR code" />
              <Notice testId="deposit-status" live>
                {view.kind === "seen" ? "We see your transfer. It is on its way to your private balance." : `Waiting for your transfer. This quote ends in ${countdown(view.msLeft)}.`}
              </Notice>
              {view.kind === "waiting" && (
                <>
                  <button type="button" className="secondary" data-testid="other-quote" onClick={startOver}>
                    Choose another way to deposit
                  </button>
                  <p className="small muted">Only if you have not sent anything to this address.</p>
                </>
              )}
            </>
          )}
          {pollError && view.kind !== "expired" && <Notice kind="warn">{pollError}</Notice>}
          {view.kind === "done" && (
            <Notice kind="ok" testId="deposit-status">
              In your private balance: {usd(view.amountOut ?? quote.amountOut)}
            </Notice>
          )}
          {view.kind === "refunded" && (
            <Notice kind="warn" testId="deposit-status">
              Your deposit could not go through, so it was sent back to {refundTo}.
            </Notice>
          )}
          {view.kind === "expired" && (
            <>
              <Notice kind="warn" testId="deposit-status">
                {pollError ?? "That quote expired. Don't send to that address."}
              </Notice>
              <button type="button" onClick={getQuote} disabled={busy}>
                Get a new quote
              </button>
              <button type="button" className="secondary" onClick={startOver}>
                Choose another way to deposit
              </button>
            </>
          )}
          {(view.kind === "done" || view.kind === "refunded") && (
            <button type="button" className="secondary" onClick={() => setQuote(undefined)}>
              Deposit again
            </button>
          )}
        </>
      )}
    </Screen>
  );
}
