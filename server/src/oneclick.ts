// Aurora Swap API (NEAR Intents 1Click): quotes and status. POST /v0/quote and
// GET /v0/status?depositAddress=..., with our API key as a Bearer token.
// Shapes follow the 1Click models (QuoteRequest, QuoteResponse, GetExecutionStatusResponse).

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  deadline: string;
  confidentiality?: "public" | "basic" | "advanced";
  appFees?: { recipient: string; fee: number }[];
}

export interface Quote {
  depositAddress: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeEstimate: number;
}

export type OneClickStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export class OneClick {
  private readonly f: typeof fetch;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    f?: typeof fetch,
  ) {
    this.f = f ?? ((...a) => fetch(...a));
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.apiKey) throw new OneClickError("No Aurora API key is set.", 0);
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new OneClickError("Aurora did not answer.", 0);
    }
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new OneClickError(`Aurora answered HTTP ${res.status} with a body that is not JSON.`, res.status);
    }
    if (!res.ok) throw new OneClickError(typeof j?.message === "string" ? j.message : `Aurora answered HTTP ${res.status}.`, res.status);
    return j;
  }

  async quote(q: QuoteRequest): Promise<{ quote: Quote; raw: unknown }> {
    const j = await this.req("POST", "/v0/quote", q);
    const quote = j?.quote;
    if (!quote || typeof quote.depositAddress !== "string" || typeof quote.amountIn !== "string" || typeof quote.amountOut !== "string") {
      throw new OneClickError("Aurora's quote is not in the shape we expect.", 200);
    }
    return { quote, raw: j };
  }

  async status(depositAddress: string): Promise<OneClickStatus> {
    const j = await this.req("GET", `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
    if (typeof j?.status !== "string") throw new OneClickError("Aurora's status is not in the shape we expect.", 200);
    return j.status as OneClickStatus;
  }
}
