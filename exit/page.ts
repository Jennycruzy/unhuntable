// The static exit page. Bundled into exit.js with esbuild (npm run build).
// Nothing here is sent anywhere except signatures to OutLayer, orders to Hyperliquid
// and a key check to the NEAR RPC. The words stay in this page.
import { ExitStopped, runExit, type ExitIO } from "../client/src/exit.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function line(text: string, kind: "say" | "ask" | "error" | "done" = "say") {
  const p = document.createElement("p");
  p.className = kind;
  p.textContent = text;
  $("log").appendChild(p);
  p.scrollIntoView({ block: "nearest" });
}

const io: ExitIO = {
  say: (m) => line(m),
  ask: (q) =>
    new Promise((resolve) => {
      line(q, "ask");
      const box = $<HTMLDivElement>("answer");
      const input = $<HTMLInputElement>("answer-text");
      box.hidden = false;
      input.value = "";
      input.focus();
      const done = (e: Event) => {
        e.preventDefault();
        box.hidden = true;
        $("answer-form").removeEventListener("submit", done);
        line(`> ${input.value || "(Enter)"}`);
        resolve(input.value);
      };
      $("answer-form").addEventListener("submit", done);
    }),
};

$("start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const words = $<HTMLTextAreaElement>("words");
  const start = $<HTMLButtonElement>("start");
  start.disabled = true;
  $("log").textContent = "";
  try {
    const r = await runExit({
      words: words.value,
      destination: { chain: $<HTMLSelectElement>("chain").value, to: $<HTMLInputElement>("to").value.trim() },
      serverKeyHashes: $<HTMLInputElement>("server-key").value.trim() ? [$<HTMLInputElement>("server-key").value.trim().toLowerCase()] : [],
      relay: $<HTMLInputElement>("relay-account").value.trim() && $<HTMLInputElement>("relay-key").value.trim()
        ? { account: $<HTMLInputElement>("relay-account").value.trim(), key: $<HTMLInputElement>("relay-key").value.trim() }
        : undefined,
      io,
    });
    line(r.withdrawal ? "Done. Your money is on its way home." : "Done.", "done");
  } catch (err) {
    line(err instanceof ExitStopped ? err.message : `Something went wrong: ${(err as Error).message}`, "error");
  } finally {
    // forget the words as soon as the run ends
    words.value = "";
    $<HTMLInputElement>("relay-key").value = "";
    start.disabled = false;
  }
});
