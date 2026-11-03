import { describe, expect, it } from "vitest";
import { Api } from "../lib/api";
import { HomeFlow, stepWords, type RelockStore } from "../lib/home";
import type { PolicyBatch } from "../lib/types";
import { scriptedFetch, testWallet } from "./helpers";

const batch = (m: string): PolicyBatch => ({
  summary: [m],
  transactions: [{ receiverId: "outlayer.near", actions: [{ type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { m }, gas: "1", deposit: "0" } }] }],
});

function memoryRelock(): RelockStore & { value?: string } {
  const s: RelockStore & { value?: string } = {
    get: () => s.value,
    set: (v) => void (s.value = v),
    clear: () => void (s.value = undefined),
  };
  return s;
}

describe("go home", () => {
  it("asks for exactly two approvals, and the relock banner stays until the relock is confirmed", async () => {
    const { fetch, sent } = scriptedFetch([
      ["POST /api/home", { body: { homeId: "h1", feeUsd: "2.40", unlockBatch: batch("unlock") } }],
      ["POST /api/policy/confirm", { body: { ok: true, locked: [], unlocked: ["piece:0"] } }],
      ["GET /api/home/h1", { body: { homeId: "h1", state: "moving", steps: [], relockBatch: null } }],
      ["GET /api/home/h1", { body: { homeId: "h1", state: "relock_wait", steps: [], relockBatch: batch("lock") } }],
      ["POST /api/policy/confirm", { status: 503, body: { error: "near_unreachable", message: "We couldn't reach NEAR to check your key. Try again in a moment." } }],
      ["POST /api/policy/confirm", { body: { ok: true, locked: ["piece:0"], unlocked: [] } }],
    ]);
    const { wallet, calls } = testWallet();
    const relock = memoryRelock();
    const flow = new HomeFlow(new Api(fetch, ""), wallet, relock);
    const start = await flow.start();
    expect(relock.value).toBeUndefined();
    await flow.approveUnlock(start);
    expect(relock.value).toBe("h1");
    expect((await flow.poll("h1")).relockBatch).toBeNull();
    expect(relock.value).toBe("h1");
    const s = await flow.poll("h1");
    await expect(flow.approveRelock(s)).rejects.toThrow("We couldn't reach NEAR");
    expect(relock.value).toBe("h1");
    await flow.approveRelock(s);
    expect(relock.value).toBeUndefined();

    const approvals = calls.filter((c) => c.kind.startsWith("signAndSend"));
    // two approvals asked of the user; the retry after the server failed is the second one again
    expect(approvals.map((c) => (c.arg as PolicyBatch["transactions"])[0].actions[0].params!.args)).toEqual([{ m: "unlock" }, { m: "lock" }, { m: "lock" }]);
    const confirms = sent.filter((r) => r.url.endsWith("/api/policy/confirm")).map((r) => JSON.parse(r.body));
    expect(confirms[0]).toEqual({ homeId: "h1", txHashes: ["hash1"] });
    expect(confirms[2]).toEqual({ homeId: "h1", txHashes: ["hash3"] });
  });

  it("says each step in plain words", () => {
    expect(stepWords({ label: "piece:0", step: "to_spot", status: "done" })).toBe("piece:0: Moving money to spot (done)");
  });
});
