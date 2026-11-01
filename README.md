# XRPMan Memo Minter — v0.3.1 TESTNET HOTFIX

**STATUS: DEVELOPMENT BRANCH / UNVERIFIED LIVE XRPL TRANSACTIONS. MAINNET DISABLED.**

Experimental browser app for writing actual binary data to XRPL transaction memos, retrieving chunks from **validated ledger transaction hashes**, and minting an archive NFT. Supports pictures, songs, video, PDFs and arbitrary bytes (up to 5 MiB in this version). Every byte of the original file is reconstructed and verified against SHA-256.

## v0.3.1 — Faster read-only verification + persistent ladybug (performance hotfix)
- **Bottleneck found:** After each validated outer Batch, previous implementation read all eight inner hashes sequentially. Each outer batch was held until eight separate read round trips completed.
- New `mapValidatedParallel` worker pool verifies up to **3 inner transactions concurrently**, preserves strict result ordering, and aborts the batch without marking it complete if any inner hash cannot be proved valid. Signing and outer submissions remain **strictly sequential** (no speculative Sequence or Ticket reuse).
- A **separate read-only** Honeycluster endpoint is optionally connected after one-time user approval: `wss://testnet.honeycluster.io/` (or `wss://devnet.honeycluster.io/`). Half the inner-hash queries prefer that peer. If unavailable or lagging, the app falls back to the primary Testnet/Devnet node using the same exact transaction hash and validates the returned ledger result. **No secrets or signed blobs are ever sent to the read peer**, and no submit calls target it. These read lanes do not enable Mainnet.
- Per-batch diagnostic timings include `tx.submit.timing` and `tx.reconcile.success` with `elapsedMs` and `readConcurrency`, so device logs can reveal actual bottlenecks.
- Ladybug button remains a fixed **upper-right mobile-safe overlay** at high stacking priority. Debug history is still bounded to 350 redacted events, but event persistence is debounced (750 ms; error events flushed immediately) and visible log re-rendering is throttled (120 ms) to avoid overloading mobile browsers during thousands of checks. `pagehide` and Download Log flush the buffer.
- **A running upload in an old browser tab does not hot-swap to this code.** Its signed transaction results should be verified and the checkpoint exported before resuming in the revised preview. Do not refresh or start a second tab mid-transaction.
- No guarantee of a particular throughput improvement or unlimited public-node rate capacity. Testnet actual Batch writes and gallery replay still require real device-level evidence.

## Customer flow — Upload → Pay & Mint → My Gallery (v0.3)
This is a **real transaction implementation**, not a simulation. Keep the page foregrounded; it operates in the user's browser, not as a server-side background job.

