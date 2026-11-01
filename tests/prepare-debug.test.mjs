import test from "node:test";
import assert from "node:assert/strict";
import { readFileWithProgress } from "../src/file-reader.js";
import { scrubText, scrubDetails, createDiagnosticStore } from "../src/diagnostics.js";

test("progress reader preserves image bytes and monotonically reports real bytes",async()=>{
  const input=new Uint8Array(768043);
  for(let i=0;i<input.length;i++)input[i]=i%251;
  const blob=new Blob([input],{type:"image/png"});
  const events=[];
  const output=await readFileWithProgress(blob,(loaded,total)=>events.push([loaded,total]),131072);
  assert.deepEqual(output,input);
  assert.ok(events.length>2,"progress should not jump 0 -> 100");
  assert.deepEqual(events[0],[0,input.length]);
  assert.deepEqual(events.at(-1),[input.length,input.length]);
  for(let i=1;i<events.length;i++)assert.ok(events[i][0]>=events[i-1][0]);
});
test("reader rejects empty, oversized and malformed inputs without success",async()=>{
  await assert.rejects(readFileWithProgress(new Blob([])),/nonempty/);
  await assert.rejects(readFileWithProgress(new Blob([new Uint8Array(5*1024*1024+1)])),/5 MiB/);
  await assert.rejects(readFileWithProgress(new Blob([new Uint8Array([1])]),()=>{},0),/chunk size/);
  const broken={size:10,slice:()=>({size:10,arrayBuffer:async()=>new Uint8Array(1).buffer})};
  await assert.rejects(readFileWithProgress(broken),/Unexpected binary read length/);
});
test("logs redact wallet secrets, signed blobs, and raw memo data",()=>{
  const seed="s"+"B".repeat(29);
  const blob="AA".repeat(160);
  const details=scrubDetails({
    wallet:{seed,privateKey:"MYSUPERSECRET"},
    seed,
    tx_blob:blob,
    MemoData:blob,
    message:"Failed with seed="+seed,
    hash:"A".repeat(64),
    fileBytes:[1,2,3]
  });
  const json=JSON.stringify(details);
  assert.ok(!json.includes(seed));
  assert.ok(!json.includes(blob));
  assert.ok(!json.includes("MYSUPERSECRET"));
  assert.ok(json.includes("[REDACTED]"));
  assert.ok(json.includes("A".repeat(64)),"public hash is retained for ledger proof");
  assert.ok(scrubText("seed: "+seed).includes("[REDACTED"));
});
test("diagnostic log persists bounded sanitized events and never sends network data",()=>{
  const data=new Map();
  const storage={
    getItem:key=>data.get(key)||null,
    setItem:(key,value)=>data.set(key,value)
  };
  const clock=()=> "2026-11-01T12:00:00.000Z";
  const d=createDiagnosticStore(storage,clock);
  for(let i=0;i<380;i++)d.add("info","prepare.read",{percent:i,seed:"s"+"B".repeat(29)});
  const events=d.list();
  assert.equal(events.length,350);
  assert.equal(events.at(-1).stage,"prepare.read");
  assert.ok(!JSON.stringify(d.report()).includes("s"+"B".repeat(29)));
  const restored=createDiagnosticStore(storage,clock);
  assert.equal(restored.list().length,350);
  restored.clear();assert.equal(restored.list().length,0);
  assert.equal(createDiagnosticStore(storage,clock).list().length,0);
});
