import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Shell } from "../components/Shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unhuntable",
  description: "Trade on Hyperliquid in pieces, with invisible stops, and send your money home when you want.",
  referrer: "no-referrer",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0e1012" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
