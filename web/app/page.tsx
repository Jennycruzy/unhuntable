"use client";
import Link from "next/link";
import { useState } from "react";
import { Mark } from "../components/icons";
import { Notice } from "../components/ui";
import { sentence } from "../lib/api";
import { usd } from "../lib/format";
import { api, useInterval, useSession } from "../lib/session";
import type { Balance } from "../lib/types";

/* ------------------------------------------------------------------ signed in */

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
        <div className="row-buttons">
          <Link className="button" href="/trade/">
            Trade
          </Link>
          <Link className="button secondary" href="/deposit/">
            Deposit
          </Link>
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ cover */

/** One market, drawn twice: the wick that liquidates a public position finds nothing to hit in pieces. */
const PRICE =
  "M10 120 L38 112 L64 126 L92 104 L120 116 L148 92 L176 108 L204 98 L232 118 L260 102 L288 124 L316 110 L344 130 L372 116 L400 138 L424 128 L446 134 L458 202 L470 150 L492 140 L510 132";

function Chart({ kind }: { kind: "seen" | "hidden" }) {
  return (
    <svg viewBox="0 0 520 250" className={kind} role="img" aria-label={kind === "seen" ? "A public position: its liquidation price and stop are visible, and a wick down to them liquidates it" : "The same position in pieces: no levels to see, and the same wick hits nothing"}>
      <g className="grid">
        {[50, 100, 150, 200].map((y) => (
          <line key={y} x1="0" x2="520" y1={y} y2={y} />
        ))}
      </g>
      {kind === "seen" ? (
        <>
          <line className="lvl stop" x1="0" x2="520" y1="176" y2="176" />
          <text className="tag stop" x="436" y="170" textAnchor="end">
            Stop 62,180
          </text>
          <line className="lvl liq" x1="0" x2="520" y1="198" y2="198" />
          <text className="tag liq" x="436" y="216" textAnchor="end">
            Liquidation 61,240
          </text>
          <g className="pos">
            <rect x="14" y="26" width="112" height="30" rx="15" />
            <text x="70" y="46" textAnchor="middle" className="tag">
              Long $2.4M
            </text>
          </g>
          <circle className="boom" cx="458" cy="200" r="10" />
          <text className="verdict" x="436" y="240" textAnchor="end">
            Liquidated
          </text>
        </>
      ) : (
        <>
          {[
            [70, 64],
            [168, 172],
            [262, 52],
            [338, 186],
            [410, 70],
          ].map(([x, y]) => (
            <rect key={x} className="piece" x={x - 4} y={y - 4} width="8" height="8" rx="2" />
          ))}
          <text className="tag dim" x="14" y="34">
            5 accounts · no stops on the book
          </text>
          <circle className="sonar" cx="458" cy="200" r="22" />
          <text className="verdict" x="436" y="240" textAnchor="end">
            Nothing to hit
          </text>
        </>
      )}
      <path className="px" d={PRICE} pathLength={1000} />
    </svg>
  );
}

