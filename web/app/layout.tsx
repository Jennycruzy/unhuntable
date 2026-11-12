import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Shell } from "../components/Shell";
import "@fontsource-variable/big-shoulders-display";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./globals.css";

const DESCRIPTION = "Trade on Hyperliquid in pieces nobody can link, with stops that stay sealed until they fire.";

export const metadata: Metadata = {
  metadataBase: new URL("https://tryunhuntable.site"),
  title: "Unhuntable",
  description: DESCRIPTION,
  referrer: "no-referrer",
  openGraph: { title: "Unhuntable", description: DESCRIPTION, url: "/", siteName: "Unhuntable", type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Trade big. Leave nothing to hunt." }] },
  twitter: { card: "summary_large_image", title: "Unhuntable", description: DESCRIPTION, images: ["/og.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0a" },
    { media: "(prefers-color-scheme: light)", color: "#f1efe8" },
  ],
};

/* Runs before first paint: a browser with a session hides the cover while its overview loads. Hashed into the CSP at build. */
const SESSION_FLAG = `try{if(localStorage.getItem("unhuntable:signed-in"))document.documentElement.dataset.session="1"}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SESSION_FLAG }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
