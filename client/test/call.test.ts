import { describe, expect, it } from "vitest";
import { GuardError, OutLayerError, callGuard } from "../src/call.js";
import { PAYMENT_KEY, fakeFetch } from "./helpers.js";

describe("callGuard", () => {
  it("posts the input with the payment key and returns output", async () => {
    const { fetch, sent } = fakeFetch([{ body: { output: { hl_address: "0xab" } } }]);
    const out = await callGuard("own", "guard", PAYMENT_KEY, { op: "addr" }, { fetch });
    expect(out).toEqual({ hl_address: "0xab" });
    expect(sent[0].url).toBe("https://api.outlayer.ai/call/own/guard");
    expect(sent[0].headers["x-payment-key"]).toBe(PAYMENT_KEY);
    expect(sent[0].headers["content-type"]).toBe("application/json");
    expect(sent[0].body).toEqual({ input: { op: "addr" } });
  });

  it("parses output given as a JSON string", async () => {
    const { fetch } = fakeFetch([{ body: { output: JSON.stringify({ sealed: true }) } }]);
    expect(await callGuard("o", "p", PAYMENT_KEY, {}, { fetch })).toEqual({ sealed: true });
  });

  it("throws GuardError when output has error", async () => {
    const { fetch } = fakeFetch([{ body: { output: { error: "bad stop" } } }]);
    const err = await callGuard("o", "p", PAYMENT_KEY, {}, { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardError);
    expect(err.message).toBe("bad stop");
  });

  it("throws OutLayerError on a bad HTTP status", async () => {
    const { fetch } = fakeFetch([{ status: 402, body: { error: "payment" } }]);
    const err = await callGuard("o", "p", PAYMENT_KEY, {}, { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(OutLayerError);
    expect(err.status).toBe(402);
  });

  it("throws OutLayerError on a malformed answer", async () => {
    for (const body of ["not json", { result: 1 }, { output: "not json" }, { output: [1] }, { output: null }]) {
      const { fetch } = fakeFetch([{ body }]);
      await expect(callGuard("o", "p", PAYMENT_KEY, {}, { fetch })).rejects.toBeInstanceOf(OutLayerError);
    }
  });

  it("needs owner, project and payment key", async () => {
    const { fetch, sent } = fakeFetch([]);
    await expect(callGuard("", "p", PAYMENT_KEY, {}, { fetch })).rejects.toThrow();
    await expect(callGuard("o", "p", "", {}, { fetch })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("uses another base URL when given", async () => {
    const { fetch, sent } = fakeFetch([{ body: { output: {} } }]);
    await callGuard("o", "p", PAYMENT_KEY, {}, { fetch, baseUrl: "http://localhost:1/" });
    expect(sent[0].url).toBe("http://localhost:1/call/o/p");
  });
});