function Cover() {
  return (
    <div className="cover">
      <header className="cover-top">
        <Link href="/" className="mark" aria-label="Unhuntable">
          <Mark />
          Unhuntable
        </Link>
        <nav aria-label="Site">
          <a href="#how" className="hide-s">
            How it works
          </a>
          <a href="/exit/index.html" className="hide-s">
            Exit tool
          </a>
          <Link href="/signin/" className="pill">
            Sign in
          </Link>
        </nav>
      </header>

      <main>
        <section className="wrap hero">
          <h1>Trade big. Leave nothing to hunt.</h1>
          <p className="lede">Your position is split across accounts nobody can link, and your stop stays sealed until the moment it fires.</p>
          <div className="cta">
            <Link className="button" href="/signin/">
              Start
            </Link>
            <a className="button secondary" href="#how">
              How it works
            </a>
          </div>
          <div className="film">
            <figure>
              <figcaption>
                <b>On Hyperliquid today</b>
                <span>Public</span>
              </figcaption>
              <Chart kind="seen" />
            </figure>
            <figure>
              <figcaption>
                <b>With Unhuntable</b>
                <span>Same size</span>
              </figcaption>
              <Chart kind="hidden" />
            </figure>
          </div>
        </section>

        <section className="section" id="how">
          <div className="wrap">
            <span className="kicker">How it works</span>
            <h2>Nothing on the book to aim at.</h2>
            <div className="trio">
              <article>
                <svg viewBox="0 0 320 180" className="d-split" aria-hidden>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <rect key={i} className="bar solid" x={120 + i * 16} y="80" width="15" height="20" rx="2" />
                  ))}
                </svg>
                <h3>Pieces</h3>
                <p>One position, split across separate accounts and funded privately through NEAR Intents.</p>
              </article>
              <article>
                <svg viewBox="0 0 320 180" className="d-stop" aria-hidden>
                  <path className="ink" d="M24 64 L70 74 L104 66 L146 86 L188 80 L232 100 L292 92" />
                  <line className="ghost" x1="16" x2="304" y1="100" y2="100" />
                  <line className="acc-stroke sealed" x1="16" x2="304" y1="100" y2="100" />
                  <circle className="acc fire" cx="236" cy="100" r="9" />
                  <circle className="solid dot" cx="40" cy="64" r="4" />
                </svg>
                <h3>Invisible stops</h3>
                <p>Sealed in your browser and held in an enclave. Sent as a market order only when price crosses.</p>
              </article>
              <article>
                <svg viewBox="0 0 320 180" className="d-guard" aria-hidden>
                  <rect className="ink" x="44" y="66" width="76" height="48" rx="10" />
                  <text className="lbl" x="82" y="94" textAnchor="middle">
                    guard
                  </text>
                  <rect className="ink" x="212" y="66" width="76" height="48" rx="10" />
                  <text className="lbl" x="250" y="94" textAnchor="middle">
                    trade
                  </text>
                  <line className="acc-stroke trade" x1="124" x2="208" y1="90" y2="90" />
                  <line className="bad-stroke out" x1="82" x2="82" y1="118" y2="160" />
                  <g className="no">
                    <line className="bad-stroke" x1="72" x2="92" y1="132" y2="152" />
                    <line className="bad-stroke" x1="92" x2="72" y1="132" y2="152" />
                  </g>
                  <text className="lbl" x="100" y="146">
                    withdraw
                  </text>
                </svg>
                <h3>A guard that can&apos;t withdraw</h3>
                <p>It trades and defends your pieces. Hyperliquid refuses any transfer it signs.</p>
              </article>
            </div>
            <div className="stack-row">
              <b>Built on NEAR</b>
              {["NEAR Intents", "OutLayer", "Hyperliquid", "Aurora", "Meteor", "HOT Wallet"].map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap exit">
            <div>
              <span className="kicker">Your exit</span>
              <h2>Leave without us.</h2>
              <p className="lede">Twelve words and an open tool bring your money home, even with our servers off.</p>
              <p>
                <a href="/exit/index.html">Open the exit tool</a>
              </p>
            </div>
            <ol className="words" aria-hidden>
              {Array.from({ length: 12 }, (_, i) => (
                <li key={i}>
                  <span>{i + 1}</span>•••••
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section closing">
          <div className="wrap">
            <h2>Your size is your business.</h2>
            <Link className="button" href="/signin/">
              Start
            </Link>
          </div>
        </section>
      </main>

      <footer className="wrap cover-foot">
        <span className="mark">
          <Mark />
          Unhuntable
        </span>
        <nav aria-label="Footer">
          <a href="/exit/index.html">Exit tool</a>
          <a href="/llms.txt">llms.txt</a>
        </nav>
      </footer>
    </div>
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
      <Cover />
    </>
  );
}
