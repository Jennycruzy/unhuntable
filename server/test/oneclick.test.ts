import { describe, expect, it } from "vitest";
import { OneClick } from "../src/oneclick.js";

function recorder(reply: unknown) {
  const seen: { url: string; headers: Record<string, string>; method: string }[] = [];
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(u), headers: (init.headers ?? {}) as Record<string, string>, method: init.method ?? "GET" });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { f, seen };
}

const QUOTE = { quote: { depositAddress: "0x" + "44".repeat(20), amountIn: "1", amountOut: "1", amountInFormatted: "1", amountOutFormatted: "1", amountOutUsd: "1", minAmountOut: "1", timeEstimate: 30 } };

describe("deposit quotes and status", () => {
  it("Aurora's Swap API takes the key in the path and no Bearer header", async () => {
    const r = recorder(QUOTE);
    const c = new OneClick("https://intents-api.aurora.dev/", "key-1", r.f);
    await c.quote({} as never);
    const s = recorder({ status: "SUCCESS" });
    expect(await new OneClick("https://intents-api.aurora.dev", "key-1", s.f).status("0xabc")).toBe("SUCCESS");
    expect(r.seen[0].url).toBe("https://intents-api.aurora.dev/api/quote/key-1");
    expect(r.seen[0].headers).not.toHaveProperty("Authorization");
    expect(s.seen[0].url).toBe("https://intents-api.aurora.dev/api/status/key-1?depositAddress=0xabc");
  });

  it("1Click itself takes the key as a Bearer token", async () => {
    const r = recorder(QUOTE);
    await new OneClick("https://1click.chaindefuser.com", "key-2", r.f).quote({} as never);
    expect(r.seen[0].url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(r.seen[0].headers.Authorization).toBe("Bearer key-2");
  });
});
