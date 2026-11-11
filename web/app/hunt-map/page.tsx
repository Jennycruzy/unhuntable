"use client";
import Link from "next/link";
import { useState } from "react";
import { Mark } from "../../components/icons";
import { Notice } from "../../components/ui";
import { sentence } from "../../lib/api";
import { time } from "../../lib/format";
import { awayText, bandRows, money, px, short } from "../../lib/huntmap";
import { hyperliquidPage } from "../../lib/links";
import { api, useInterval } from "../../lib/session";
import type { HuntMap, MapCoin } from "../../lib/types";

/** The money that is liquidated at each step away from the price, as bars on one scale. */
function Ladder({ coin }: { coin: MapCoin }) {
  const rows = bandRows(coin);
  const top = Math.max(...rows.map((r) => (r.kind === "band" ? r.usd : 0)), 1);
  return (
    <ol className="hm-ladder num" aria-label={`${coin.coin}: ${money(coin.usd)} is liquidated within 10% of the price ${px(coin.markPx)}.`}>
      {rows.map((r) =>
        r.kind === "price" ? (
          <li key="price" className="hm-now">
            <b>Price {px(coin.markPx)}</b>
          </li>
        ) : (
          <li key={r.pct}>
            <span className="hm-step">
              {r.pct > 0 ? "+" : "−"}
              {Math.abs(r.pct)}%
            </span>
            <span className="hm-at">{px(r.px)}</span>
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
              <rect className="hm-bar" width={Math.max(1.5, (r.usd / top) * 100)} height="8" />
            </svg>
            <span className="hm-usd">{money(r.usd)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

function Coin({ coin }: { coin: MapCoin }) {
  return (
    <article className="hm-coin" data-testid={`coin-${coin.coin}`}>
      <header>
        <h3>{coin.coin}</h3>
        <span className="num">{money(coin.usd)} within 10% of the price</span>
      </header>
      <Ladder coin={coin} />
      <table className="hm-table num">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Position</th>
            <th scope="col" className="r">
              Size
            </th>
            <th scope="col" className="r">
              Liquidated at
            </th>
          </tr>
        </thead>
        <tbody>
          {coin.nearest.map((l) => (
            <tr key={l.account + l.liqPx}>
              <td>
                <a href={hyperliquidPage(l.account)} target="_blank" rel="noopener noreferrer">
                  {short(l.account)}
                </a>
              </td>
              <td>
                {l.side === "long" ? "Long" : "Short"}
                {l.leverage ? ` ${l.leverage}x` : ""}
              </td>
              <td className="r">{money(l.valueUsd)}</td>
              <td className="r">
                <b className="hm-liq">{px(l.liqPx)}</b> <span className="muted">{awayText(l.awayPct)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

function Followed({ map }: { map: HuntMap }) {
  const f = map.followed;
  return (
    <section className="section" data-testid="followed">
      <div className="wrap">
        <span className="kicker">What the price did next</span>
        <h2>Levels everyone could read.</h2>
        <p className="lede">
          Since {time(map.sinceMs)} we have followed every liquidation price that came within 5% of the market, for one day each.
        </p>
        <div className="hm-facts">
          <div>
            <strong className="num">{f.levels}</strong>
            <span>visible levels followed</span>
          </div>
          <div>
            <strong className="num">{f.reached}</strong>
            <span>reached by the price</span>
          </div>
          <div>
            <strong className="num">{f.mirrorReached}</strong>
            <span>times the price went the same distance the other way</span>
          </div>
          <div>
            <strong className="num">{f.cameBack}</strong>
            <span>times it was halfway back within the hour</span>
          </div>
        </div>
        {map.touches.length > 0 && (
          <table className="hm-table num">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Position</th>
                <th scope="col" className="r">
                  Level seen
                </th>
                <th scope="col" className="r">
                  Reached
                </th>
              </tr>
            </thead>
            <tbody>
              {map.touches.map((t) => (
                <tr key={t.account + t.coin + t.seenMs}>
                  <td>
                    <a href={hyperliquidPage(t.account)} target="_blank" rel="noopener noreferrer">
                      {short(t.account)}
                    </a>
                  </td>
                  <td>
                    {t.side === "long" ? "Long" : "Short"} {t.coin} {money(t.valueUsd)}
                  </td>
                  <td className="r">
                    <b className="hm-liq">{px(t.liqPx)}</b> <span className="muted">at {time(t.seenMs)}</span>
                  </td>
                  <td className="r">
                    {time(t.touchedMs)}
                    {t.cameBack ? <span className="muted"> then back</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function HuntMapPage() {
  const [map, setMap] = useState<HuntMap | null | undefined>();
  const [error, setError] = useState<string | undefined>();
  useInterval(async () => {
    try {
      setMap((await api.huntMap()).map);
      setError(undefined);
    } catch (e) {
      setError(sentence(e));
    }
  }, 60_000);
  return (
    <div className="cover open">
      <header className="cover-top">
        <Link href="/" className="mark" aria-label="Unhuntable">
          <Mark />
          Unhuntable
        </Link>
        <nav aria-label="Site">
          <Link href="/hunt-map/" aria-current="page" className="hide-s">
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
        <section className="wrap hero hm-hero">
          <h1>The Hunt Map</h1>
          <p className="lede">
            Every price below is the point where a real Hyperliquid account is closed out. Anyone can read them from Hyperliquid&apos;s public data. So can
            anyone who wants to push the price there.
          </p>
          {error && <Notice kind="error">{error}</Notice>}
          {map === null && <Notice>The first read of Hyperliquid is still running. This page fills in by itself.</Notice>}
          {map && (
            <div className="hm-facts" data-testid="totals">
              <div>
                <strong className="num">{money(map.usd)}</strong>
                <span>in positions with a visible liquidation price</span>
              </div>
              <div>
                <strong className="num">{map.positions}</strong>
                <span>positions of $250K or more</span>
              </div>
              <div>
                <strong className="num">{map.accounts}</strong>
                <span>accounts</span>
              </div>
              <div>
                <strong className="num">{map.stops}</strong>
                <span>resting stops read in the last day</span>
              </div>
            </div>
          )}
          {map && (
            <p className="film-note" data-testid="as-of">
              Read from Hyperliquid at {time(map.asOfMs)}. Read again every 5 minutes.
            </p>
          )}
        </section>

        {map && map.coins.length > 0 && (
          <section className="wrap hm-coins" aria-label="Liquidation prices by market">
            {map.coins.map((c) => (
              <Coin key={c.coin} coin={c} />
            ))}
          </section>
        )}

        {map && <Followed map={map} />}

        <section className="section closing">
          <div className="wrap">
            <h2>Through Unhuntable, there is no row to read.</h2>
            <p className="lede hm-close">
              Your position is split across accounts nobody can link, and your stop is sealed inside an OutLayer enclave. It is on no list like this one.
            </p>
            <Link className="button" href="/signin/">
              Start
            </Link>
          </div>
        </section>
      </main>
      <footer className="wrap cover-foot">
        <span>
          Read from Hyperliquid&apos;s public API: the 2,000 largest accounts on its leaderboard, positions of $250K or more.
        </span>
        <nav aria-label="Footer">
          <Link href="/">Unhuntable</Link>
          <a href="/exit/index.html">Exit tool</a>
        </nav>
      </footer>
    </div>
  );
}
