#!/usr/bin/env node
// MCP server (stdio) for an AI agent that trades through Unhuntable.
//
// Settings, from the environment:
//   UNHUNTABLE_AGENT_KEY    the uak_ key the owner made on the Agents screen (required)
//   NEAR_PAYER_ACCOUNT_ID   NEAR account that pays each call in USDC (required)
//   NEAR_PAYER_SECRET_KEY   its full-access key, ed25519:... (required; stays on this machine)
//   UNHUNTABLE_URL          default https://tryunhuntable.site
//   NEAR_NETWORK            near:mainnet (default) or near:testnet
//   NEAR_RPC_URL            optional RPC for the payer
//
// The tools never return a stop level. A stop is sealed on this machine into boxes only
// the guard can open, and no tool can read it back, so a prompt that tries to get the
// stop out of the agent finds nothing to give.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNearPaymentFetch } from "@fastnear/x402";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { homedir } from "node:os";
import { join } from "node:path";
import { NEAR_USDC, createPingPaymentFetch, fileProofs, nearTokenDeposit } from "./pingpay.js";
import { z } from "zod";
import { AgentApi, AgentApiError } from "./api.js";
import { describeStatus } from "./words.js";

export function buildServer(api: AgentApi): McpServer {
  const server = new McpServer({ name: "unhuntable", version: "1.0.0" });
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (e: unknown) => ({
    content: [{ type: "text" as const, text: e instanceof AgentApiError || e instanceof Error ? e.message : "The call failed." }],
    isError: true,
  });
  const paidNote = (p?: { tx: string; price: string }) => (p ? ` Paid ${p.price} USDC on NEAR (tx ${p.tx}).` : "");

  server.registerTool(
    "unhuntable_status",
    {
      title: "Positions",
      description: "This agent's Unhuntable positions: market, side, size, state, and for each piece its distance to liquidation and whether a stop is set. Stop levels are never shown. Costs one paid call.",
    },
    async () => {
      try {
        const r = await api.status();
        return text(describeStatus(r.positions) + paidNote(r.paid));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "unhuntable_open",
    {
      title: "Open a position",
      description:
        "Open a perp position on Hyperliquid through Unhuntable, on pieces the owner already set up. normal = one piece; whale = split across several accounts nobody can link. Crypto only (BTC, ETH, SOL), within this agent's limits. It opens within a few minutes; check with unhuntable_status, then seal a stop with unhuntable_set_stop. Costs one paid call.",
      inputSchema: {
        coin: z.enum(["BTC", "ETH", "SOL"]),
        side: z.enum(["long", "short"]),
        sizeUsd: z.number().positive().describe("Position size in US dollars"),
        leverage: z.number().int().min(1).max(10),
        hiding: z.enum(["normal", "whale"]).default("normal"),
      },
    },
    async (a) => {
      try {
        const r = await api.open({ coin: a.coin, side: a.side, notionalUsd: a.sizeUsd, leverage: a.leverage, hiding: a.hiding });
        return text(`Opening position ${r.positionId} (${a.side} $${a.sizeUsd} ${a.coin}). State: ${r.state}.` + paidNote(r.paid));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "unhuntable_set_stop",
    {
      title: "Seal a stop",
      description:
        "Seal a stop-loss for an open position. The price is sealed on this machine into a box only the guard (an OutLayer TEE) can open; it is never placed on Hyperliquid's book and no tool can read it back. Costs two paid calls (status, then the seal).",
      inputSchema: {
        positionId: z.string().uuid(),
        stopPrice: z.number().positive(),
      },
    },
    async (a) => {
      try {
        const r = await api.setStop(a.positionId, a.stopPrice);
        return text(`Stop sealed for ${r.sealed} ${r.sealed === 1 ? "piece" : "pieces"}. It is not on Hyperliquid's book and cannot be read back.` + paidNote(r.paid));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "unhuntable_close",
    {
      title: "Close a position",
      description: "Close one of this agent's positions. Pieces close at spread-out times within 90 seconds, or at once with now. Costs one paid call.",
      inputSchema: { positionId: z.string().uuid(), now: z.boolean().default(false) },
    },
    async (a) => {
      try {
        const r = await api.close(a.positionId, a.now);
        return text(`Closing position ${a.positionId}. State: ${r.state}.` + paidNote(r.paid));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

async function main(): Promise<void> {
  const network = (process.env.NEAR_NETWORK ?? "near:mainnet") as "near:mainnet" | "near:testnet";
  if (network !== "near:mainnet" && network !== "near:testnet") throw new Error("NEAR_NETWORK must be near:mainnet or near:testnet.");
  const signer = createLocalNearSigner({
    accountId: need("NEAR_PAYER_ACCOUNT_ID"),
    secretKey: need("NEAR_PAYER_SECRET_KEY") as `ed25519:${string}`,
    ...(process.env.NEAR_RPC_URL ? { rpcUrls: { [network]: process.env.NEAR_RPC_URL } } : {}),
  });
  // UNHUNTABLE_PAY_WITH=pingpay pays each call through PingPay Agent Pay (0.2 USDC, settled
  // through NEAR Intents) with the payer's own token on NEAR; the default is a USDC transfer.
  const payWith = process.env.UNHUNTABLE_PAY_WITH ?? "near";
  if (payWith !== "near" && payWith !== "pingpay") throw new Error("UNHUNTABLE_PAY_WITH must be near or pingpay.");
  const paidFetch =
    payWith === "pingpay"
      ? createPingPaymentFetch({
          accountId: need("NEAR_PAYER_ACCOUNT_ID"),
          token: process.env.PINGPAY_TOKEN ?? NEAR_USDC,
          deposit: nearTokenDeposit(process.env.NEAR_RPC_URL ?? "https://free.rpc.fastnear.com", need("NEAR_PAYER_ACCOUNT_ID"), need("NEAR_PAYER_SECRET_KEY")),
          // a payment still settling when a call ends is sent again by the next call, never paid twice
          proofs: fileProofs(join(process.env.UNHUNTABLE_STATE_DIR ?? join(homedir(), ".unhuntable-agent"), "pingpay-proofs.json")),
        })
      : (createNearPaymentFetch({ signer, network }) as typeof fetch);
  const api = new AgentApi(process.env.UNHUNTABLE_URL ?? "https://tryunhuntable.site", need("UNHUNTABLE_AGENT_KEY"), paidFetch);
  await buildServer(api).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    // never print the payer key; the message names only what is missing or wrong
    console.error(e instanceof Error ? e.message : "unhuntable-mcp failed to start");
    process.exit(1);
  });
}
