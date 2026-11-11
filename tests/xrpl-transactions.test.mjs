import test from "node:test";
import assert from "node:assert/strict";
import * as xrpl from "xrpl";
import {encodeChunk,digestHex,CHUNK_BYTES,toHex} from "../src/protocol.js";

test("native XRPL single-account Batch signs locally and exposes verifiable inner hashes",async()=>{
  const w=xrpl.Wallet.generate();
  const file=new Uint8Array(CHUNK_BYTES+10).fill(4);
  const hash=await digestHex(file);
  const inner=[0,1].map((i)=>({
    TransactionType:"AccountSet",Account:w.address,Flags:1073741824,
    Fee:"0",SigningPubKey:"",Sequence:1001+i,
    Memos:[{Memo:{MemoType:toHex(new TextEncoder().encode("xrpman/chunk-v1")),
      MemoData:encodeChunk(file.slice(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES),hash,i,2)}}]
  }));
  const outer={
    TransactionType:"Batch",Account:w.address,Flags:65536,
    Sequence:1000,LastLedgerSequence:1030,Fee:"30",RawTransactions:inner.map(RawTransaction=>({RawTransaction}))
  };
  xrpl.validate(outer);
  const signed=w.sign(outer);
  assert.match(signed.hash,/^[A-F0-9]{64}$/);
  assert.ok(signed.tx_blob.length>0);
  for(const transaction of inner){
    const innerHash=xrpl.hashes.hashSignedTx(transaction);
    assert.match(innerHash,/^[A-F0-9]{64}$/);
  }
});
test("mint NFT anchor with manifest memo validates and signs locally",async()=>{
  const w=xrpl.Wallet.generate(),archiveId="A".repeat(64);
  const manifest=JSON.stringify({protocol:"XRPMan-MemoVault",version:1,archiveId});
  const tx={
    TransactionType:"NFTokenMint",Account:w.address,Sequence:1001,LastLedgerSequence:1040,
    Fee:"10",NFTokenTaxon:0,Flags:8,
    URI:toHex(new TextEncoder().encode("xrpman://v1/"+archiveId)),
    Memos:[{Memo:{MemoType:toHex(new TextEncoder().encode("xrpman/manifest-v1")),
      MemoData:toHex(new TextEncoder().encode(manifest))}}]
  };
  xrpl.validate(tx);
  assert.match(w.sign(tx).hash,/^[A-F0-9]{64}$/);
});
