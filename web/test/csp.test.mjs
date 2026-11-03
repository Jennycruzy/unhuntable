import { describe, expect, it } from "vitest";
import { connectOrigins, isOtherOrigin, policy, scriptsIn } from "../scripts/csp.mjs";

describe("content security policy", () => {
  it("allows scripts only from our origin plus the inline hashes", () => {
    const p = policy(["sha256-abc="], { NEXT_PUBLIC_API_URL: "https://api.unhuntable.example/v" });
    expect(p).toContain("default-src 'self'");
    expect(p).toContain("script-src 'self' 'sha256-abc='");
    expect(p).not.toContain("unsafe");
    expect(p).toContain("connect-src 'self' https://api.unhuntable.example https://rpc.mainnet.near.org");
    expect(connectOrigins({ NEXT_PUBLIC_NEAR_NETWORK: "testnet" })).toContain("https://rpc.testnet.near.org");
  });

  it("finds scripts from another origin", () => {
    const html = '<script src="/_next/a.js"></script><script>self.x=1</script><script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script>';
    const s = scriptsIn(html);
    expect(s).toHaveLength(4);
    expect(s[1].body).toBe("self.x=1");
    expect(s.filter((x) => x.src !== undefined && isOtherOrigin(x.src)).map((x) => x.src)).toEqual(["https://cdn.example/x.js", "//cdn.example/y.js"]);
  });
});
