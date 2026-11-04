"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useSession } from "../lib/session";
import type { Me } from "../lib/types";

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="screen">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function Notice({ kind = "info", children, testId, live }: { kind?: "info" | "error" | "ok" | "warn"; children: ReactNode; testId?: string; live?: boolean }) {
  return (
    <div className={`notice ${kind}${live ? " live" : ""}`} role={kind === "error" ? "alert" : "status"} data-testid={testId}>
      {children}
    </div>
  );
}

/** Shows children only when signed in; otherwise the API's sentence and a way to sign in. */
export function SignedIn({ children }: { children: (me: Me) => ReactNode }) {
  const { me } = useSession();
  if (me.status === "loading") return <p className="muted">Loading…</p>;
  if (me.status === "error") return <Notice kind="error">{me.message}</Notice>;
  if (me.status === "signed_out")
    return (
      <>
        <Notice>{me.message}</Notice>
        <Link className="button" href="/signin/">
          Sign in
        </Link>
      </>
    );
  return <>{children(me.me)}</>;
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <FactRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function FactRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