1. **Connect Test Wallet** — one-click local test-wallet creation and faucet funding verified from a validated XRPL ledger balance.
2. **Upload media** — select or drag/drop an image, audio, video, PDF or other file. The app automatically reads and hashes it and creates the numbered archive manifest and transaction-sized chunks. It shows a local preview where supported. **Limit: 5 MiB**, explicitly indicated.
3. **Pay & Mint** — a *single* approval shows file, remaining number of Batch/outer transactions, current network fee estimate, maximum allowed **per-session** fee budget (≤1 Test XRP), zero platform charge, and that media will be public. It runs up to 1,500 sequential outer transactions, using up to 8 data chunks per native Batch and only proceeding after independently validating each inner hash/AccountSet memo. It then signs NFTokenMint **only if all chunks verify**. It is never a blind fire-and-forget sender.
4. **My Gallery** — displays locally indexed archive receipts across reloads using IndexedDB, and optionally matches XRPL NFTs currently held by the connected wallet via \`account_nfts\` + the \`xrpman://v1/SHA256\` NFT URI. Clicking a *complete* archive reads its confirmed memo hashes from ledger history and recomputes SHA-256 before presenting image/audio/video or a file download.

**One-time user approval does not eliminate risk controls.** Network failure / uncertain signed hash, fee-budget exhaustion, loss of connectivity, hidden tab, or explicit Pause stop future signatures. Exact transaction-hash read-only lookup may retry; neither signing nor submitting the same transaction is automatically retried. Resume requires reopening the app with the same disposable test wallet and file, then authorizing remaining fees once. All verified upload receipts can be downloaded as nonsecret JSON.

**Gallery portability caveat:** The NFT URI currently carries the archive SHA-256, **not** a complete on-ledger transaction index. A second device needs an exported archive receipt to reconstruct the media. A standalone on-ledger index from NFT ID alone is a separate future protocol phase. IndexedDB only contains public manifest/hashes, not the seed or media file bytes; local storage is not a guaranteed backup.

**Pricing:** The prospective **2 XRP service fee is not active.** There is no fee recipient, platform payment, Mainnet signing, or automatic 2 XRP charge in this branch. Only Testnet/Devnet transaction fees are submitted on authorized clicks.

**Release gate:** CI unit/simulation tests and client build are not a live XRPL Batch success. Independently verify a small Testnet file end-to-end (wallet / Batch inner transaction records / gallery readback / NFT ID) and interruption/recovery before merging and certainly before enabling Mainnet or platform payments.

## Ladybug diagnostics + local file preparation (v0.2.2)
- A small **🐞** toggle is fixed at the lower-right of the screen. It opens a scrollable local diagnostic panel with timestamped browser errors, unhandled promise rejections, button operations, network/funding stages, file selected (only media kind + size), actual file-read percentage, SHA-256 hashing, upload checkpoints, signed/validated transaction **hashes**, receipt retrieval and failure outcomes.
- Debug panel offers **Download Log**, **Copy Log**, and **Clear**. Logs are bounded to the most recent 350 events and persisted in localStorage across refreshes, with redaction for seeds, mnemonics, private keys, signed blobs, MemoData and long hex. No diagnostic data is uploaded or sent to a telemetry endpoint.
- The **Prepare file** button now shows immediate activity, a spinner, per-byte progress from 256 KiB local binary reads, a distinct hashing phase, and a clear success banner ("no transactions sent yet") or a clear error banner. The original ledger-progress bar remains separate and is labeled accordingly.
- The selected file name may be shown in the browser UI, but is **not** sent to the diagnostic log. The file's binary data stays local until the user explicitly authorizes ledger writes.
- Regression tests cover byte-identical image reads, monotonic progress, invalid input, bounded persistence and secret redaction. All **16/16 unit tests** and the Vite build passed on GitHub Actions run 41264964794 (head \`5aba587\`).
- **Not yet verified:** live mobile file-picker interaction and XRPL signing/Batch/NFT behavior. The PR remains a draft; existing main/production are unchanged.

## One-click Testnet wallet onboarding (v0.2.1)
1. Click **Connect Test Wallet**. There is no external website or manual seed entry.
2. The browser generates a disposable wallet locally with \`xrpl.Wallet.generate()\` and requests a wallet-backup JSON download. Confirm the JSON was actually saved; the browser cannot attest that Downloads completed.
3. The app connects to the selected Testnet/Devnet WebSocket and calls \`client.fundWallet(wallet)\`. xrpl.js uses the appropriate public test-network faucet; **only the public account address is needed**. This is still an external faucet service, hosted by the XRPL ecosystem; an app cannot mint test XRP on its own.
4. The UI displays **Connected & funded** only after a positive \`account_info\` balance is independently read from a **validated** ledger. Faucet errors and outages stay in an unfunded state. A retry reuses the same account, never silently creates another.
5. An existing local test wallet can optionally be restored from the downloaded JSON via the advanced restore section, or used to resume a saved archive checkpoint.

The site never stores the seed in localStorage or on Vercel. The JSON download contains the test seed in plaintext: keep it private and **never reuse it on Mainnet**. Closing the browser requires loading the saved backup to sign on the same account again. A Testnet reset can remove its balance and history. Funding availability and CORS must be tested from a real mobile browser; no successful live faucet call is claimed by the unit tests.

## Threat model and secret handling
- Testnet/Devnet **only**. No Mainnet URI, network option, or Mainnet submission path.
- Use a **new, disposable, funded non-mainnet wallet**; never import a mainnet account seed, even though the client can't submit to Mainnet.
- A one-tap generated test wallet is the default. Optional recovery selects a local wallet JSON file containing \`seed\`, \`familySeed\`, or \`wallet.seed\`, all in XRPL family seed format. Mnemonics are unsupported.
- Seed is read by the local browser script; it is never posted to the server, put in localStorage or echoed into logs or download receipts.
- Signing uses pinned xrpl.js bundled into same-origin JavaScript at build time. Content Security Policy only allows this origin's JavaScript and configured non-mainnet websocket hosts.
- Any malicious extension, injected script, or compromised browser could still steal a seed. **No independent security audit yet.** Prefer wallet-approved signing for future production versions.
- Checkpoints store only public archive metadata, account address and validated/signed transaction hashes. They **do not** store seed or signed transaction blobs.

## Upload protocol
- File SHA-256 identifies the archive; the manifest records filename, MIME, byte count, chunk count, chunk size, hash, network.
- Each \`AccountSet\` data transaction contains exactly one \`xrpman/chunk-v1\` memo.
- \`MemoData\` is the hex encoding of a 28-byte binary header (\`XMV1\`, first 16 SHA-256 bytes, big-endian 32-bit index and total) followed by 1–720 original file bytes.
- When mode is Batch and >=2 chunks remain, build 2–8 inner \`AccountSet\` transactions with \`tfInnerBatchTxn\`, outer \`tfAllOrNothing\` and signatures from a single loaded account. A final single chunk uses a standalone \`AccountSet\`.
- \`xrpl.Client.autofill()\`, \`xrpl.validate()\`, local \`wallet.sign()\`, \`client.submitAndWait()\`, and a strict 200,000-drop fee cap for each outer transaction.
- Before any network submission, the exact signed hash, expected inner transaction hashes, fee, Sequence and LastLedgerSequence are saved as an **unresolved checkpoint**.
- Success requires querying the signed outer hash and **every individual inner transaction hash**, requiring \`validated: true\` and \`meta.TransactionResult === "tesSUCCESS"\`; transaction account/type and encoded memo content are also compared. A transport failure or partial proof **blocks all replacement signing**.
- Maximum four outer transactions per user confirmation. No bulk unattended queue or automatic retry.

## Mint
After every data chunk is verified, an explicit action signs \`NFTokenMint\` (\`Flags: 8\`, \`NFTokenTaxon: 0\`) with:
- \`URI\` = hex of \`xrpman://v1/<FULL_SHA256>\`
- \`xrpman/manifest-v1\` memo containing the full small JSON manifest.
- NFT mint hash is considered successful only after exact-hash validated \`tesSUCCESS\` verification.

## Reading
Load the exported nonsecret receipt, select the corresponding network, query each expected hash from the ledger, check type/account/memo/header/index, reassemble bytes in order and independently calculate the final file SHA-256 before preview/download.

**Current constraint:** the reader needs a receipt containing the chunk transaction hashes. It does not yet discover the file from an NFT ID or scan account history. The app does not automatically retry insufficiently verified signed transactions, even if this means a manual forensic recovery is needed. Batch network support must be verified on the selected network. XRPL archival nodes do not guarantee unlimited historic retrieval.

## Running / testing
\`\`\`sh
npm install
npm test
npm run build
npm run dev
\`\`\`
CI tests protocol-level encoding, invalid envelopes, receipt validation and binary reconstruction. **They do not constitute proof of live ledger submissions, full transaction fee safety, browser wallet security or NFT mint behavior.**

## Deployment and release policy
This branch is intentionally not merged into main until a non-mainnet build and end-to-end signing/verification workflow has been independently audited. The existing publicly deployed \`main\` prototype remains unaffected until a reviewed release is approved.

No production Mainnet unlock is implemented.
