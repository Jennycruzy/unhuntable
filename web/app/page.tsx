"use client";
import Link from "next/link";
import { useState } from "react";
import { Landing } from "../components/landing/Landing";
import { Notice } from "../components/ui";
import { sentence } from "../lib/api";
import { usd } from "../lib/format";
import { currentWallet } from "../lib/wallet";
import { api, useInterval, useSession } from "../lib/session";
import type { Balance } from "../lib/types";
import "./landing.css";

/* ------------------------------------------------------------------ signed in */

/** Ends the session here and in the wallet, then shows the cover page. Your pieces key stays on this device. */
function SignOut() {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      data-testid="sign-out"
      onClick={async () => {
        setBusy(true);
        try {
          await api.logout();
        } catch {
          // the cookie may already be gone; the next check shows the cover page either way
        }
        try {
          await (await currentWallet())?.signOut();
        } catch {
          // no wallet chosen in this browser
        }
        await refresh();
        setBusy(false);
        window.scrollTo(0, 0);
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

function Overview({ accountId, needsSetup }: { accountId: string; needsSetup: boolean }) {
  const [balance, setBalance] = useState<Balance | undefined>();
  const [error, setError] = useState<string | undefined>();
  useInterval(async () => {
    try {
      setBalance(await api.balance());
      setError(undefined);
    } catch (e) {
      setError(sentence(e));
    }
  }, 15_000);
  const inPieces = balance?.pieces.reduce((a, p) => a + Number(p.perpUsd) + Number(p.spotUsd), 0);
  return (
    <main className="screen">
      <h1 className="who" data-testid="account">
        {accountId}
      </h1>
      {error && <Notice kind="error">{error}</Notice>}
      <p className="stat fade-in" data-testid="private-balance">
        {balance ? usd(balance.privateUsdc) : "–"}
      </p>
      <p className="stat-label">Private balance</p>
      <div className="split">
        <div>
          <span className="stat-label">In pieces</span>
          <strong>{inPieces === undefined ? "–" : usd(inPieces)}</strong>
        </div>
        <div>
          <span className="stat-label">Pieces</span>
          <strong>{balance ? balance.pieces.length : "–"}</strong>
        </div>
      </div>
      {needsSetup ? (
        <Link className="button" href="/setup/">
          Set up my pieces key
        </Link>
      ) : (
        <>
          <div className="row-buttons">
            <Link className="button" href="/trade/">
              Trade
            </Link>
            <Link className="button secondary" href="/deposit/">
              Deposit
            </Link>
          </div>
          <p className="small">
            <Link href="/agents/">AI agents</Link>: let an agent trade through your pieces, with its own key and limits.
          </p>
        </>
      )}
      <SignOut />
    </main>
  );
}

export default function Start() {
  const { me } = useSession();
  if (me.status === "ok") return <Overview accountId={me.me.accountId} needsSetup={me.me.piecesKey === "missing"} />;
  return (
    <>
      {me.status === "error" && (
        <div className="wrap">
          <Notice kind="error">{me.message}</Notice>
        </div>
      )}
      <Landing />
    </>
  );
}
