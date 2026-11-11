"use client";
import { useState } from "react";
import { againstChance, guessLine, headline, proofLine } from "../lib/aihunt";
import { ApiError } from "../lib/api";
import { usd } from "../lib/format";
import { ownLevel } from "../lib/hunter";
import { px, short } from "../lib/huntmap";
import { hyperliquidPage } from "../lib/links";
import { api, useInterval } from "../lib/session";
import type { AiHunt, Position } from "../lib/types";

/**
 * NEAR AI Hunter: an AI model inside a NEAR AI Cloud TEE starts from one of this position's
 * pieces and tries to find the others in Hyperliquid's public data. The owner sees what it
 * named against the truth, and can download the signed question and answer.
 */
export function AiHunter({ p, levels }: { p: Position; levels: Record<string, { stop?: number; tp?: number } | undefined> }) {
  const [hunt, setHunt] = useState<AiHunt | null | undefined>();
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const running = hunt?.state === "running";

  const read = async () => {
    try {
      setHunt((await api.aiHunt(p.id)).hunt);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setOff(true);
    }
  };
  useInterval(read, off ? null : running || hunt === undefined ? 4_000 : 60_000);

  if (off || p.pieces.length < 2) return null;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.startAiHunt(p.id);
      await read();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The hunt could not start. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!hunt) return;
    try {
      const r = await api.aiHuntReceipt(p.id, hunt.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-hunt-${hunt.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The download did not work. Try again.");
    }
  };

  const named = new Map((hunt?.answer?.picks ?? []).map((x) => [x.label, x]));
  const stop = ownLevel(p, levels, "stop");
  const left = hunt ? Math.max(0, hunt.hunts.perDay - hunt.hunts.today) : null;

  return (
    <section className="ah" data-testid="ai-hunter" aria-label="NEAR AI hunter">
      <h3>NEAR AI hunter</h3>
      <p className="small">
        An attacker AI, running inside a NEAR AI Cloud TEE, starts from one of your pieces and tries to find the others using only Hyperliquid&rsquo;s public data. Your
        other pieces are always in its lineup, and it is told so.
      </p>

      {hunt?.state === "done" && hunt.score && (
        <div className="ah-result" data-testid="ai-hunt-result">
          <p className={`ah-verdict ah-${hunt.score.verdict}`} data-testid="ai-hunt-verdict">
            {headline(hunt.score)}
          </p>
          <p className="small" data-testid="ai-hunt-chance">
            {againstChance(hunt.score)}
          </p>
          <ul className="ah-rows" data-testid="ai-hunt-lineup">
            {(hunt.lineup ?? []).map((l) => {
              const pick = named.get(l.label);
              return (
                <li key={l.label} data-testid="ai-hunt-row" className={pick ? "ah-named" : undefined}>
                  <span className="ah-label">{l.label}</span>
                  <a href={hyperliquidPage(l.address)} target="_blank" rel="noopener noreferrer">
                    {short(l.address)}
                  </a>
                  <span className="ah-tags">
                    {l.yours && <span className="badge">Your piece</span>}
                    {pick && <span className="badge bad">Named{pick.confidence !== null ? ` ${pick.confidence}%` : ""}</span>}
                  </span>
                  {pick?.why && <span className="ah-why">{pick.why}</span>}
                </li>
              );
            })}
          </ul>
          <dl className="ah-facts">
            <div>
              <dt>Its guess of the position</dt>
              <dd data-testid="ai-hunt-guess">{guessLine(hunt)}</dd>
            </div>
            <div>
              <dt>The real position</dt>
              <dd>
                {hunt.truth.side === "long" ? "Long" : "Short"} {usd(hunt.truth.usd)}
              </dd>
            </div>
            <div>
              <dt>Its guess of your stop</dt>
              <dd data-testid="ai-hunt-stop">{hunt.answer?.stopGuess != null ? px(hunt.answer.stopGuess) : "It could not tell"}</dd>
            </div>
            <div>
              <dt>Your stop</dt>
              <dd>{typeof stop === "number" ? px(stop) : stop === "set" ? "Sealed (set in another browser)" : "None"}</dd>
            </div>
          </dl>
          {hunt.answer?.summary && <p className="small ah-summary">&ldquo;{hunt.answer.summary}&rdquo;</p>}
          {hunt.proof && (
            <div className="ah-proof" data-testid="ai-hunt-proof">
              <p className="small">{proofLine(hunt.proof)}</p>
              <p className="muted small mono">
                {hunt.proof.model} · {hunt.proof.chatId}
              </p>
              <button type="button" className="secondary" onClick={download}>
                Download the signed question and answer
              </button>
            </div>
          )}
        </div>
      )}

      {running && (
        <p className="ah-running" role="status" data-testid="ai-hunt-running">
          Hunting. It reads Hyperliquid&rsquo;s public data for about 15 accounts, then asks the model. This takes about 3 minutes.
        </p>
      )}
      {hunt?.state === "failed" && hunt.error && (
        <p className="small" role="alert" data-testid="ai-hunt-failed">
          {hunt.error}
        </p>
      )}
      {error && (
        <p className="small" role="alert" data-testid="ai-hunt-error">
          {error}
        </p>
      )}
      {!running && (
        <div className="ah-actions">
          <button type="button" className={hunt ? "secondary" : undefined} disabled={busy || left === 0} onClick={start} data-testid="ai-hunt-start">
            {hunt ? "Send the hunter again" : "Send the hunter"}
          </button>
          {left !== null && <span className="muted small">{left === 1 ? "1 hunt left today" : `${left} hunts left today`}</span>}
        </div>
      )}
    </section>
  );
}
