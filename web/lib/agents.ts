// Words and settings for the Agents screen.

/** The MCP server settings an agent pastes into its client. The payer fields are the agent's own. */
export function mcpConfig(key: string, url = "https://tryunhuntable.site"): string {
  return JSON.stringify(
    {
      mcpServers: {
        unhuntable: {
          command: "node",
          args: ["unhuntable/agent/dist/mcp.js"],
          env: {
            UNHUNTABLE_URL: url,
            UNHUNTABLE_AGENT_KEY: key,
            NEAR_PAYER_ACCOUNT_ID: "<the agent's NEAR account>",
            NEAR_PAYER_SECRET_KEY: "<its full-access key, ed25519:...>",
          },
        },
      },
    },
    null,
    2,
  );
}

/** A NEAR transaction on the public explorer. */
export function nearTx(hash: string): string {
  return `https://nearblocks.io/txns/${encodeURIComponent(hash)}`;
}
