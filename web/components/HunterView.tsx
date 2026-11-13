"use client";
import { useState } from "react";
import { ticker } from "unhuntable-client/hyperliquid";
import { usd } from "../lib/format";
import { ownLevel, sideWord, verdict } from "../lib/hunter";
import { px, short } from "../lib/huntmap";
import { hyperliquidPage } from "../lib/links";
import { api, useInterval } from "../lib/session";
import type { HunterView as View, Position } from "../lib/types";

const READ_FAILED = "Hyperliquid's public data could not be read just now. Trying again.";

function level(v: number | "set" | "none"): string {
  return typeof v === "number" ? px(v) : v === "set" ? "Set" : "None";
}

/** One position twice: what its owner knows, and what Hyperliquid's public API tells anyone. */
export function HunterView({
  p,
  levels,
  read = () => api.hunter(p.id),
}: {
  p: Position;
  levels: Record<string, { stop?: number; tp?: number } | undefined>;
  /** Where the public view comes from; judge mode reads its own run. */
  read?: () => Promise<View>;
}) {
  const [view, setView] = useState<View | undefined>();
  const [failed, setFailed] = useState(false);
  useInterval(async () => {
    try {
      setView(await read());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, 15_000);

  const coin = ticker(p.coin);
  const side = p.side === "long" ? "Long" : "Short";
  return (
    <section className="hv" data-testid="hunter-view" aria-label="Hunter's view">
      <h3>Hunter&rsquo;s view</h3>
      <div className="hv-cols">
        <div className="hv-col" data-testid="hunter-you">
          <h4>You see</h4>
          <p className="hv-big">
            {side} {usd(p.notionalUsd)} {coin}
          </p>
          <dl>
            <div>
              <dt>Stop</dt>
              <dd>{level(ownLevel(p, levels, "stop"))}</dd>
            </div>
            <div>
              <dt>Take-profit</dt>
              <dd>{level(ownLevel(p, levels, "tp"))}</dd>
            </div>
            <div>
              <dt>Leverage</dt>
              <dd>{p.leverage}x</dd>
            </div>
          </dl>
        </div>
        <div className="hv-col" data-testid="hunter-public">
          <h4>Everyone else sees</h4>
          {!view && !failed && <p className="muted small">Reading Hyperliquid…</p>}
          {!view && failed && <p className="muted small">{READ_FAILED}</p>}
          {view && (
            <>
              <ul className="hv-rows">
                {view.accounts.map((a) => (
                  <li key={a.address} data-testid="hunter-account">
                    <a href={hyperliquidPage(a.address)} target="_blank" rel="noopener noreferrer">
                      {short(a.address)}
                    </a>
                    <span className="hv-pos">
                      {sideWord(a)}
                      {a.valueUsd !== null && <> {usd(a.valueUsd)}</>}
                      {a.liqPx !== null && <> · liquidation {px(a.liqPx)}</>}
                    </span>
                    <span className="hv-orders">{a.restingOrders === 0 ? "No orders" : a.restingOrders === 1 ? "1 order" : `${a.restingOrders} orders`}</span>
                  </li>
                ))}
              </ul>
              <p className="hv-verdict" data-testid="hunter-verdict">
                {verdict(view)}
              </p>
              {failed && <p className="muted small">{READ_FAILED}</p>}
            </>
          )}
        </div>
      </div>
      <p className="muted small">&ldquo;Everyone else sees&rdquo; is read from Hyperliquid&rsquo;s public API, the same answer any tracker gets. Open an address to check it.</p>
    </section>
  );
}
