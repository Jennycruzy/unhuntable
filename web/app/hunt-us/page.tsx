"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ticker } from "unhuntable-client/hyperliquid";
import { Mark } from "../../components/icons";
import { Notice } from "../../components/ui";
import { sentence } from "../../lib/api";
import { time } from "../../lib/format";
import { money, px, short } from "../../lib/huntmap";
import { payerLine, revealHeadline, secondsLeft } from "../../lib/huntus";
import { hyperliquidPage } from "../../lib/links";
import { api } from "../../lib/session";
import type { HuntUsChallenge, HuntUsReveal } from "../../lib/types";

function Reveal({ r }: { r: HuntUsReveal }) {
  return (
    <section className="wrap hu-reveal" data-testid="hunt-reveal" aria-label="The answer">
      <h2 data-testid="hunt-headline">{revealHeadline(r)}</h2>
      <div className="hu-rows">
        {r.pieces.map((p, i) => (
          <article key={p.address} className="hm-coin" data-testid="hunt-piece">
            <header>
              <h3>Piece {i + 1}</h3>
              <a href={hyperliquidPage(p.address)} target="_blank" rel="noopener noreferrer" className="hu-addr">
                {short(p.address)}
              </a>
            </header>
            <dl className="hu-facts num">
              <div>
                <dt>Position</dt>
                <dd>{p.side ? `${p.side === "long" ? "Long" : "Short"} ${p.valueUsd !== null ? money(p.valueUsd) : ""}` : "None"}</dd>
              </div>
              <div>
                <dt>Liquidated at</dt>
                <dd>{p.liqPx !== null ? px(p.liqPx) : "–"}</dd>
              </div>
              <div>
                <dt>Orders on the book</dt>
                <dd>{p.restingOrders}</dd>
              </div>
            </dl>
            <p className="small muted">
              {payerLine(p, r.payerWindowHours, short)}
              {p.fundedAtMs !== null && <>, {time(p.fundedAtMs)}</>}.
            </p>
          </article>
        ))}
      </div>
      <p className="small muted">
        Read live from Hyperliquid&apos;s public API at {time(r.asOfMs)}. Every address opens its public page, where you can check each line yourself.
      </p>
    </section>
  );
}

export default function HuntUsPage() {
  const [c, setC] = useState<HuntUsChallenge | null | undefined>();
  const [run, setRun] = useState<{ token: string; revealAtMs: number } | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [reveal, setReveal] = useState<HuntUsReveal | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .huntUs()
      .then((r) => setC(r.challenge))
      .catch((e) => setError(sentence(e)));
  }, []);

  useEffect(() => {
    if (!run || reveal) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run, reveal]);

  const left = run ? secondsLeft(run.revealAtMs, now) : null;
  useEffect(() => {
    if (!run || reveal || left !== 0) return;
    api
      .huntUsReveal(run.token)
      .then(setReveal)
      .catch((e) => setError(sentence(e)));
  }, [run, reveal, left]);

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
          <Link href="/hunt-us/" aria-current="page" className="hide-s">
            Hunt us
          </Link>
          <Link href="/signin/" className="pill">
            Sign in
          </Link>
        </nav>
      </header>
      <main>
        <section className="wrap hero hm-hero">
          <h1>Hunt us</h1>
          <p className="lede">
            One of our own positions is open on Hyperliquid right now, split into pieces. Here is one of them. Find the others and the stop, with any public tool
            you like. You have 90 seconds.
          </p>
          {error && <Notice kind="error">{error}</Notice>}
          {c === null && <Notice>No challenge position is open right now.</Notice>}
          {c && (
            <div className="card hu-start" data-testid="hunt-shown">
              <p className="stat-label">
                {ticker(c.coin)} · one of {c.count} pieces
              </p>
              <a className="addr" href={hyperliquidPage(c.shown)} target="_blank" rel="noopener noreferrer" data-testid="hunt-address">
                {c.shown}
              </a>
              {!run && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setRun(await api.huntUsStart());
                      setNow(Date.now());
                    } catch (e) {
                      setError(sentence(e));
                    }
                  }}
                >
                  Start the 90 seconds
                </button>
              )}
              {run && !reveal && (
                <p className="hu-clock num" data-testid="hunt-clock" aria-live="polite">
                  {left && left > 0 ? `${left} s` : "Time. Reading Hyperliquid…"}
                </p>
              )}
            </div>
          )}
        </section>
        {reveal && <Reveal r={reveal} />}
      </main>
      <footer className="wrap cover-foot">
        <span>The answer is read from Hyperliquid&apos;s public API, the same data any hunter has.</span>
        <nav aria-label="Footer">
          <Link href="/">Unhuntable</Link>
          <Link href="/hunt-map/">Hunt Map</Link>
        </nav>
      </footer>
    </div>
  );
}
