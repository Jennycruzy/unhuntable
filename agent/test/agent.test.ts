import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { boxOpen, boxPublic, CALL_AAD } from "unhuntable-client";
import { describe, expect, it } from "vitest";
import { AgentApi, stopBoxes, type AgentPosition } from "../src/api.js";
import { buildServer } from "../src/mcp.js";

const GUARD_SECRET = Buffer.alloc(32, 0x33);
const GUARD_PUB = boxPublic(GUARD_SECRET);
const KEY = "uak_" + "ab".repeat(32);
const POS_ID = "11111111-2222-4333-8444-555555555555";
const STOP = 2987.65;

const position = (over: Partial<AgentPosition> = {}): AgentPosition => ({
  id: POS_ID,
  coin: "ETH",
  side: "long",
  notionalUsd: 30,
  leverage: 3,
  state: "open",
  pieces: [
    { shard: "0123456789abcdef", size: 0.006, liqDistance: 0.24, hasStop: false, hasTp: false, guard: "ok" },
    { shard: "fedcba9876543210", size: 0.006, liqDistance: 0.25, hasStop: true, hasTp: false, guard: "ok" },
  ],
  ...over,
});

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** The Unhuntable agent API as a fake: answers by path, records every request. */
function fakeApi() {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const s: Seen = { method: init?.method ?? "GET", url: u.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const paid = { paid: { tx: `tx${seen.length}`, price: "0.002" } };
    if (s.url === "/api/agent/box-pub") return json({ boxPub: GUARD_PUB });
    if (s.url === "/api/agent/positions" && s.method === "GET") return json({ positions: [position()], ...paid });
    if (s.url === "/api/agent/positions" && s.method === "POST") {
      if (s.body.notionalUsd > 100) return json({ error: "agent_limit", message: "This agent key does not allow that: its largest size is $100." }, 403);
      return json({ positionId: POS_ID, state: "funding", ...paid });
    }
    if (s.url.endsWith("/stop")) return json({ ok: true, sealed: s.body.boxes.length, ...paid });
    if (s.url.endsWith("/close")) return json({ ok: true, state: "closing", ...paid });
    return json({ error: "not_found", message: "There is nothing here." }, 404);
  }) as typeof fetch;
  return { f, seen };
}

async function connect() {
  const api = fakeApi();
  const server = buildServer(new AgentApi("https://unhuntable.test/", KEY, api.f, api.f));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  return { client, call, seen: api.seen };
}

describe("sealing a stop on the agent's machine", () => {
  it("makes one box per piece that only the guard opens, with the piece's size", () => {
    const boxes = stopBoxes(GUARD_PUB, position(), STOP, 20);
    expect(boxes.map((b) => b.shard)).toEqual(["0123456789abcdef", "fedcba9876543210"]);
    for (const b of boxes) {
      expect(JSON.stringify(b)).not.toContain("2987");
      const inner = JSON.parse(boxOpen(GUARD_SECRET, b.box, CALL_AAD).toString("utf8"));
      expect(inner).toMatchObject({ op: "seal", shard: b.shard, stop: { coin: "ETH", side: "long", trigger: STOP, size: 0.006 }, jitter_bps: 20 });
    }
  });

  it("refuses a bad price, a bad tolerance and a position that is not open", () => {
    expect(() => stopBoxes(GUARD_PUB, position(), 0)).toThrow(/positive/);
    expect(() => stopBoxes(GUARD_PUB, position(), STOP, 101)).toThrow(/basis points/);
    expect(() => stopBoxes(GUARD_PUB, position({ state: "funding" }), STOP)).toThrow(/once it is open/);
  });
});

describe("the MCP server", () => {
  it("lists four tools, none of which reads a stop back", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["unhuntable_close", "unhuntable_open", "unhuntable_set_stop", "unhuntable_status"]);
  });

  it("opens, seals, reads status and closes with the agent key; the stop never comes back out", async () => {
    const { call, seen } = await connect();
    const opened = await call("unhuntable_open", { coin: "ETH", side: "long", sizeUsd: 30, leverage: 3 });
    expect(opened).toEqual({ text: `Opening position ${POS_ID} (long $30 ETH). State: funding. Paid 0.002 USDC on NEAR (tx tx1).`, isError: false });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/agent/positions", body: { coin: "ETH", side: "long", notionalUsd: 30, leverage: 3, hiding: "normal" } });
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);

    const sealed = await call("unhuntable_set_stop", { positionId: POS_ID, stopPrice: STOP });
    expect(sealed.text).toBe("Stop sealed for 2 pieces. It is not on Hyperliquid's book and cannot be read back. Paid 0.002 USDC on NEAR (tx tx4).");
    const sent = seen.find((s) => s.url.endsWith("/stop"))!;
    // what left the machine: shard ids and sealed boxes, never the price
    expect(JSON.stringify(sent.body)).not.toContain("2987");
    expect(sent.body.boxes).toHaveLength(2);

    const status = await call("unhuntable_status");
    expect(status.text).toContain(`${POS_ID}: long $30 ETH at 3x, open, 2 pieces (piece 1: liquidation 24.0% away; piece 2: liquidation 25.0% away). Sealed stop on 1 of 2.`);
    const closed = await call("unhuntable_close", { positionId: POS_ID, now: true });
    expect(closed.text).toContain("State: closing.");
    expect(seen.find((s) => s.url.endsWith("/close"))!.body).toEqual({ now: true });

    // no tool answer anywhere holds the level
    for (const t of [opened, sealed, status, closed]) expect(t.text).not.toContain("2987");
  });

  it("passes the server's refusal on in its own words", async () => {
    const { call } = await connect();
    expect(await call("unhuntable_open", { coin: "ETH", side: "long", sizeUsd: 500, leverage: 3 })).toEqual({
      text: "This agent key does not allow that: its largest size is $100.",
      isError: true,
    });
  });

  it("refuses a key that is not an agent key before any call", () => {
    expect(() => new AgentApi("https://unhuntable.test", "sk-123", fetch)).toThrow(/uak_/);
  });
});
