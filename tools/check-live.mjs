#!/usr/bin/env node
// Checks Unhuntable's live claims against public data and prints PASS or FAIL for each.
// Reads only: NEAR's archival RPC, Hyperliquid's public explorer API, OutLayer's public file
// store, and the live site's public API. No account, no key, no money, no install.
// Run from the repo root: node tools/check-live.mjs
import { createHash } from "node:crypto";

const NEAR_RPCS = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];
const HL_EXPLORER = "https://rpc.hyperliquid.xyz/explorer";
const SITE = "https://tryunhuntable.site";
const RELAY = "4399fffd59abe3f29284d29936bf83d41e1344e82c971394660217cf6e8046f7";
const GUARD_PROJECT = `${RELAY}/guard`;
const GUARD_HASH = "3dd11f022d41d4c1cc344057b660a51a5af47d95d9faa60f1992ddea428f18e9";
const NEAR_PIECE = "0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a";

let failed = 0;
const line = (ok, claim, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail ? `\n      ${detail}` : ""}`);
};

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

async function near(method, params) {
  let last;
  for (const url of NEAR_RPCS) {
    try {
      const j = await post(url, { jsonrpc: "2.0", id: 1, method, params });
      if (j.error) throw new Error(j.error.cause?.name ?? j.error.message);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function view(account, method, args) {
  const r = await near("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
}

async function nearTx(hash, sender) {
  const r = await near("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
  const failure = (r.receipts_outcome ?? []).find((o) => o.outcome?.status?.Failure);
  return { ok: "SuccessValue" in (r.status ?? {}) && !failure, receiver: r.transaction?.receiver_id, methods: (r.transaction?.actions ?? []).map((a) => a.FunctionCall?.method_name ?? Object.keys(a)[0]) };
}

async function hlTx(hash) {
  const j = await post(HL_EXPLORER, { type: "txDetails", hash });
  return j.tx;
}

async function site(path) {
  const r = await fetch(SITE + path, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

const checks = [
  async () => {
    const r = await near("query", { request_type: "view_code", finality: "final", account_id: "unhuntable.near" });
    line(r.code_base64?.length > 0, "The signer contract runs on NEAR mainnet as unhuntable.near", `code hash ${r.hash}`);
  },
  async () => {
    const t = await nearTx("86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd", RELAY);
    line(t.ok && t.receiver === "unhuntable.near", "NEAR's MPC network signed for a piece's Hyperliquid account with no private key (approve agent)", `https://nearblocks.io/txns/86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd  ${t.receiver}.${t.methods.join(",")}`);
  },
  async () => {
    const t = await nearTx("8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z", RELAY);
    line(t.ok && t.receiver === "unhuntable.near", "Chain Signatures moved a piece's USDC onto trade.xyz", `https://nearblocks.io/txns/8LzpGyN9kKpDwMmYKihG1MXXbgHFbs9H3E9Ci7w1jL6Z  ${t.receiver}.${t.methods.join(",")}`);
  },
  async () => {
    const t = await hlTx("0xdfdd58cd4df862ffe15704488de26802050700b2e8fb81d183a604200cfc3cea");
    const o = t?.action?.orders?.[0];
    line(!!o && t.error === null && t.user === NEAR_PIECE && o.b === false && !o.r, "The guard opened an NVDA short on trade.xyz from the NEAR-controlled piece", `user ${t?.user}, sell ${o?.s} at ${o?.p}, error ${t?.error}`);
  },
  async () => {
    const t = await hlTx("0xe3658df9d0c075c3e4df04488de8bc02021800df6bc39495872e394c8fc44fae");
    const o = t?.action?.orders?.[0];
    line(!!o && t.error === null && t.user === NEAR_PIECE && o.r === true, "A sealed stop fired: a reduce-only close of that NVDA short, sent by the guard", `user ${t?.user}, reduce-only ${o?.r}, size ${o?.s}, error ${t?.error}`);
  },
  async () => {
    const t = await nearTx("6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c", RELAY);
    line(t.ok && t.receiver === "outlayer.near", "That guard tick ran on OutLayer's TEE through outlayer.near", `https://nearblocks.io/txns/6ewnHXXtwTjBvqdEqYdDkoVc3oE3ew2b6prZ5MAVCz4c  ${t.receiver}.${t.methods.join(",")}`);
  },
  async () => {
    const t = await nearTx("CALA24Gya1fLd8No2wzukUSM8cQ29eaBAUActpFLVGvc", RELAY);
    line(t.ok && t.receiver === "unhuntable.near", "Chain Signatures moved the piece's money back from trade.xyz", `https://nearblocks.io/txns/CALA24Gya1fLd8No2wzukUSM8cQ29eaBAUActpFLVGvc  ${t.receiver}.${t.methods.join(",")}`);
  },
  async () => {
    const t = await nearTx("7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD", RELAY);
    line(t.ok, "An AI agent paid for a call in USDC on NEAR with x402 (delegated transfer, relayed)", `https://nearblocks.io/txns/7VcZWHJzgrauZaY6irWh1BiHGcr7kDch92UG69MFvMBD  to ${t.receiver}`);
  },
  async () => {
    const t = await nearTx("GzuVd2giEu3VJ6LpeKHZfw7rFG8jatkpJbqJ5ZyACkP3", "intents.near");
    line(t.ok && t.receiver === "intents.near", "A PingPay agent payment settled to unhuntable.near through NEAR Intents", `https://nearblocks.io/txns/GzuVd2giEu3VJ6LpeKHZfw7rFG8jatkpJbqJ5ZyACkP3  ${t.receiver}.${t.methods.join(",")}`);
  },
  async () => {
    const p = await view("outlayer.near", "get_project", { project_id: GUARD_PROJECT });
    line(p.active_version === GUARD_HASH, "OutLayer runs the guard build named in this repo", `active version ${p.active_version}`);
  },
  async () => {
    const r = await fetch(`https://main.fastfs.io/${RELAY}/outlayer.near/${GUARD_HASH}.wasm`, { signal: AbortSignal.timeout(60_000) });
    const sha = createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex");
    line(sha === GUARD_HASH, "The guard file OutLayer runs hashes to that build", `sha256 ${sha}`);
  },
  async () => {
    const h = await site("/api/health");
    line(h.ok === true, "The live app answers", `${SITE} version ${h.version}`);
  },
  async () => {
    const j = await site("/api/judge");
    line(j.ready === true || j.busyUntilMs !== null, "A real trade can be opened at /judge with no wallet", `ready ${j.ready}, ${j.leftToday} left today, ${j.busyUntilMs ? "another trade running" : "none running"}`);
  },
  async () => {
    const m = (await site("/api/hunt-map")).map;
    const age = Math.round((Date.now() - m.asOfMs) / 60_000);
    line(age < 30 && m.positions > 0, "The Hunt Map is read live from Hyperliquid", `${m.positions} positions, read ${age} min ago; ${m.replays?.cameBack} of ${m.replays?.events} liquidations over $100K in ${m.replays?.days} days came straight back`);
  },
  async () => {
    const t = await site("/api/traders");
    line(t.traders.some((x) => x.handle === "jenny_trades"), "A trader sells copy and viewing keys on the live app", `traders: ${t.traders.map((x) => "@" + x.handle).join(", ")}`);
  },
];

console.log("Unhuntable: live claims checked against public data\n");
for (const c of checks) {
  try {
    await c();
  } catch (e) {
    line(false, c.toString().match(/"([^"]+)"/)?.[1] ?? "check", `could not read: ${e.message}`);
  }
}
console.log(`\n${checks.length - failed} of ${checks.length} passed.`);
process.exit(failed ? 1 : 0);
