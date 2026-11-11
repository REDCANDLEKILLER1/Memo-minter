import test from "node:test";
import assert from "node:assert/strict";
import {lookupValidatedTx} from "../src/ledger-verify.js";
const hash="A".repeat(64);
const good={result:{validated:true,ledger_index:123,
  tx_json:{TransactionType:"AccountSet",Account:"rSigner"},
  meta:{TransactionResult:"tesSUCCESS"}}};
test("one read returns verified ledger transaction",async()=>{
  let reads=0;
  const out=await lookupValidatedTx({request:async input=>{
    reads++;assert.equal(input.command,"tx");assert.equal(input.transaction,hash);return good;
  }},hash,"AccountSet");
  assert.equal(reads,1);assert.equal(out.result.validated,true);
});
test("not found/lagging ledger is retried by lookup only; no submits",async()=>{
  let reads=0,retries=0;
  const client={request:async()=>{reads++;if(reads===1)throw new Error("txnNotFound");if(reads===2)return {result:{validated:false}};return good;}};
  const result=await lookupValidatedTx(client,hash,"AccountSet",{attempts:4,initialDelayMs:0,
    pause:async()=>{},onRetry:()=>retries++});
  assert.equal(result.tx.TransactionType,"AccountSet");
  assert.equal(reads,3);assert.equal(retries,2);
});
test("validated ledger failure never auto-retries",async()=>{
  let attempts=0;
  const client={request:async()=>{
    attempts++;return {result:{...good.result,meta:{TransactionResult:"tecNO_PERMISSION"}}};
  }};
  await assert.rejects(lookupValidatedTx(client,hash,"AccountSet"),/Validated ledger result tecNO_PERMISSION/);
  assert.equal(attempts,1);
});
test("never accepts malformed or unvalidated result, bounded retries",async()=>{
  await assert.rejects(lookupValidatedTx({request:async()=>good},"BADHASH"),/Invalid transaction hash/);
  let calls=0;
  await assert.rejects(lookupValidatedTx({request:async()=>{calls++;return {result:{validated:false}}}},
    hash,"AccountSet",{attempts:3,initialDelayMs:0,pause:async()=>{}}),/Cannot verify validated transaction/);
  assert.equal(calls,3);
});
test("wrong transaction type is a terminal verification error",async()=>{
  let calls=0;
  await assert.rejects(lookupValidatedTx({request:async()=>{calls++;return good}},hash,"Payment"),/Unexpected transaction type/);
  assert.equal(calls,1);
});
