import { describe, expect, it } from "vitest";
import { mcpConfig, nearTx } from "../lib/agents";

describe("agent settings", () => {
  it("are MCP settings that run the repo's MCP server with the agent's own key", () => {
    const key = "uak_" + "c3".repeat(32);
    const c = JSON.parse(mcpConfig(key));
    expect(c.mcpServers.unhuntable).toEqual({
      command: "node",
      args: ["unhuntable/agent/dist/mcp.js"],
      env: {
        UNHUNTABLE_URL: "https://tryunhuntable.site",
        UNHUNTABLE_AGENT_KEY: key,
        NEAR_PAYER_ACCOUNT_ID: "<the agent's NEAR account>",
        NEAR_PAYER_SECRET_KEY: "<its full-access key, ed25519:...>",
      },
    });
  });

  it("link a payment to the public NEAR explorer", () => {
    expect(nearTx("8LzpGyN9")).toBe("https://nearblocks.io/txns/8LzpGyN9");
  });
});
