// Read-only exact-hash reconciliation. Retrying *reads* is safe;
// submitting or signing a replacement transaction is NEVER done here.
export function ledgerTxParts(response) {
  const result=response?.result || {};
  const tx=result.tx_json || result.tx || result.transaction || result;
  const code=typeof result.meta==="object" && result.meta ? result.meta.TransactionResult : null;
  return {result,tx,code};
}
export async function lookupValidatedTx(client,hash,expectedType=null,{
  attempts=5,initialDelayMs=700,
  pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms)),
  onRetry=()=>{}
}={}){
  if(!/^[A-Fa-f0-9]{64}$/.test(hash))throw new Error("Invalid transaction hash");
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>8)throw new Error("Invalid lookup retry count");
  for(let i=0;i<attempts;i++){
    let error;
    try{
      const response=await client.request({command:"tx",transaction:hash});
      const {result,tx,code}=ledgerTxParts(response);
      if(result.validated!==true)throw new Error("Transaction not validated yet");
      if(expectedType && tx.TransactionType!==expectedType){
        throw Object.assign(new Error("Unexpected transaction type for "+hash),{permanent:true});
      }
      if(code && code!=="tesSUCCESS"){
        throw Object.assign(new Error("Validated ledger result "+code+" for "+hash),{permanent:true});
      }
      if(code!=="tesSUCCESS")throw new Error("Validated transaction result metadata not available");
      return {tx,result};
    }catch(err){error=err}
    if(error?.permanent)throw error;
    if(i===attempts-1)throw new Error("Cannot verify validated transaction "+hash+": "+String(error?.message||error));
    onRetry({hash,attempt:i+1,reason:String(error?.message||error)});
    await pause(initialDelayMs*(i+1));
  }
  throw new Error("Unexpected transaction lookup state");
}
