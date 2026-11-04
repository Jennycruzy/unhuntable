"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { localRelock } from "../lib/home";
import { SessionProvider, useSession } from "../lib/session";
import { IconDeposit, IconHome, IconPositions, IconStart, IconTrade, Mark } from "./icons";

const LINKS = [
  { href: "/", name: "Start", icon: IconStart },
  { href: "/deposit/", name: "Deposit", icon: IconDeposit },
  { href: "/trade/", name: "Trade", icon: IconTrade },
  { href: "/positions/", name: "Positions", icon: IconPositions },
  { href: "/home/", name: "Send home", icon: IconHome },
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

/** The start page is the cover for visitors; everything else is the app. */
function Frame({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const path = usePathname() || "/";
  const norm = path.endsWith("/") ? path : path + "/";
  const cover = norm === "/" && me.status !== "ok";
  if (cover) return <div className="shell">{children}</div>;
  return (
    <div className="shell app">
      <RelockBanner />
      {children}
      <nav className="nav" aria-label="Main">
        <Link href="/" className="brand mark">
          <Mark />
          Unhuntable
        </Link>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={norm === l.href ? "page" : undefined}>
            <l.icon />
            {l.name}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Frame>{children}</Frame>
    </SessionProvider>
  );
}
