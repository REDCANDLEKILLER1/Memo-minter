# XRPMan ChainApps — wallet-first XRPL delivery experiment

Status: EXPERIMENT ONLY. No wallet signing, no trading, no Mainnet, no production deployment.

## Hypothesis
A small static XRPMan Wallet-branded application can be published as bytes in XRPL Testnet transaction memos, reconstructed by a separately hosted launcher, hash-verified, and rendered without loading application assets from GitHub/Vercel/CDNs.

## Boundaries
- Existing XRPMan Wallet production repo, main branch, and deployments remain unchanged.
- Existing Memo Minter draft branch and its verified mint flow remain unchanged.
- This experiment lives on `experiment/chainapps-wallet-loader-poc`.
- **No wallet seed, Xaman authorization, trading code, external API credentials, or signer in the first payload.**
- Mainnet is locked. Never automatically execute arbitrary ledger-provided JavaScript in the launcher's own privileged origin.

## Phase 0: inventory and freeze
1. Inventory XRPMan Wallet's deployable static output, JS/CSS/images, entrypoint, external API and CSP dependencies, and licenses.
2. Freeze a small **read-only** wallet interface snapshot (no keys/signers/network writes) as the first payload. Record source commit and SHA-256 per file.
3. Define a deterministic manifest with `schemaVersion`, `appId`, `releaseVersion`, `network`, `entrypoint`, `files[{path,mime,size,sha256,chunks[]}]`, `publisher`, and optional signature.
4. Record exact compressed and original byte sizes and estimate XRPL fees and transaction counts using measured network quotes; do not extrapolate the 43-byte GIF result as a production fee quote.

## Phase 1: Testnet proof
1. Package one minimal read-only wallet UI (HTML/CSS/JS) deterministically; compress if smaller.
2. Publish via the Memo Minter's existing *Testnet-only* memo chunk pipeline; verify every transaction and export a portable receipt.
3. From a clean browser profile, launcher fetches transaction hashes from a public XRPL Testnet endpoint, verifies transaction inclusion/validation, memo ordering, sizes, and SHA-256, and reconstructs exact bytes.
4. Render in a sandboxed, opaque-origin iframe without `allow-same-origin`, wallet access, popups, top navigation, or privileged messaging. Use a strict CSP; never inject reconstructed code into launcher origin.
5. Verify no app file requests to GitHub, Vercel, CDN, or a conventional hosting origin. XRPL node connectivity remains necessary.
6. Compare reconstructed bytes against the frozen build. Re-open offline only if a verified local cache exists.

## PASS / FAIL gate
PASS only with actual Testnet transaction hashes, manifest and file hashes, readback on a fresh device/profile, rendered app, network request trace showing assets are XRPL-derived, and no signing capability. Record fees, elapsed time, retries, read providers, and archive retrieval limitations. Any unverified transaction, hash mismatch, unsafe privilege, or missing asset = FAIL CLOSED.

## Later phases (not authorized by this experiment)
- Signed versioned release pointers and rollback protections.
- Full wallet UI delivery and explicit per-release user approval.
- Independent security review of any wallet/signing integration.
- Mainnet economics and archive durability research before any live publication.

## Current evidence
Memo Minter previously verified a 43-byte Testnet GIF archive and its NFT mint, with successful ledger readback. This demonstrates a small media storage/retrieval primitive, **not** executable-app distribution, large-payload economics, or guaranteed perpetual historical availability.
