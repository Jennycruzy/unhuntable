import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  // A static site: every page is plain HTML and JS served from our own origin.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // the client library lives next to web/ in this repo
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
};

export default config;
