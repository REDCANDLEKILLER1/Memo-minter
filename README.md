# XRPMan Data Vault — Memo-minter

Browser-only proof of concept for packaging arbitrary files as numbered XRPL memo chunks.

## Current features
- Upload images, audio, video, PDFs or any other file.
- Preserve binary bytes and compute SHA-256.
- Split into 850-byte chunks and show illustrative groups of 8 transaction memos.
- Download the JSON archive and manifest.
- Import an exported archive, validate ordering and the SHA-256 digest, reconstruct and preview/download the file.

## Current limitations
**DRY RUN / OFFLINE ONLY.** The website does not connect wallets, sign transactions, send XRP, submit XRPL batches, or retrieve transactions from XRPL. Batch JSON is illustrative and must not be submitted as-is.

The browser must support Web Crypto. Local packaging is memory-intensive; large files should not be used until streaming chunk processing is implemented. Committing a file on-chain is public and effectively irreversible. Before any Testnet work, implement real memo serialization and payload limits, batching protocol validation, durable upload checkpoints, cost gates, idempotent resume, and historical transaction retrieval.

## Deployment
Static site. Serve `index.html` over HTTPS. No build tools or environment variables are required.

## Security
Never paste wallet secrets or seed phrases into this application. No live signing or mainnet functionality is included.

Brand: XRPMan • black / #00FF00.
