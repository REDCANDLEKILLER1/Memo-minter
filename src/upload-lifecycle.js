/**
 * In-tab mobile lifecycle gate: do not sign while page is backgrounded or offline.
 * Resume the *same in-memory session* when the user returns. No servers or keys.
 * This is NOT a background uploader: mobile OS can suspend or terminate a tab.
 */
export async function waitForForeground({
  isVisible, isOnline, waitForWake, shouldStop=()=>false, onHold=()=>{},
  maxWakeups=1000
}) {
  if(typeof isVisible!=="function"||typeof isOnline!=="function"||
      typeof waitForWake!=="function")throw new Error("Invalid lifecycle hooks");
  let wakeups=0;
  while(!isVisible() || !isOnline()){
    if(shouldStop())return false;
    if(wakeups>=maxWakeups) throw new Error("Foreground wait limit reached");
    onHold({visible:!!isVisible(),online:!!isOnline(),wakeups});
    wakeups++;
    await waitForWake();
  }
  return !shouldStop();
}
export function waitForPageWake(doc=document,win=window){
  return new Promise(resolve=>{
    let done=false;
    const events=[
      [doc,"visibilitychange"],[win,"online"],[win,"focus"],
      [win,"pageshow"],[win,"xrpman-upload-wake"],[win,"offline"]
    ];
    const finish=()=>{
      if(done)return;done=true;
      for(const [target,name] of events)target.removeEventListener(name,finish);
      resolve();
    };
    for(const [target,name] of events)target.addEventListener(name,finish,{once:true});
    if(doc.visibilityState==="visible" && win.navigator.onLine)finish();
  });
}
