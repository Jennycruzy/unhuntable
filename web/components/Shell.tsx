"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { localRelock } from "../lib/home";
import { SessionProvider } from "../lib/session";

const LINKS = [
  { href: "/", name: "Start" },
  { href: "/deposit/", name: "Deposit" },
  { href: "/trade/", name: "Trade" },
  { href: "/positions/", name: "Positions" },
  { href: "/home/", name: "Send home" },
];

function RelockBanner() {
  const [homeId, setHomeId] = useState<string | undefined>();
  useEffect(() => {
    const read = () => setHomeId(localRelock.get());
    read();
    window.addEventListener("unhuntable-relock", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("unhuntable-relock", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  if (!homeId) return null;
  return (
    <div className="banner" role="status" data-testid="relock-banner">
      <span>Lock your pieces again</span>
      <Link href="/home/">Open</Link>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() || "/";
  const norm = path.endsWith("/") ? path : path + "/";
  return (
    <SessionProvider>
      <div className="shell">
        <RelockBanner />
        {children}
        <nav className="nav" aria-label="Main">
          <span className="brand">Unhuntable</span>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={norm === l.href ? "page" : undefined}>
              {l.name}
            </Link>
          ))}
        </nav>
      </div>
    </SessionProvider>
  );
}
