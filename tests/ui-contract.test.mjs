import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const html=readFileSync("index.html","utf8");
const main=readFileSync("src/main.js","utf8");
test("customer journey exposes upload, one approval, gallery and ladybug debug",()=>{
  for(const id of ["sourceFile","prepareStatus","prepareReadProgress","autoMint",
    "autoStatus","progress","pauseAuto","galleryGrid","galleryViewer",
    "refreshGallery","ladybugToggle","debugDownload"]) {
    assert.match(html,new RegExp('id="'+id+'"'),"UI control "+id+" missing");
  }
  assert.match(html,/>Pay &amp; Mint</);
  assert.match(html,/My Gallery/);
  assert.match(html,/Mainnet disabled|MAINNET DISABLED/);
});
test("automated pipeline is still Testnet/Devnet only and does not charge a 2 XRP platform fee",()=>{
  assert.match(main,/runAutoUpload/);
  assert.match(main,/assertFeeBudget/);
  assert.match(main,/lookupValidatedTx/);
  assert.match(main,/extractVaultArchiveId/);
  assert.ok(!main.includes("wss://xrplcluster.com"),"Do not silently add Mainnet");
  assert.ok(!main.includes("Destination:"),"No platform payment destination is permitted in this phase");
  assert.match(main,/SERVICE_FEE_DROPS/);
  assert.ok(!main.includes("wallet.seed)"),"Do not leak wallet seed to networking");
});
