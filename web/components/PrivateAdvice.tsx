"use client";
import { useState } from "react";
import { API_URL } from "../lib/config";
import { askStop, recentCandles, type AdviceResult } from "../lib/privateai";
import type { Side } from "../lib/types";
import { Notice } from "./ui";

/**
 * Ask NEAR AI's model, inside its TEE, which stop distance to use. The question is encrypted
 * in this browser; our server forwards only ciphertext; the answer is decrypted here.
 */
export function PrivateAdvice({
  coin,
  side,
  sizeUsd,
  leverage,
  choices,
  onUse,
}: {
  coin: string;
  side: Side;
  sizeUsd: number;
  leverage: number;
  choices: readonly number[];
  onUse: (distance: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<AdviceResult | undefined>();

  const ask = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const candles = await recentCandles(coin);
      setResult(await askStop({ coin, side, sizeUsd, leverage, choices, candles }, `${API_URL}/api/private-ai`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The private AI did not answer. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.receipt, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `private-ai-${result.receipt.proof.chatId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const c = result?.receipt.proof.checks;
  return (
    <div className="card" data-testid="private-ai">
      <p className="small">
        <strong>Ask the private AI where to put your stop.</strong> Your market, side, size and the stop choices are encrypted in this browser to NEAR AI&apos;s model inside its
        enclave. Our server only passes the ciphertext on, and the answer comes back readable only here.
      </p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void ask()} data-testid="private-ai-ask">
        {busy ? "Asking the private AI…" : "Ask the private AI"}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {result && (
        <>
          <p data-testid="private-ai-answer">
            It suggests a stop <strong>{Math.round(result.advice.distance * 1000) / 10}% away</strong>. {result.advice.why}
          </p>
          <button type="button" onClick={() => onUse(result.advice.distance)} data-testid="private-ai-use">
            Use this stop
          </button>
          <p className="muted small" data-testid="private-ai-sent">
            All our server saw of your question: <code>{result.sentPreview}…</code>
          </p>
          <p className="muted small" data-testid="private-ai-checks">
            NEAR AI&apos;s enclave signed the exact bytes: hashes {c?.hashesMatch ? "match" : "do not match"}, signature {c?.signatureValid ? "valid" : "not valid"}, signer{" "}
            {c?.inAttestation ? "in the hardware attestation" : "not found in the attestation"}.{" "}
            <button type="button" className="link" onClick={download}>
              Download the signed receipt
            </button>
          </p>
        </>
      )}
    </div>
  );
}
