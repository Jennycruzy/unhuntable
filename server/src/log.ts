// Logging with redaction. Fields with secret names are replaced, and any value that
// looks like a wallet API key (wk_...) or a 64-hex key is replaced, at any depth.
import pino, { type DestinationStream, type Logger } from "pino";

export const REDACTED = "[redacted]";

/** Field names whose values are never logged (compared without case). */
export const SECRET_FIELDS = new Set(
  [
    "apiKey",
    "paymentKey",
    "authorization",
    "key",
    "secret",
    "signature",
    "stop",
    "trigger",
    "box",
    "walletKeys",
    "cookie",
    "set-cookie",
    "x-payment-key",
  ].map((s) => s.toLowerCase()),
);

const SECRET_VALUES = /wk_[0-9a-f]{16,}|\b(?:0x)?[0-9a-fA-F]{64}\b/g;

export function scrubString(s: string): string {
  return s.replace(SECRET_VALUES, REDACTED);
}

/** Copy of a value with secret fields and secret-looking strings replaced. */
export function scrub(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: scrubString(value.message) };
    if (value.stack) out.stack = scrubString(value.stack);
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.has(k.toLowerCase()) ? REDACTED : scrub(v, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, seen));
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return scrub((value as { toJSON(): unknown }).toJSON(), seen);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.has(k.toLowerCase()) ? REDACTED : scrub(v, seen);
  return out;
}

/** A pino destination that scrubs every finished line before writing it on. */
export function scrubbingStream(dest: { write(s: string): unknown }): DestinationStream {
  return {
    write(line: string) {
      let out: string;
      try {
        out = JSON.stringify(scrub(JSON.parse(line)));
      } catch {
        out = JSON.stringify({ msg: scrubString(line.trim()) });
      }
      dest.write(out + "\n");
    },
  };
}

/**
 * Scrubbing happens on the finished JSON line, after pino's serializers, so it also
 * covers messages, child bindings and anything fastify adds.
 */
export function createLogger(opts: { level?: string; destination?: { write(s: string): unknown } } = {}): Logger {
  return pino({ level: opts.level ?? process.env.LOG_LEVEL ?? "info" }, scrubbingStream(opts.destination ?? pino.destination(1)));
}
