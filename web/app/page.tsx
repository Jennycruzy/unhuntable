"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Mark } from "../components/icons";
import { Notice } from "../components/ui";
import { sentence } from "../lib/api";
import { usd } from "../lib/format";
import { api, useInterval, useSession } from "../lib/session";
import { hyperliquidPage } from "../lib/links";
import type { Balance, Whale } from "../lib/types";

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
    </main>
  );
}

/* ------------------------------------------------------------------ cover */

/** One market, drawn twice: the wick that liquidates a public position finds nothing to hit in pieces.
    The numbers are the largest position on Hyperliquid right now, read by our server from Hyperliquid's own API. */
const PRICE = [
  [10, 120], [38, 112], [64, 126], [92, 104], [120, 116], [148, 92], [176, 108], [204, 98], [232, 118], [260, 102], [288, 124],
  [316, 110], [344, 130], [372, 116], [400, 138], [424, 128], [446, 134], [458, 202], [470, 150], [492, 140], [510, 132],
];
const H = 250;

function px(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : v >= 10 ? 2 : 4 });
}

function money(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

function Chart({ kind, whale }: { kind: "seen" | "hidden"; whale: Whale | null }) {
  // a short is hunted upward: the same drawing, mirrored, with the words kept upright
  const up = whale?.side === "short";
  const y = (v: number) => (up ? H - v : v);
  const path = "M" + PRICE.map(([x, v]) => `${x} ${y(v)}`).join(" L");
  const side = whale ? (whale.side === "long" ? "Long" : "Short") : "Long";
  const pill = whale ? `${side} ${money(whale.sizeUsd)} ${whale.coin}` : side;
  const pillW = 26 + pill.length * 8.6;
  const label =
    kind === "seen"
      ? `A public position${whale ? `: ${pill} on Hyperliquid, liquidation at ${px(whale.liqPx)}` : ""}. Its levels are visible to everyone, and a wick to them liquidates it.`
      : "The same size in pieces: no levels to see, and the same wick hits nothing.";
  return (
    <svg viewBox={`0 0 520 ${H}`} className={kind} role="img" aria-label={label}>
      <g className="grid">
        {[50, 100, 150, 200].map((g) => (
          <line key={g} x1="0" x2="520" y1={g} y2={g} />
        ))}
      </g>
      {kind === "seen" ? (
        <>
          {(!whale || whale.stopPx !== null) && (
            <>
              <line className="lvl stop" x1="0" x2="520" y1={y(176)} y2={y(176)} />
              <text className="tag stop" x="436" y={up ? y(176) + 16 : y(176) - 6} textAnchor="end">
                {whale?.stopPx ? `Stop ${px(whale.stopPx)}` : "Stop"}
              </text>
            </>
          )}
          <line className="lvl liq" x1="0" x2="520" y1={y(198)} y2={y(198)} />
          <text className="tag liq" x="436" y={up ? y(198) + 20 : y(198) + 18} textAnchor="end">
            {whale ? `Liquidation ${px(whale.liqPx)}` : "Liquidation"}
          </text>
          <g className="pos">
            <rect x="14" y={up ? H - 56 : 26} width={pillW} height="30" rx="15" />
            <text x={14 + pillW / 2} y={up ? H - 36 : 46} textAnchor="middle" className="pilltext">
              {pill}
            </text>
          </g>
          <circle className="boom" cx="458" cy={y(200)} r="10" />
          <text className="verdict" x="436" y={up ? 22 : 240} textAnchor="end">
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
          ].map(([x, v]) => (
            <rect key={x} className="piece" x={x - 4} y={y(v) - 4} width="8" height="8" rx="2" />
          ))}
          <text className="tag dim" x="14" y={up ? H - 22 : 34}>
            5 accounts · no stops on the book
          </text>
          <circle className="sonar" cx="458" cy={y(200)} r="22" />
          <text className="verdict" x="436" y={up ? 22 : 240} textAnchor="end">
            Nothing to hit
          </text>
        </>
      )}
      <path className="px" d={path} pathLength={1000} />
    </svg>
  );
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Cover() {
  const [whale, setWhale] = useState<Whale | null>(null);
  useEffect(() => {
    api
      .whale()
      .then((r) => setWhale(r.whale))
      .catch(() => setWhale(null));
  }, []);
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
          <Link href="/hunt-map/" className="hide-s">
            Hunt Map
          </Link>
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
                <b>On Hyperliquid {whale ? "right now" : "today"}</b>
                {whale ? (
                  <a href={hyperliquidPage(whale.address)} target="_blank" rel="noopener noreferrer" data-testid="whale-link">
                    {short(whale.address)}
                  </a>
                ) : (
                  <span>Public</span>
                )}
              </figcaption>
              <Chart kind="seen" whale={whale} />
            </figure>
            <figure>
              <figcaption>
                <b>With Unhuntable</b>
                <span>Same size</span>
              </figcaption>
              <Chart kind="hidden" whale={whale} />
            </figure>
          </div>
          {whale && (
            <p className="film-note" data-testid="whale-note">
              Largest position on Hyperliquid, read from its public API {ago(whale.asOfMs)}.
            </p>
          )}
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
          <Link href="/hunt-map/">Hunt Map</Link>
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
