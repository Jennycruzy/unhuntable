"use client";
import { useEffect, useState } from "react";
import { keyFromMnemonic, type PiecesKey } from "unhuntable-client/keys";
import { Notice, Screen, SignedIn } from "../../components/ui";
import { sentence } from "../../lib/api";
import { api, useSession } from "../../lib/session";
import { balanceReady, checkWords, linkPiecesKey, makeBalanceWallet, newMnemonic, pickPositions, restoreKey } from "../../lib/setup";
import { usePiecesKey } from "../../lib/usekey";
import { forgetPiecesKey, savePiecesKey } from "../../lib/vault";
import type { Me } from "../../lib/types";

type Step = "intro" | "words" | "check" | "key" | "balance" | "done" | "restore";

function Words({ words, onNext }: { words: string; onNext: () => void }) {
  return (
    <>
      <p>
        <strong>Write these down. They are the only way to get your money home without us.</strong>
      </p>
      <ol className="words" data-testid="words">
        {words.split(" ").map((w, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            {w}
          </li>
        ))}
      </ol>
      <p className="words-note">Anyone with these words can move your money. We can&apos;t show them again.</p>
      <button type="button" onClick={onNext}>
        I wrote them down
      </button>
    </>
  );
}

function Check({ words, onOk, onBack }: { words: string; onOk: () => void; onBack: () => void }) {
  const [positions] = useState(() => pickPositions());
  const [typed, setTyped] = useState(["", "", ""]);
  const [wrong, setWrong] = useState(false);
  return (
    <form
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        if (checkWords(words, positions, typed)) onOk();
        else setWrong(true);
      }}
    >
      {positions.map((p, i) => (
        <div key={p}>
          <label htmlFor={`w${i}`}>Word {p + 1}</label>
          <input
            id={`w${i}`}
            data-testid={`check-${i}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={typed[i]}
            onChange={(e) => {
              const t = [...typed];
              t[i] = e.target.value;
              setTyped(t);
              setWrong(false);
            }}
          />
        </div>
      ))}
      {wrong && (
        <Notice kind="error" testId="check-wrong">
          One of those words doesn&apos;t match. Look at your paper and try again.
        </Notice>
      )}
      <button type="submit">Check</button>
      <button type="button" className="secondary" onClick={onBack}>
        Show the words again
      </button>
    </form>
  );
}

function SetupFlow({ me }: { me: Me }) {
  const { refresh } = useSession();
  const { state: keyState, reload } = usePiecesKey(me.accountId);
  const [step, setStep] = useState<Step>("intro");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [restoreText, setRestoreText] = useState("");
  const [info, setInfo] = useState<string | undefined>();

  const key: PiecesKey | undefined = keyState.status === "ok" ? keyState.key : undefined;

  // Where to pick up: the server knows if it has the key's public key and if the balance wallet is ready.
  useEffect(() => {
    if (keyState.status === "loading" || step === "words" || step === "check" || step === "restore") return;
    if (!key) setStep("intro");
    else if (me.piecesKey === "missing") setStep("key");
    else if (!balanceReady(me)) setStep("balance");
    else setStep("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyState.status, me.piecesKey, me.wallets]);

  /** Keep the key on this device and tell the server its public key. Answers the next step. */
  async function keep(k: PiecesKey): Promise<Step> {
    await savePiecesKey(me.accountId, k);
    await reload();
    try {
      await linkPiecesKey({ api, key: k, account: me.accountId });
    } catch (e) {
      setError(sentence(e));
      return "key";
    }
    await refresh();
    return balanceReady(me) ? "done" : "balance";
  }

  async function link() {
    if (!key) return;
    setBusy(true);
    setError(undefined);
    try {
      await linkPiecesKey({ api, key, account: me.accountId });
      await refresh();
      setStep("balance");
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  async function balance() {
    if (!key) return;
    setBusy(true);
    setError(undefined);
    try {
      await makeBalanceWallet({ api, key, account: me.accountId });
      await refresh();
      setStep("done");
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="ok">{info}</Notice>}

      {step === "intro" && me.piecesKey === "set" && (
        <>
          <p>Your account already has a pieces key.</p>
          <button type="button" onClick={() => setStep("restore")}>
            Restore from 12 words
          </button>
        </>
      )}

      {step === "intro" && me.piecesKey === "missing" && (
        <>
          <button
            type="button"
            onClick={() => {
              setWords(newMnemonic());
              setStep("words");
            }}
          >
            Make my 12 words
          </button>
          <button type="button" className="secondary" onClick={() => setStep("restore")}>
            Restore from 12 words
          </button>
        </>
      )}

      {step === "words" && <Words words={words} onNext={() => setStep("check")} />}

      {step === "check" && (
        <Check
          words={words}
          onBack={() => setStep("words")}
          onOk={async () => {
            const k = keyFromMnemonic(words);
            setWords("");
            setStep(await keep(k));
          }}
        />
      )}

      {step === "restore" && (
        <form
          autoComplete="off"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              const k = restoreKey(restoreText);
              setRestoreText("");
              const next = await keep(k);
              setInfo("Your pieces key is back on this device.");
              setStep(next);
            } catch (err) {
              setError(sentence(err));
            }
          }}
        >
          <label htmlFor="restore">Your 12 words</label>
          <textarea id="restore" data-testid="restore" spellCheck={false} autoCapitalize="off" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
          <button type="submit">Restore</button>
          <button type="button" className="secondary" onClick={() => setStep("intro")}>
            Back
          </button>
        </form>
      )}

      {step === "key" && key && (
        <>
          <h2>Link your pieces key</h2>
          <p data-testid="link-words">This device signs a short note with your pieces key so we know its public key. Nothing is added to your NEAR account.</p>
          <button type="button" disabled={busy} onClick={link}>
            {busy ? "Linking…" : "Link my pieces key"}
          </button>
        </>
      )}

      {step === "balance" && key && (
        <>
          <h2>Make your private balance</h2>
          <button type="button" disabled={busy} onClick={balance}>
            {busy ? "Making it…" : "Make my private balance"}
          </button>
        </>
      )}

      {step === "done" && (
        <>
          <Notice kind="ok">Your pieces key is set up and on this device.</Notice>
          <a className="button" href="/deposit/">
            Deposit
          </a>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await forgetPiecesKey(me.accountId);
              await reload();
              setInfo("Forgotten on this device. Your 12 words bring it back.");
              setStep("intro");
            }}
          >
            Forget on this device
          </button>
        </>
      )}
    </>
  );
}

export default function SetupPage() {
  return <Screen title="Your pieces key">{<SignedIn>{(me) => <SetupFlow me={me} />}</SignedIn>}</Screen>;
}
