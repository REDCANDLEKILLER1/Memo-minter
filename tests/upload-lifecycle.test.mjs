import test from "node:test";
import assert from "node:assert/strict";
import {waitForForeground,waitForPageWake} from "../src/upload-lifecycle.js";

test("hidden page holds without signing and resumes when it becomes visible",async()=>{
  let visible=false, online=true, wakeups=0,holds=0;
  const outcome=await waitForForeground({
    isVisible:()=>visible,
    isOnline:()=>online,
    waitForWake:async()=>{wakeups++;visible=true},
    onHold:({visible:wasVisible,online:wasOnline})=>{
      holds++;assert.equal(wasVisible,false);assert.equal(wasOnline,true)
    }
  });
  assert.equal(outcome,true);
  assert.equal(wakeups,1);
  assert.equal(holds,1);
});
test("offline page cannot start another signature; resumes after connection returns",async()=>{
  let online=false,calls=0;
  const result=await waitForForeground({
    isVisible:()=>true,isOnline:()=>online,
    waitForWake:async()=>{calls++;online=true}
  });
  assert.equal(result,true);assert.equal(calls,1);
});
test("explicit user pause overrides automatic foreground resume",async()=>{
  let called=false;
  const result=await waitForForeground({
    isVisible:()=>false,isOnline:()=>true,shouldStop:()=>true,
    waitForWake:async()=>{called=true}
  });
  assert.equal(result,false);assert.equal(called,false);
});
test("no pending hidden waits or sleep needed when foreground already ready",async()=>{
  let sleeps=0;
  const result=await waitForForeground({
    isVisible:()=>true,isOnline:()=>true,waitForWake:async()=>{sleeps++}
  });
  assert.equal(result,true);assert.equal(sleeps,0);
});
test("foreground wake releases event listeners when page returns",async()=>{
  const listeners=new Map();
  const target=()=>({
    addEventListener(name,fn){const existing=listeners.get(name)||[];existing.push(fn);listeners.set(name,existing)},
    removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn))}
  });
  const doc={...target(),visibilityState:"hidden"};
  const win={...target(),navigator:{onLine:true}};
  const waking=waitForPageWake(doc,win);
  doc.visibilityState="visible";
  for(const listener of listeners.get("visibilitychange")||[])listener();
  await waking;
  for(const remaining of listeners.values())assert.equal(remaining.length,0);
});
