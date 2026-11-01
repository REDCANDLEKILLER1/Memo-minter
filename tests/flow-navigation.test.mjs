import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

class FakeElement{
  constructor(id=""){this.id=id;this.hidden=false;this.disabled=false;this.textContent="";this.handlers={};this.attrs={};this.classList={values:new Set(),toggle:(v,on)=>{if(on)this.classList.values.add(v);else this.classList.values.delete(v)}}}
  addEventListener(name,listener){(this.handlers[name]??=[]).push(listener)}
  setAttribute(name,value){this.attrs[name]=value}
  click(){for(const listener of this.handlers.click||[])listener({target:this})}
  contains(target){return this===target}
}
function fixture(){
  const names=["cardFlow","flowBack","flowNext","flowHome","flowStepLabel","flowStepNumber",
    "menuToggle","toolMenu","menuClose","menuHome","menuGallery","menuReceipts",
    "homeStartMint","homeOpenGallery","debugDockToggle","receiptOverlay",
    "receiptClose","viewUploadStatus"];
  const elements=new Map(names.map(name=>[name,new FakeElement(name)]));
  const cards=new Map(["home","wallet","upload","mint","gallery"].map(name=>[name,new FakeElement(name)]));
  for(const card of cards.values())card.hidden=true;
  elements.get("toolMenu").hidden=true;elements.get("receiptOverlay").hidden=true;
  elements.get("cardFlow").querySelector=selector=>{
    const matched=/^\[data-flow-step="([a-z]+)"\]$/.exec(selector);
    return cards.get(matched?.[1])||null;
  };
  const doc={
    readyState:"complete",getElementById:id=>elements.get(id)||null,
    addEventListener(name,fn){(this.handlers[name]??=[]).push(fn)},
    handlers:{}
  };
  const emitted=[];
  const win={scrollTo:()=>{},dispatchEvent:event=>emitted.push(event.detail)};
  const context={document:doc,window:win,CustomEvent:class{constructor(n,options){this.type=n;this.detail=options?.detail}}};
  vm.runInNewContext(readFileSync("public/flow-nav.js","utf8"),context);
  return {doc,win,elements,cards,emitted};
}
test("app opens on Home and hides four non-active cards without destroying input state",()=>{
  const {win,cards,elements}=fixture();
  assert.equal(win.__xrpmanFlowReady,true);
  assert.equal(win.__xrpmanFlowCurrent(),"home");
  assert.equal(cards.get("home").hidden,false);
  for(const name of ["wallet","upload","mint","gallery"])assert.equal(cards.get(name).hidden,true);
  cards.get("wallet").walletMarker="self-custody-wallet-still-in-memory";
  elements.get("homeStartMint").click();
  assert.equal(cards.get("wallet").hidden,false);
  elements.get("flowNext").click();
  assert.equal(cards.get("upload").hidden,false);
  elements.get("flowBack").click();
  assert.equal(cards.get("wallet").walletMarker,"self-custody-wallet-still-in-memory");
});
test("Next cycles to Pay & Mint then Gallery, Back works and Home always returns",()=>{
  const {win,elements,cards}=fixture();
  for(const target of ["wallet","upload","mint","gallery"])elements.get("flowNext").click();
  assert.equal(win.__xrpmanFlowCurrent(),"gallery");
  assert.equal(cards.get("gallery").hidden,false);
  assert.equal(elements.get("flowNext").hidden,true);
  elements.get("flowBack").click();
  assert.equal(win.__xrpmanFlowCurrent(),"mint");
  elements.get("flowHome").click();
  assert.equal(win.__xrpmanFlowCurrent(),"home");
  assert.equal(win.__xrpmanFlowGo("invalid-step"),false);
});
test("Hamburger opens debug and transaction history without changing minting card",()=>{
  const {win,elements}=fixture();
  win.__xrpmanFlowGo("mint");
  elements.get("menuToggle").click();
  assert.equal(elements.get("toolMenu").hidden,false);
  assert.equal(elements.get("menuToggle").attrs["aria-expanded"],"true");
  elements.get("debugDockToggle").click();
  assert.equal(elements.get("toolMenu").hidden,true);
  assert.equal(win.__xrpmanFlowCurrent(),"mint");
  elements.get("menuToggle").click();
  elements.get("menuReceipts").click();
  assert.equal(elements.get("receiptOverlay").hidden,false);
  assert.equal(elements.get("toolMenu").hidden,true);
  assert.equal(win.__xrpmanFlowCurrent(),"mint");
  elements.get("receiptClose").click();
  assert.equal(elements.get("receiptOverlay").hidden,true);
});
test("persistent View Upload and mint completion navigation only change visibility",()=>{
  const {win,elements,cards}=fixture();
  elements.get("homeOpenGallery").click();
  assert.equal(cards.get("gallery").hidden,false);
  elements.get("viewUploadStatus").click();
  assert.equal(win.__xrpmanFlowCurrent(),"mint");
  cards.get("mint").pendingHash="HASH_IS_UNCHANGED";
  win.__xrpmanFlowGo("gallery");
  win.__xrpmanFlowGo("mint");
  assert.equal(cards.get("mint").pendingHash,"HASH_IS_UNCHANGED");
});
test("all navigation controls, hamburger debug and persistent upload strip exist",()=>{
  const html=readFileSync("index.html","utf8");
  for(const id of ["flowControls","flowNext","flowBack","flowHome","menuToggle","toolMenu",
    "debugDockToggle","menuReceipts","receiptOverlay","persistentUploadStrip",
    "homeSection","walletSection","uploadSection","mintSection","gallerySection"]) {
    assert.ok(html.includes('id="'+id+'"'),"Required card-flow element missing: "+id);
  }
  assert.equal((html.match(/data-flow-step="/g)||[]).length,5);
  assert.match(html,/<script src="\/flow-nav\.js" defer><\/script>/);
  assert.match(html,/Mainnet signing disabled/i);
});
