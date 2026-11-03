// One HTTPS call to a guard project on OutLayer.

export const OUTLAYER_URL = "https://api.outlayer.ai";

/** The guard ran and answered with {"error": ...}. */
export class GuardError extends Error {
  constructor(message: string, readonly output: unknown) {
    super(message);
    this.name = "GuardError";
  }
}

/** OutLayer answered with a bad HTTP status or a body that is not a guard answer. */
export class OutLayerError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = "OutLayerError";
  }
}

export interface CallOptions {
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces https://api.outlayer.ai. */
  baseUrl?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * POST {"input": input} to {baseUrl}/call/{owner}/{project} with header X-Payment-Key,
 * and return the answer's "output" field.
 */
export async function callGuard(
  owner: string,
  project: string,
  paymentKey: string,
  input: unknown,
  opts: CallOptions = {},
): Promise<Record<string, unknown>> {
  if (!owner || !project) throw new TypeError("owner and project are required");
  if (!paymentKey) throw new TypeError("payment key is required");
  const f = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseUrl ?? OUTLAYER_URL).replace(/\/+$/, "");
  const url = `${base}/call/${encodeURIComponent(owner)}/${encodeURIComponent(project)}`;
  const res = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey },
    body: JSON.stringify({ input }),
  });
  const body = await res.text();
  if (!res.ok) throw new OutLayerError(`OutLayer answered HTTP ${res.status}`, res.status, body);
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new OutLayerError("OutLayer answer is not JSON", res.status, body);
  }
  if (!isObject(answer) || !("output" in answer)) {
    throw new OutLayerError("OutLayer answer has no output", res.status, body);
  }
  let output = answer.output;
  // The guard writes its output as a JSON string; OutLayer may pass it on as text or parsed.
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      throw new OutLayerError("guard output is not JSON", res.status, body);
    }
  }
  if (!isObject(output)) throw new OutLayerError("guard output is not a JSON object", res.status, body);
  if ("error" in output) throw new GuardError(String(output.error), output);
  return output;
}
