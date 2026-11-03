import { describe, expect, it } from "vitest";
import { createLogger, scrub } from "../src/log.js";
import { logSink } from "./helpers.js";

const WK = "wk_" + "11".repeat(16);
const HEX = "22".repeat(32);

describe("log redaction", () => {
  it("drops every secret field and secret-looking value", () => {
    const sink = logSink();
    const log = createLogger({ destination: sink });
    const secretValues = {
      apiKey: "value-apikey-1",
      paymentKey: "value-paymentkey-2",
      authorization: "Bearer value-auth-3",
      key: "value-key-4",
      secret: "value-secret-5",
      signature: "value-signature-6",
      stop: { trigger: 2100.5, size: 0.0045 },
      trigger: 1987.25,
      box: { epk: "value-epk-7", ct: "value-ct-8" },
    };
    log.info({ ...secretValues, nested: { deeper: [{ APIKEY: "value-upper-9", note: `key is ${WK}` }] }, hash: `0x${HEX}` }, `sent ${WK} with ${HEX}`);
    log.child({ paymentKey: "value-child-10" }).warn({ headers: { Authorization: "Bearer value-header-11" } }, "child");
    log.error(new Error(`failed with ${WK}`));
    const out = sink.text();
    for (const v of [
      "value-apikey-1",
      "value-paymentkey-2",
      "value-auth-3",
      "value-key-4",
      "value-secret-5",
      "value-signature-6",
      "2100.5",
      "0.0045",
      "1987.25",
      "value-epk-7",
      "value-ct-8",
      "value-upper-9",
      "value-child-10",
      "value-header-11",
      WK,
      HEX,
    ]) {
      expect(out).not.toContain(v);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain("child");
    expect(sink.lines).toHaveLength(3);
    for (const l of sink.lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("keeps ordinary values", () => {
    expect(scrub({ coin: "ETH", shard: "0123456789abcdef", n: 3, ok: true, none: null })).toEqual({
      coin: "ETH",
      shard: "0123456789abcdef",
      n: 3,
      ok: true,
      none: null,
    });
  });

  it("handles cycles", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(scrub(a)).toEqual({ x: 1, self: "[circular]" });
  });
});
