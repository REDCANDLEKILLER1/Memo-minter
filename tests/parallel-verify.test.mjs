import test from "node:test";
import assert from "node:assert/strict";
import {mapValidatedParallel,MAX_READ_CONCURRENCY} from "../src/parallel-verify.js";

test("Eight independent Batch inner hashes validate in parallel, with at most three active reads",async()=>{
  const hashes=Array.from({length:8},(_,i)=>"hash-"+i);
  let active=0,peak=0;
  const seen=[];
  const results=await mapValidatedParallel(hashes,async (hash,index)=>{
    active++;peak=Math.max(peak,active);
    seen.push(index);
    await new Promise(resolve=>setTimeout(resolve,8));
    active--;
    return {hash,index,validated:true};
  });
  assert.equal(results.length,8);
  assert.deepEqual(results.map(x=>x.index),[0,1,2,3,4,5,6,7]);
  assert.equal(peak,MAX_READ_CONCURRENCY);
  assert.equal(seen.length,8);
});
test("Any missing or invalid inner hash blocks the complete batch",async()=>{
  const hashes=Array.from({length:8},(_,i)=>"hash-"+i);
  let verified=0;
  await assert.rejects(mapValidatedParallel(hashes,async(hash,index)=>{
    if(index===3)throw new Error("Inner hash not validated");
    verified++;
    await Promise.resolve();
    return hash;
  }),/Inner hash not validated/);
  assert.ok(verified<=7);
});
test("Only read verification can run here, concurrency cannot exceed three",async()=>{
  await assert.rejects(mapValidatedParallel([1],async x=>x,4),/safe limit/);
  await assert.rejects(mapValidatedParallel([1],async x=>x,0),/safe limit/);
  assert.deepEqual(await mapValidatedParallel([],async x=>x),[]);
});
