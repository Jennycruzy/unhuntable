// Exit without us, from a terminal:  npx tsx exit/cli.ts
// Asks for the 12 words, the NEAR account and a destination, then runs the same steps as
// the static page. The words are not echoed, not written to disk and not sent anywhere.
//
// Optional flags: --account <id> --chain <near|base|arbitrum> --to <address> --server-key-hash <hex>
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ExitStopped, runExit } from "../client/src/exit.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

let muted = false;
const out = new Writable({
  write(chunk, _enc, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY ?? false });

async function ask(question: string): Promise<string> {
  return (await rl.question(`${question} `)).trim();
}

async function askHidden(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  muted = true;
  try {
    return await rl.question("");
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

async function main(): Promise<number> {
  console.log("Exit without us: bring your money home with only your 12 words.");
  console.log("This talks only to OutLayer, Hyperliquid and a NEAR RPC. Your words stay on this computer.\n");
  const words = await askHidden("Your 12 words (not shown as you type):");
  const account = flag("account") ?? (await ask("Your NEAR account (for example alice.near):"));
  const chain = flag("chain") ?? ((await ask("Send to which chain? near, base or arbitrum [near]:")) || "near");
  const to = flag("to") ?? (await ask(`Your address on ${chain}:`));
  const serverKey = flag("server-key-hash");
  try {
    const r = await runExit({
      words,
      account,
      destination: { chain, to },
      serverKeyHashes: serverKey ? [serverKey.toLowerCase()] : [],
      io: { say: (m) => console.log(`- ${m}`), ask: (q) => ask(`? ${q}`) },
    });
    console.log(r.withdrawal ? "\nDone. Your money is on its way home." : "\nDone.");
    return 0;
  } catch (e) {
    console.error(`\n${e instanceof ExitStopped ? e.message : `Something went wrong: ${(e as Error).message}`}`);
    return 1;
  } finally {
    rl.close();
  }
}

main().then((code) => process.exit(code));
