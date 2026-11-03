// Runs after `next build`. For every exported page it:
//  - fails the build if a page loads a script from another origin,
//  - adds a strict Content-Security-Policy <meta> as the first thing in <head>, allowing only
//    our own scripts plus a sha256 hash of each inline script Next.js writes into that page.
// It also copies the exit tool (../exit) to /exit/ so "Leave without us" is served from our origin.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(web, "out");

/** Origins the browser may connect to besides our own; README.md says why each is here. */
export function connectOrigins(env = process.env) {
  const testnet = env.NEXT_PUBLIC_NEAR_NETWORK === "testnet";
  const list = [];
  if (env.NEXT_PUBLIC_API_URL) list.push(new URL(env.NEXT_PUBLIC_API_URL).origin);
  list.push(
    testnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org",
    testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com",
    "https://mw.rpc.fastnear.com",
    "https://h4n.app",
    "https://api.outlayer.ai",
  );
  return [...new Set(list)];
}

export const FRAME_ORIGINS = ["https://hot-labs.org"];

export function policy(scriptHashes, env = process.env) {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.map((h) => `'${h}'`).join(" ")}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connectOrigins(env).join(" ")}`,
    `frame-src ${FRAME_ORIGINS.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

function htmlFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...htmlFiles(p));
    else if (name.endsWith(".html")) found.push(p);
  }
  return found;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Every script in a page: src for loaded ones, body for inline ones. */
export function scriptsIn(html) {
  const list = [];
  for (const m of html.matchAll(SCRIPT)) {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
    list.push(src ? { src: src[1] } : { body: m[2], attrs: m[1] });
  }
  return list;
}

export function isOtherOrigin(src) {
  return /^(https?:)?\/\//i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src);
}

function lockDown(file) {
  let html = readFileSync(file, "utf8");
  if (html.includes('http-equiv="Content-Security-Policy"')) throw new Error(`${file} already has a CSP`);
  const hashes = new Set();
  for (const s of scriptsIn(html)) {
    if (s.src !== undefined) {
      if (isOtherOrigin(s.src)) throw new Error(`${file} loads a script from another origin: ${s.src}`);
    } else if (!/type\s*=\s*["']?application\/(ld\+)?json/i.test(s.attrs)) {
      hashes.add("sha256-" + createHash("sha256").update(s.body, "utf8").digest("base64"));
    }
  }
  if (/<link\b[^>]*\bhref=["']?(https?:)?\/\//i.test(html)) throw new Error(`${file} links a file from another origin`);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy([...hashes])}">`;
  const at = html.search(/<head[^>]*>/i);
  if (at < 0) throw new Error(`${file} has no <head>`);
  const end = html.indexOf(">", at) + 1;
  html = html.slice(0, end) + meta + html.slice(end);
  writeFileSync(file, html);
}

function main() {
  const files = htmlFiles(out);
  for (const f of files) lockDown(f);
  const exit = join(web, "..", "exit");
  mkdirSync(join(out, "exit"), { recursive: true });
  for (const f of ["index.html", "exit.js"]) copyFileSync(join(exit, f), join(out, "exit", f));
  console.log(`csp: locked down ${files.length} pages; exit tool copied to /exit/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
