// NEAR RPC reads: is a key on an account, and view calls such as get_wallet_policy.
// fetch is injected so tests use stored replies only.

export class NearRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearRpcError";
  }
}

export class NearRpc {
  private readonly f: typeof fetch;
  constructor(
    private readonly url: string,
    f?: typeof fetch,
  ) {
    this.f = f ?? ((...a) => fetch(...a));
  }

  private async query(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    let res: Response;
    try {
      res = await this.f(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "unhuntable", method: "query", params: { finality: "final", ...params } }),
      });
    } catch {
      throw new NearRpcError("NEAR RPC did not answer.");
    }
    if (!res.ok) throw new NearRpcError(`NEAR RPC answered HTTP ${res.status}.`);
    let body: { result?: Record<string, unknown> & { error?: unknown }; error?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new NearRpcError("NEAR RPC answer is not JSON.");
    }
    // A missing key or account comes back as an error; that is an answer, not a failure.
    if (body.error || body.result?.error) return null;
    if (!body.result) throw new NearRpcError("NEAR RPC answer has no result.");
    return body.result;
  }

  /** The key's permission ("FullAccess" or a function-call object), or null when the key is not on the account. */
  async accessKey(accountId: string, publicKey: string): Promise<unknown | null> {
    const r = await this.query({ request_type: "view_access_key", account_id: accountId, public_key: publicKey });
    return r?.permission ?? null;
  }

  /** A view call; the answer bytes parsed as JSON. Null when the call failed on chain. */
  async view(contract: string, method: string, args: unknown): Promise<unknown> {
    const r = await this.query({
      request_type: "call_function",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (!r) return null;
    const bytes = r.result;
    if (!Array.isArray(bytes)) throw new NearRpcError("NEAR RPC view answer has no result bytes.");
    const text = Buffer.from(bytes as number[]).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new NearRpcError("NEAR RPC view answer is not JSON.");
    }
  }
}
