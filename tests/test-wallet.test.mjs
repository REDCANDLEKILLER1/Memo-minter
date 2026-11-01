import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTestNetwork, readValidatedDrops, fundAndVerifyTestWallet, validatedDrops
} from "../src/test-wallet.js";

const address="rTestWalletAddress12345678912345";
const wallet=Object.freeze({address, seed:"sNeverSendToFaucet123"});
const funded = amount => ({
  result:{account_data:{Account:address,Balance:String(amount)}}
});
const missing = () => {throw Object.assign(new Error("actNotFound"),{data:{error:"actNotFound"}})};
function testClient({accounts=[funded("10000000")],faucet=async(w)=>({wallet:w,balance:10})}={}) {
  let calls=0, fundingCalls=0;
  const requested=[];
  return {
    isConnected:()=>true,
    request:async input=> {
      requested.push(input);
      const response=accounts[Math.min(calls++,accounts.length-1)];
      return typeof response==="function"?response():response;
    },
    fundWallet:async(w,options)=>{
      fundingCalls++;
      assert.equal(w.address,wallet.address);
      assert.equal(w.seed,wallet.seed);
      assert.deepEqual(Object.keys(options),["usageContext"]);
      return faucet(w);
    },
    get fundingCalls(){return fundingCalls},
    get requests(){return requested}
  };
}
test("funded existing wallet does not call faucet",async()=>{
  const client=testClient();
  const answer=await fundAndVerifyTestWallet({client,wallet,network:"testnet"});
  assert.equal(answer.balanceDrops,10000000n);
  assert.equal(answer.alreadyFunded,true);
  assert.equal(client.fundingCalls,0);
  assert.equal(client.requests[0].ledger_index,"validated");
});
test("one tap: missing wallet -> faucet -> validated positive balance",async()=>{
  const client=testClient({accounts:[missing,funded("25000000")]});
  const stages=[];
  const result=await fundAndVerifyTestWallet({
    client,wallet,network:"testnet",onStatus:s=>stages.push(s),pause:async()=>{}
  });
  assert.equal(client.fundingCalls,1);
  assert.equal(result.balanceDrops,25000000n);
  assert.deepEqual(stages,["request-faucet","verify-ledger"]);
});
test("do not claim funding until ledger has validated balance",async()=>{
  const client=testClient({accounts:[missing,missing,missing]});
  await assert.rejects(fundAndVerifyTestWallet({
    client,wallet,network:"devnet",maxPolls:2,pause:async()=>{}
  }),/no validated ledger balance/i);
  assert.equal(client.fundingCalls,1);
});
test("mainnet and arbitrary network never fund",async()=>{
  const client=testClient();
  for(const network of ["mainnet","unknown",null]) {
    assert.throws(()=>assertTestNetwork(network),/Only XRPL Testnet and Devnet/);
    await assert.rejects(fundAndVerifyTestWallet({client,wallet,network}),/Only XRPL Testnet and Devnet/);
  }
  assert.equal(client.fundingCalls,0);
});
test("wrong faucet wallet identity fails",async()=>{
  const client=testClient({accounts:[missing],faucet:async()=>({wallet:{address:"rDifferent"},balance:20})});
  await assert.rejects(fundAndVerifyTestWallet({client,wallet,network:"testnet"}),/wrong wallet identity/i);
});
test("wrong account response and invalid balance never pass",async()=>{
  assert.throws(()=>validatedDrops({result:{account_data:{Account:"rWrong",Balance:"10"}}},address),/account mismatch/i);
  assert.throws(()=>validatedDrops({result:{account_data:{Account:address,Balance:"NaN"}}},address),/Invalid wallet balance/);
  const client=testClient({accounts:[()=>{throw new Error("request timeout");}]});
  await assert.rejects(readValidatedDrops(client,address),/request timeout/);
  assert.equal(client.fundingCalls,0);
});
