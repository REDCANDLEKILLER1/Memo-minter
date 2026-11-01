import test from "node:test";
import assert from "node:assert/strict";
import {
 CHUNK_BYTES,MAX_FILE_BYTES,manifestFor,encodeChunk,decodeChunk,
 digestHex,fromHex,toHex,validateReceipt,reassemble
} from "../src/protocol.js";
const enc=new TextEncoder();
const sample=enc.encode("XRPMan on-ledger demo file content.");
const FILE={name:"demo.txt",type:"text/plain",size:sample.byteLength};
const wallet="r123456789ABCDEFGHJKLMNPQRSTUVWXYZab";
test("hex roundtrip + invalid input",()=>{
  assert.deepEqual(fromHex(toHex(sample)),sample);
  assert.throws(()=>fromHex("ABC"),/Malformed/);
  assert.throws(()=>fromHex("ZZ"),/Malformed/);
});
test("chunk envelope and roundtrip",async()=>{
  const digest=await digestHex(sample);
  const m=manifestFor(FILE,digest,"testnet");
  const hex=encodeChunk(sample,digest,0,1);
  const result=decodeChunk(hex,digest,0,1);
  assert.deepEqual(result,sample);
  assert.equal(hex.length,(sample.length+28)*2);
  assert.equal(m.totalChunks,1);
  assert.throws(()=>decodeChunk(hex,digest,1,1),/index/);
});
test("reject forged archive id / tampered envelope",async()=>{
  const hash=await digestHex(sample);
  const h=encodeChunk(sample,hash,0,1);
  assert.throws(()=>decodeChunk(h,"0".repeat(64),0,1),/ID mismatch/);
  assert.throws(()=>decodeChunk("00"+h.slice(2),hash,0,1),/Not an XRPMan/);
  assert.throws(()=>decodeChunk("0",hash,0,1),/hex/);
});
test("large file split reconstruct SHA256",async()=>{
  const src=new Uint8Array(CHUNK_BYTES*2+7);
  for(let i=0;i<src.length;i++)src[i]=i%251;
  const hash=await digestHex(src);
  const m=manifestFor({name:"image.png",size:src.length,type:"image/png"},hash,"devnet");
  const chunks=new Map();
  for(let i=0;i<m.totalChunks;i++){
    const srcChunk=src.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES);
    chunks.set(i,decodeChunk(encodeChunk(srcChunk,hash,i,m.totalChunks),hash,i,m.totalChunks));
  }
  assert.deepEqual(reassemble(chunks,m),src);
  assert.equal(await digestHex(reassemble(chunks,m)),hash);
  chunks.delete(0);
  assert.throws(()=>reassemble(chunks,m),/Missing/);
});
test("receipt validation blocks duplicates and malformed manifests",async()=>{
  const hash=await digestHex(sample);
  const manifest=manifestFor(FILE,hash,"testnet");
  const mk=(confirmed)=>({manifest,wallet,confirmed});
  const one={index:0,hash:"A".repeat(64)};
  assert.equal(validateReceipt(mk([one])).sha256,hash);
  assert.throws(()=>validateReceipt(mk([one,one])),/Invalid/);
  assert.throws(()=>validateReceipt(mk([{index:2,hash:one.hash}])),/Invalid/);
  assert.throws(()=>validateReceipt({manifest:{...manifest,network:"mainnet"},confirmed:[]}),/invalid/);
});
test("file caps and missing hash",()=>{
  assert.throws(()=>manifestFor({name:"x",size:MAX_FILE_BYTES+1},"A".repeat(64),"testnet"),/between/);
  assert.throws(()=>manifestFor(FILE,"BAD","testnet"),/SHA-256/);
});
