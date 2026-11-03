import { boxPublic } from "../src/box.js";

/** Throwaway guard box secret, the same one the guard's reference vectors use. */
export const GUARD_SECRET = Buffer.alloc(32, 0x33);
export const GUARD_PUB = boxPublic(GUARD_SECRET);
export const PAYMENT_KEY = "11".repeat(32);

export interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetch that records each request and answers from a list, in order. No network. */
export function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const a = answers.shift();
    if (!a) throw new Error("unexpected request");
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return new Response(text, { status: a.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, sent };
}

/** Random source that hands out fixed buffers in order. */
export function fixedRandom(chunks: Buffer[]) {
  return (n: number) => {
    const c = chunks.shift();
    if (!c || c.length !== n) throw new Error(`fixed random: wanted ${n} bytes`);
    return c;
  };
}
