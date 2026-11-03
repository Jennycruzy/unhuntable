"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Notice, Screen } from "../../components/ui";
import { sentence } from "../../lib/api";
import { api, useSession } from "../../lib/session";
import { signIn, WrongNetwork } from "../../lib/signin";
import { TEST_WALLET_ID, WALLETS, WalletRefused, connectWallet, testWalletPresent } from "../../lib/wallet";

type State = { kind: "idle" } | { kind: "busy"; wallet: string } | { kind: "refused" | "network" | "error"; message: string };

export default function SignInPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [wallets, setWallets] = useState<{ id: string; name: string }[]>([...WALLETS]);

  useEffect(() => {
    if (testWalletPresent()) setWallets([...WALLETS, { id: TEST_WALLET_ID, name: "Test wallet" }]);
  }, []);

  async function go(id: string, name: string) {
    setState({ kind: "busy", wallet: name });
    try {
      const wallet = await connectWallet(id);
      await signIn(api, wallet);
      await refresh();
      router.push("/");
    } catch (e) {
      if (e instanceof WalletRefused) setState({ kind: "refused", message: e.message });
      else if (e instanceof WrongNetwork) setState({ kind: "network", message: e.message });
      else setState({ kind: "error", message: sentence(e) });
    }
  }

  return (
    <Screen title="Sign in">
      <p>Pick your NEAR wallet. It will ask you to sign a short message that proves the account is yours. Signing it costs nothing and moves no money.</p>
      {state.kind === "busy" && <Notice>Waiting for {state.wallet}…</Notice>}
      {(state.kind === "refused" || state.kind === "network" || state.kind === "error") && (
        <Notice kind="error" testId="signin-error">
          {state.message}
        </Notice>
      )}
      {wallets.map((w) => (
        <button key={w.id} type="button" disabled={state.kind === "busy"} onClick={() => go(w.id, w.name)}>
          Sign in with {w.name}
        </button>
      ))}
      <p className="small">
        <Link href="/deposit/">No NEAR wallet? You can deposit from MetaMask or Phantom first</Link>
      </p>
    </Screen>
  );
}
