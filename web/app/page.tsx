"use client";
import Link from "next/link";
import { useState } from "react";
import { Facts, Notice, Screen } from "../components/ui";
import { sentence } from "../lib/api";
import { usd } from "../lib/format";
import { api, useInterval, useSession } from "../lib/session";
import type { Balance } from "../lib/types";

function SignedInStart({ accountId, needsSetup }: { accountId: string; needsSetup: boolean }) {
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
  return (
    <>
      <p className="muted">Signed in as {accountId}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {balance && (
        <div className="card">
          <Facts
            rows={[
              ["Private balance", <span key="b" data-testid="private-balance">{usd(balance.privateUsdc)}</span>],
              ["In pieces", usd(balance.pieces.reduce((a, p) => a + Number(p.perpUsd) + Number(p.spotUsd), 0))],
            ]}
          />
        </div>
      )}
      {needsSetup ? (
        <>
          <p>First, set up your pieces key. It is what lets you, and only you, move your money home.</p>
          <Link className="button" href="/setup/">
            Set up my pieces key
          </Link>
        </>
      ) : (
        <Link className="button" href="/trade/">
          Trade
        </Link>
      )}
    </>
  );
}

export default function Start() {
  const { me } = useSession();
  return (
    <Screen title="Unhuntable">
      <p>Trade on Hyperliquid in pieces: your position is split over separate small accounts, so as the world sees it there is no big position to hunt.</p>
      <p className="muted">Your stops are invisible stops: a stop that doesn&apos;t exist until it fires. A guard watches the price for you.</p>
      {me.status === "loading" && <p className="muted">Loading…</p>}
      {me.status === "error" && <Notice kind="error">{me.message}</Notice>}
      {me.status === "signed_out" && (
        <Link className="button" href="/signin/">
          Sign in
        </Link>
      )}
      {me.status === "ok" && <SignedInStart accountId={me.me.accountId} needsSetup={me.me.piecesKey === "missing"} />}
    </Screen>
  );
}
