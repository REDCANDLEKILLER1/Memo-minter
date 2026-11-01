// Bounded single-consent client-side upload queue.
// Runs only while the tab is open; never signs while hidden, offline, or unapproved.
export const MAX_OUTER_WRITES_PER_RUN = 1500;
export const DEFAULT_GROUP_SIZE = 8;
export const SERVICE_FEE_DROPS = 0n; // platform charge is not enabled

export function uploadPlan(totalChunks, completed=0, groupSize=DEFAULT_GROUP_SIZE) {
  if (!Number.isSafeInteger(totalChunks)||totalChunks<1||!Number.isSafeInteger(completed)||completed<0||completed>totalChunks) {
    throw new Error("Invalid archive chunk counts");
  }
  if(groupSize!==8) throw new Error("Only 8-slot XRPL batches are supported");
  const remaining=totalChunks-completed;
  const batches=Math.floor(remaining/8);
  const final=remaining%8;
  const outerTransactions=batches+(final>0?1:0);
  return {totalChunks,completed,remaining,batches,final,outerTransactions,mintTransactions:1};
}
export function estimateFeeDrops(plan,baseFeeDrops) {
  const base=Number(baseFeeDrops);
  if(!Number.isSafeInteger(base)||base<10||base>100000)throw new Error("Invalid base network fee");
  if(!Number.isSafeInteger(plan.outerTransactions)||plan.outerTransactions<0) throw new Error("Invalid transaction plan");
  const all=plan.batches*base*3+(plan.final?base*3:0)+base;
  if(!Number.isSafeInteger(all))throw new Error("Network fee estimate overflow");
  return BigInt(all);
}
export function assertFeeBudget({feeDrops,committedDrops,approvedMaxDrops}){
  const fee=BigInt(feeDrops), committed=BigInt(committedDrops), max=BigInt(approvedMaxDrops);
  if(fee<1n||fee>200000n)throw new Error("Outer transaction fee exceeds the 0.2 XRP cap");
  if(max<1n||max>1000000n)throw new Error("Authorized fee budget must be from 1 drop to 1 XRP");
  if(committed<0n||committed+fee>max)throw new Error("Authorized upload fee budget reached. Pause and reapprove a new budget.");
  return committed+fee;
}
export async function runAutoUpload({
  getRemaining,submitChunkGroup,mint,shouldPause=()=>false,onProgress=()=>{},
  maxOuter=MAX_OUTER_WRITES_PER_RUN,yieldControl=()=>Promise.resolve()
}){
  if(typeof getRemaining!=="function"||typeof submitChunkGroup!=="function"||typeof mint!=="function") {
    throw new Error("Missing uploader implementation");
  }
  if(!Number.isSafeInteger(maxOuter)||maxOuter<1||maxOuter>MAX_OUTER_WRITES_PER_RUN) {
    throw new Error("Upload length safety cap exceeded");
  }
  let sent=0;
  while(true){
    const remaining=getRemaining();
    if(!Array.isArray(remaining)||!remaining.every(i=>Number.isSafeInteger(i)&&i>=0)) throw new Error("Invalid remaining chunk set");
    if(!remaining.length)break;
    if(shouldPause())return {state:"paused",sent,remaining:remaining.length};
    if(sent>=maxOuter)return {state:"limit",sent,remaining:remaining.length};
    const group=remaining.slice(0,8);
    await submitChunkGroup(group); // MUST verify each included transaction before resolving
    const after=getRemaining();
    if(!Array.isArray(after)||after.length>=remaining.length)throw new Error("Ledger validation did not advance upload; stopped");
    sent++;
    onProgress({sent,remaining:after.length,confirmed:remaining.length-after.length});
    await yieldControl();
  }
  if(shouldPause())return {state:"paused",sent,remaining:0,needsMint:true};
  await mint();
  return {state:"complete",sent,remaining:0};
}
