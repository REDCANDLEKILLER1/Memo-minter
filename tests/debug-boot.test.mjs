import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {createDiagnosticStore,mountLadybug} from "../src/diagnostics.js";

class FakeElement {
  constructor(){this.hidden=false;this.textContent="";this.events=new Map();this.attributes={};this.children=[]}
  addEventListener(name,fn){this.events.set(name,[...(this.events.get(name)||[]),fn])}
  setAttribute(key,value){this.attributes[key]=value}
  click(){for(const fn of this.events.get("click")||[])fn()}
  replaceChildren(){this.children=[]}
  append(...children){this.children.push(...children)}
}
function testPage(){
  const ids=["debugPanel","ladybugToggle","debugDockToggle","debugHealth",
    "debugEntries","debugCount","debugLast","debugClose","debugDownload","debugCopy","debugClear"];
  const elements=new Map(ids.map(id=>[id,new FakeElement()]));
  elements.get("debugPanel").hidden=true;
  const doc={
    readyState:"complete",visibilityState:"visible",
    getElementById(id){return elements.get(id)||null},
    createElement(){return new FakeElement()},
    addEventListener(){}
  };
  const events=new Map(),storage=new Map();
  const win={
    navigator:{onLine:true,clipboard:{writeText:async()=>{}}},
    setTimeout,clearTimeout,
    confirm:()=>true,
    addEventListener(name,fn){events.set(name,[...(events.get(name)||[]),fn])}
  };
  const context={
    document:doc,window:win,localStorage:{
      getItem:key=>storage.get(key)||null,setItem:(key,v)=>storage.set(key,v),
      removeItem:key=>storage.delete(key)
    },URL,Blob,setTimeout,clearTimeout,Date,console,
    confirm:()=>true
  };
  return {doc,win,elements,context};
}
test("debug is independently accessible when the XRPMan app bundle never loads",()=>{
  const {elements,context,win}=testPage();
  vm.runInNewContext(readFileSync("public/debug-boot.js","utf8"),context);
  assert.equal(win.__xrpmanDebugBootReady,true);
  elements.get("debugDockToggle").click();
  assert.equal(elements.get("debugPanel").hidden,false);
  elements.get("ladybugToggle").click();
  assert.equal(elements.get("debugPanel").hidden,true);
  assert.match(elements.get("debugHealth").textContent,/Debug ready/);
});
test("bootstrap and app debugger do not attach duplicate click handlers",()=>{
  const {doc,win,elements,context}=testPage();
  vm.runInNewContext(readFileSync("public/debug-boot.js","utf8"),context);
  const diag=createDiagnosticStore(null);
  mountLadybug(diag,doc,win);
  assert.equal(win.__xrpmanDebugReady,true);
  assert.match(elements.get("debugHealth").textContent,/Debug active/);
  elements.get("debugDockToggle").click();
  assert.equal(elements.get("debugPanel").hidden,false,"click must open, not toggle twice");
  elements.get("ladybugToggle").click();
  assert.equal(elements.get("debugPanel").hidden,true,"float toggle must close");
  diag.add("info","upload.stage",{confirmedChunks:8});
  assert.ok(diag.report().events.some(e=>e.stage==="upload.stage"));
});
test("header diagnostics and boot loader are present in static app HTML",()=>{
  const html=readFileSync("index.html","utf8");
  assert.match(html,/id="debugDockToggle"/);
  assert.match(html,/id="ladybugToggle"/);
  assert.match(html,/id="liveUploadStatus"/);
  assert.match(html,/<script src="\/debug-boot\.js" defer><\/script>/);
  assert.match(html,/Load My Wallet/);
});
