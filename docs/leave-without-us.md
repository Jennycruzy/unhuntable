# Leave without us

Your money comes home from your 12 words alone, even if our servers, our domain and our team are gone.

Your private balance is an OutLayer deterministic wallet owned by the NEAR implicit account of the key your 12 words make, and every piece key comes from the same words. The exit tool (`exit/`) needs only those words and a destination:

1. Finds every wallet that belongs to you, and every NEAR-controlled piece: each piece key the words make is looked up on `unhuntable.near`, and its Hyperliquid account is read from NEAR's MPC network.
2. Closes any open position with a reduce-only order. On a NEAR-controlled piece it first makes a one-time agent key on your computer and approves it through the contract.
3. Moves each piece's USDC back to your private balance. NEAR-controlled pieces' moves are signed by their piece key and by NEAR; a NEAR account you name pays the gas (about 0.01 NEAR a step) and cannot change them.
4. Sends the private balance to your address on NEAR, Base or Arbitrum, after you type `yes`.
5. Offers to remove our server's key from all your wallets. Each wallet also holds a backup key your words make, added when the wallet was made, so our key can always be removed and the wallet stays yours to use.

It runs as a single HTML page from disk, or from a terminal. It talks only to OutLayer, Hyperliquid and a NEAR RPC, and the words never leave your computer.

[Back to the README](../README.md)
