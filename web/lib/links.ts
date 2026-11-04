/** A Hyperliquid account's public page, where anyone can see its positions and resting orders. */
export function hyperliquidPage(address: string): string {
  return `https://app.hyperliquid.xyz/explorer/address/${address}`;
}
