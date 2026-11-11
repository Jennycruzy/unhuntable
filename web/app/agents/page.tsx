"use client";
import { useState } from "react";
import { Facts, Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { mcpConfig, nearTx } from "../../lib/agents";
import { time } from "../../lib/format";
import { api, useInterval } from "../../lib/session";
import type { AgentKeys, NewAgentKey } from "../../lib/types";

const COINS = ["BTC", "ETH", "SOL"] as const;

function NewKey({ onMade }: { onMade: (k: NewAgentKey) => void }) {
  const [name, setName] = useState("");
  const [max, setMax] = useState("100");
  const [coins, setCoins] = useState<string[]>(["ETH"]);
  const [daily, setDaily] = useState("5");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const toggle = (c: string) => setCoins((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  async function make() {
    setBusy(true);
    setError(undefined);
    try {
      onMade(await api.newAgent({ name: name.trim(), maxNotionalUsd: Number(max), coins, dailyOpens: Number(daily) }));
      setName("");
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="new-agent">
      <h2>New agent key</h2>
      <label htmlFor="agent-name">Name</label>
      <input id="agent-name" autoComplete="off" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="agent-max">Largest size it may open, in dollars</label>
      <input id="agent-max" inputMode="decimal" autoComplete="off" value={max} onChange={(e) => setMax(e.target.value)} />
      <fieldset>
        <legend>Markets</legend>
        <div className="choice" aria-label="Markets">
          {COINS.map((c) => (
            <label key={c}>
              <input type="checkbox" checked={coins.includes(c)} onChange={() => toggle(c)} aria-label={c} />
              <span>{c}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="agent-daily">Opens per day</label>
      <input id="agent-daily" inputMode="numeric" autoComplete="off" value={daily} onChange={(e) => setDaily(e.target.value)} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="button" disabled={busy || !name.trim() || coins.length === 0} onClick={make}>
        Make key
      </button>
    </div>
  );
}

function Agents() {
  const [keys, setKeys] = useState<AgentKeys | undefined>();
  const [made, setMade] = useState<NewAgentKey | undefined>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const load = async () => {
    try {
      setKeys(await api.agents());
      setError(undefined);
    } catch (e) {
      setError(sentence(e));
    }
  };
  useInterval(load, 15_000);

  const config = made ? mcpConfig(made.key) : "";
  return (
    <>
      <p className="lede-s">
        Give an AI agent its own key. It opens and closes positions on pieces you already set up, within the limits you set here, and seals its stops so they never
        sit on Hyperliquid&rsquo;s book. It cannot move money, make pieces, trade stocks or read a stop back.
      </p>
      {keys && (
        <Notice testId="agent-price">
          {keys.price
            ? `Each agent call costs ${keys.price} USDC on NEAR, paid by the agent with x402 to ${keys.payTo}.`
            : "Agent calls are free on this server."}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {made && (
        <div className="card" data-testid="agent-made">
          <h2>{made.name}: copy the key now</h2>
          <p className="small muted">This is the only time it is shown. We keep only a hash of it.</p>
          <div className="addr" data-testid="agent-key">
            {made.key}
          </div>
          <p className="small">MCP settings for the agent (Claude, IronClaw or any MCP client). The payer is a NEAR account of the agent&rsquo;s that holds a little USDC:</p>
          <pre className="addr code" data-testid="agent-config">
            {config}
          </pre>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(config);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy settings"}
          </button>
        </div>
      )}
      <NewKey
        onMade={(k) => {
          setMade(k);
          setCopied(false);
          void load();
        }}
      />
      {keys?.keys.map((k) => (
        <div className="card" key={k.id} data-testid="agent-key-row">
          <div className="poshead">
            <h2>{k.name}</h2>
            <span className={`badge${k.revoked ? " bad" : " ok"}`}>{k.revoked ? "Revoked" : "Active"}</span>
          </div>
          <Facts
            rows={[
              ["Largest size", `$${k.maxNotionalUsd}`],
              ["Markets", k.coins.join(", ")],
              ["Opens per day", String(k.dailyOpens)],
              ["Calls", `${k.calls} (${k.paidCalls} paid)`],
            ]}
          />
          {k.recent.length > 0 && (
            <ul className="plain small" data-testid="agent-calls">
              {k.recent.map((c, i) => (
                <li key={i}>
                  <span className="muted">{time(c.ms)}</span> {c.op}: {c.result === "ok" ? "done" : c.result}
                  {c.paidTx && (
                    <>
                      {" · "}
                      <a href={nearTx(c.paidTx)} target="_blank" rel="noopener noreferrer">
                        payment
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!k.revoked && (
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await api.revokeAgent(k.id);
                  await load();
                } catch (e) {
                  setError(sentence(e));
                }
              }}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
    </>
  );
}

export default function AgentsPage() {
  return (
    <Screen title="AI agents">
      <SignedIn>{() => <Agents />}</SignedIn>
    </Screen>
  );
}
