import { describe, expect, it } from "vitest";
import { Api } from "../lib/api";
import { approveKey, buyKey, checkCopySize, copyShape, recordFile } from "../lib/follow";
import type { AppWallet } from "../lib/wallet";

const BATCH = { summary: ["Update your private balance… It may also pay @alice_trades"], transactions: [{ receiverId: "outlayer.near", actions: [] }] };

function fake() {
  const sent: { method: string; url: string; body: string | undefined }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(url), body: init?.body as string | undefined });
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/api/follow")) return json({ keyId: "k1", state: "pending", policyBatch: BATCH });
    if (u.endsWith("/api/follow/k1/batch")) return json({ policyBatch: BATCH });
    if (u.endsWith("/api/follow/k1/confirm")) return json({ ok: true, keyId: "k1", state: "active" });
    return new Response(JSON.stringify({ error: "not_found", message: "no" }), { status: 404 });
  }) as typeof fetch;
  const signed: unknown[] = [];
  const wallet = { signAndSendTransactions: async (t: unknown) => (signed.push(t), ["tx1"]) } as unknown as AppWallet;
  return { api: new Api(f, ""), sent, signed, wallet };
}

describe("buying a key", () => {
  it("asks for the key, has the wallet sign the server's batch unchanged, then switches it on", async () => {
    const x = fake();
    expect(await buyKey(x.api, x.wallet, { handle: "alice_trades", kind: "copy", copyUsd: 30 })).toEqual({ ok: true, keyId: "k1", state: "active" });
    expect(x.signed).toEqual([BATCH.transactions]);
    expect(x.sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/follow", "POST /api/follow/k1/confirm"]);
    expect(JSON.parse(x.sent[0].body!)).toEqual({ handle: "alice_trades", kind: "copy", copyUsd: 30 });
  });

  it("a key an agent asked for is approved the same way", async () => {
    const x = fake();
    await approveKey(x.api, x.wallet, "k1");
    expect(x.sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/follow/k1/batch", "POST /api/follow/k1/confirm"]);
    expect(x.signed).toHaveLength(1);
  });

  it("checks the copy size and says how it is placed", () => {
    expect(checkCopySize("14.99")).toBe("A copy is at least $15.");
    expect(checkCopySize("abc")).toBe("A copy is at least $15.");
    expect(checkCopySize("15")).toBeUndefined();
    expect(checkCopySize("5001")).toBe("A copy is at most $5,000.");
    expect(copyShape(15)).toBe("in one of your pieces");
    expect(copyShape(30)).toBe("split across several of your pieces");
  });

  it("writes the signed record the way the verify tool reads it", () => {
    const r = { trader: "ab".repeat(32), shards: 6, equityUsd: 0, netDepositsUsd: -2.1, pnlUsd: 2.1, outlayerCall: "c", asOfMs: 5, eas: { signer: "0x1" } };
    expect(JSON.parse(recordFile(r))).toEqual({ output: { eas: { signer: "0x1" }, totals: { trader: "ab".repeat(32), shards: 6, equityUsd: 0, netDepositsUsd: -2.1, pnlUsd: 2.1, outlayerCall: "c" } } });
  });
});
