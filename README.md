# XRPMan Memo Minter — v0.2 TESTNET

**STATUS: DEVELOPMENT BRANCH / UNVERIFIED LIVE XRPL TRANSACTIONS. MAINNET DISABLED.**

Experimental browser app for writing actual binary data to XRPL transaction memos, retrieving chunks from **validated ledger transaction hashes**, and minting an archive NFT. Supports pictures, songs, video, PDFs and arbitrary bytes (up to 5 MiB in this version). Every byte of the original file is reconstructed and verified against SHA-256.

## Threat model and secret handling
- Testnet/Devnet **only**. No Mainnet URI, network option, or Mainnet submission path.
- Use a **new, disposable, funded non-mainnet wallet**; never import a mainnet account seed, even though the client can't submit to Mainnet.
- The user selects a local wallet JSON file containing \`seed\`, \`familySeed\`, or \`wallet.seed\`, all in XRPL family seed format. Mnemonics are unsupported.
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
