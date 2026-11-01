import test from "node:test";
import assert from "node:assert/strict";
import {uploadPlan,estimateFeeDrops,assertFeeBudget,runAutoUpload} from "../src/autopilot.js";
import {galleryKey,summarizeReceipt,extractVaultArchiveId} from "../src/gallery.js";
import {CHUNK_BYTES,digestHex,manifestFor} from "../src/protocol.js";

test("4 MB image is planned as 5556 chunks, 695 outer submissions, 1 NFT",()=>{
  const count=Math.ceil(4_000_000/CHUNK_BYTES);
  const plan=uploadPlan(count);
  assert.equal(count,5556);
  assert.equal(plan.outerTransactions,695);
  assert.equal(plan.batches,694);
  assert.equal(plan.final,4);
  assert.equal(plan.mintTransactions,1);
  assert.equal(estimateFeeDrops(plan,10),20860n);
});
test("single approval queue runs all 695 outer writes and then one NFT mint",async()=>{
  const remaining=Array.from({length:5556},(_,i)=>i);
  const sizes=[],updates=[];let minted=0;
  const result=await runAutoUpload({
    getRemaining:()=>remaining.slice(),
    submitChunkGroup:async group=>{
      assert.ok(group.length>=1 && group.length<=8);
      assert.deepEqual(group,remaining.slice(0,group.length));
      sizes.push(group.length);
      remaining.splice(0,group.length);
    },
    mint:async()=>{minted++},
    onProgress:e=>updates.push(e),
    yieldControl:async()=>{}
  });
  assert.equal(result.state,"complete");assert.equal(result.sent,695);
  assert.equal(sizes.length,695);assert.equal(sizes.at(-1),4);
  assert.equal(minted,1);assert.equal(updates.at(-1).remaining,0);
});
test("pause after confirmed batch; never mint partial uploads",async()=>{
  const remaining=[0,1,2,3,4,5,6,7,8,9];let paused=false,minted=false;
  const result=await runAutoUpload({
    getRemaining:()=>remaining.slice(),
    submitChunkGroup:async group=>{remaining.splice(0,group.length);paused=true},
    mint:async()=>{minted=true},
    shouldPause:()=>paused
  });
  assert.deepEqual(result,{state:"paused",sent:1,remaining:2});
  assert.equal(minted,false);
  assert.deepEqual(remaining,[8,9]);
});
test("unknown result stops and never sends replacement or mints",async()=>{
  const remaining=[0,1,2,3],calls=[];let minted=false;
  await assert.rejects(runAutoUpload({
    getRemaining:()=>remaining.slice(),
    submitChunkGroup:async group=>{calls.push(group);throw new Error("signed hash unresolved")},
    mint:async()=>{minted=true}
  }),/unresolved/);
  assert.equal(calls.length,1);
  assert.equal(minted,false);
});
test("non-advancing ledger proof fails closed",async()=>{
  await assert.rejects(runAutoUpload({
    getRemaining:()=>[0,1],
    submitChunkGroup:async()=>{},
    mint:async()=>{throw new Error("Should never mint")}
  }),/validation did not advance/);
});
test("bounded fee gate rejects increased fees and over-budget signing",()=>{
  assert.equal(assertFeeBudget({feeDrops:"30",committedDrops:"90",approvedMaxDrops:"120"}),120n);
  assert.throws(()=>assertFeeBudget({feeDrops:31,committedDrops:90,approvedMaxDrops:120}),/budget reached/);
  assert.throws(()=>assertFeeBudget({feeDrops:200001,committedDrops:0,approvedMaxDrops:1000000}),/0.2 XRP/);
  assert.throws(()=>assertFeeBudget({feeDrops:30,committedDrops:0,approvedMaxDrops:1000001}),/1 XRP/);
});
test("gallery identifies NFT anchor URI and fails closed on invalid URI",()=>{
  const hash="ABCDEF01".repeat(8);
  const nft={URI:Buffer.from("xrpman://v1/"+hash).toString("hex")};
  assert.equal(extractVaultArchiveId(nft),hash);
  assert.equal(extractVaultArchiveId({URI:"invalid"}),null);
  assert.equal(extractVaultArchiveId({URI:Buffer.from("https://example.com").toString("hex")}),null);
  assert.equal(galleryKey("testnet",hash),"xrpman::testnet::"+hash);
  assert.throws(()=>galleryKey("mainnet",hash),/Invalid gallery identity/);
});
test("gallery only labels archive minted after validated NFT hash in receipt",async()=>{
  const bytes=new TextEncoder().encode("hello world");
  const digest=await digestHex(bytes);
  const manifest=manifestFor({name:"photo.png",type:"image/png",size:bytes.length},digest,"testnet");
  const first={manifest,confirmed:[],wallet:"r123456789ABCDEFGHJKLMNPQRSTUVWX",nftHash:null,pending:null};
  assert.equal(summarizeReceipt(first).minted,false);
  first.nftHash="A".repeat(64);
  assert.equal(summarizeReceipt(first).minted,true);
});
