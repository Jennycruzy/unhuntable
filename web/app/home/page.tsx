"use client";
import { useEffect, useState } from "react";
import { Facts, Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { time, usd } from "../../lib/format";
import { HomeFlow, localRelock, stepWords } from "../../lib/home";
import { api, useInterval } from "../../lib/session";
import type { HomeStart, HomeState, Me } from "../../lib/types";
import { currentWallet } from "../../lib/wallet";

/** The exit fee, said before anything starts (server/src/refusals.ts exit_fee). */
const EXIT_FEE = "Leaving Hyperliquid costs about $1.20 per piece (Hyperliquid's new-account fee plus routing).";

const STATE_WORDS: Record<string, string> = {
  unlock_wait: "Waiting for your first approval",
  moving: "Moving your money",
  relock_wait: "Waiting for your second approval",
  done: "Done",
  failed: "Stopped",
};

async function flow(): Promise<HomeFlow> {
  const wallet = await currentWallet();
  if (!wallet) throw new Error("Sign in with your wallet again first.");
  return new HomeFlow(api, wallet);
}

function GoHome(_: { me: Me }) {
  const [start, setStart] = useState<HomeStart | undefined>();
  const [homeId, setHomeId] = useState<string | undefined>();
  const [state, setState] = useState<HomeState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [relocked, setRelocked] = useState(false);

  useEffect(() => {
    const id = localRelock.get();
    if (id) setHomeId(id);
  }, []);

  useInterval(async () => {
    if (!homeId) return;
    try {
      setState(await api.homeState(homeId));
    } catch (e) {
      setError(sentence(e));
    }
  }, homeId && !relocked && state?.state !== "done" && state?.state !== "failed" ? 5000 : null);

  async function act(f: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  const begin = () => act(async () => setStart(await api.home()));
  const unlock = () =>
    act(async () => {
      if (!start) return;
      await (await flow()).approveUnlock(start);
      setHomeId(start.homeId);
      setStart(undefined);
    });
  const relock = () =>
    act(async () => {
      if (!state) return;
      await (await flow()).approveRelock(state);
      setRelocked(true);
      setState(await api.homeState(state.homeId));
    });

  return (
    <>
      {error && (
        <Notice kind="error" testId="home-error">
          {error}
        </Notice>
      )}

      {!start && !homeId && (
        <>
          <p>Closes your pieces and brings the money back to your private balance. Your wallet asks twice: unlock, then lock again.</p>
          <Notice testId="exit-fee">{EXIT_FEE}</Notice>
          <button type="button" disabled={busy} onClick={begin}>
            Send home
          </button>
        </>
      )}

      {start && (
        <>
          <div className="card">
            <Facts rows={[["Exit fee", <span key="f" data-testid="home-fee">{usd(start.feeUsd)}</span>]]} />
          </div>
          <h2>First approval: unlock</h2>
          <ul className="plain" data-testid="unlock-summary">
            {start.unlockBatch.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={unlock}>
            {busy ? "Waiting for your wallet…" : "Approve in my wallet"}
          </button>
        </>
      )}

      {homeId && !state && <p className="muted">Loading…</p>}

      {state && (
        <>
          <p>
            <span className="badge" data-testid="home-state">
              {STATE_WORDS[state.state] ?? state.state}
            </span>
          </p>
          <ul className="plain" data-testid="home-steps">
            {state.steps.map((s, i) => (
              <li key={i}>
                <span className="muted small">{time(s.ms)}</span> {stepWords(s)}
              </li>
            ))}
          </ul>
          {state.arrivedUsdc !== undefined && <Notice kind="ok">Arrived in your private balance: {usd(state.arrivedUsdc)}</Notice>}
          {state.relockBatch && !relocked && (
            <>
              <h2>Second approval: lock your pieces again</h2>
              <ul className="plain" data-testid="relock-summary">
                {state.relockBatch.summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <button type="button" disabled={busy} onClick={relock}>
                {busy ? "Waiting for your wallet…" : "Lock my pieces again"}
              </button>
            </>
          )}
          {relocked && <Notice kind="ok" testId="relocked">Your pieces are locked again.</Notice>}
        </>
      )}

      <p className="foot">
        <a href="/exit/index.html">Leave without us</a>
      </p>
    </>
  );
}

export default function HomePage() {
  return (
    <Screen title="Send home">
      <SignedIn>{(me) => <GoHome me={me} />}</SignedIn>
    </Screen>
  );
}
