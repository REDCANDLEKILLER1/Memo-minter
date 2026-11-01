// XRPMan Memo Minter — independent card navigation shell.
// Intentionally no access to signing state, wallet keys, receipts, or upload workers.
// Changing cards modifies visibility only; it never unmounts an active application.
(function(){
  "use strict";
  const STEPS=Object.freeze([
    {id:"home",label:"Home",next:"Connect Wallet"},
    {id:"wallet",label:"Connect Wallet",next:"Upload Media"},
    {id:"upload",label:"Upload Media",next:"Pay & Mint"},
    {id:"mint",label:"Pay & Mint",next:"My Gallery"},
    {id:"gallery",label:"My Gallery",next:null}
  ]);
  function boot(){
    const $=id=>document.getElementById(id);
    const page=$("cardFlow"),menu=$("toolMenu"),toggle=$("menuToggle");
    if(!page||!menu||!toggle||!$("flowNext")||!$("flowBack")||!$("flowHome"))return;
    const sections=new Map(STEPS.map(step=>[step.id,page.querySelector('[data-flow-step="'+step.id+'"]')]));
    if([...sections.values()].some(el=>!el))return;
    let current="home";
    function closeMenu(){
      menu.hidden=true;
      toggle.setAttribute("aria-expanded","false");
    }
    function goTo(stepId,{scroll=true}={}){
      const at=STEPS.findIndex(step=>step.id===stepId);
      if(at<0)return false;
      current=stepId;
      for(const [id,section] of sections){
        const active=id===stepId;
        section.hidden=!active;
        section.classList.toggle("is-active",active);
        section.setAttribute("aria-hidden",String(!active));
      }
      const step=STEPS[at];
      $("flowStepLabel").textContent=step.label;
      $("flowStepNumber").textContent=(at+1)+" / "+STEPS.length;
      const back=$("flowBack"),next=$("flowNext");
      back.disabled=at===0;
      next.hidden=!step.next;
      if(step.next)next.textContent="Next: "+step.next;
      const trail=$("flowHome");
      trail.disabled=at===0;
      closeMenu();
      if($("receiptOverlay"))$("receiptOverlay").hidden=true;
      if(scroll) {
        // A card change must NOT affect page visibility, connections or signers.
        try{window.scrollTo({top:0,behavior:"instant"})}
        catch{try{window.scrollTo(0,0)}catch{}}
      }
      window.dispatchEvent?.(new CustomEvent("xrpman:card-change",{detail:{card:stepId}}));
      return true;
    }
    function openMenu(){
      menu.hidden=!menu.hidden;
      toggle.setAttribute("aria-expanded",String(!menu.hidden));
    }
    toggle.addEventListener("click",openMenu);
    $("menuClose")?.addEventListener("click",closeMenu);
    $("menuHome")?.addEventListener("click",()=>goTo("home"));
    $("menuGallery")?.addEventListener("click",()=>goTo("gallery"));
    $("homeStartMint")?.addEventListener("click",()=>goTo("wallet"));
    $("homeOpenGallery")?.addEventListener("click",()=>goTo("gallery"));
    $("flowBack").addEventListener("click",()=>{
      const i=STEPS.findIndex(s=>s.id===current);
      if(i>0)goTo(STEPS[i-1].id);
    });
    $("flowNext").addEventListener("click",()=>{
      const i=STEPS.findIndex(s=>s.id===current);
      if(i>=0&&i<STEPS.length-1)goTo(STEPS[i+1].id);
    });
    $("flowHome").addEventListener("click",()=>goTo("home"));
    $("viewUploadStatus")?.addEventListener("click",()=>goTo("mint"));
    $("menuReceipts")?.addEventListener("click",()=>{
      const receipt=$("receiptOverlay");
      closeMenu();
      if(receipt){receipt.hidden=false;receipt.scrollTop=0}
    });
    $("receiptClose")?.addEventListener("click",()=>{
      if($("receiptOverlay"))$("receiptOverlay").hidden=true;
    });
    $("debugDockToggle")?.addEventListener("click",()=>closeMenu());
    document.addEventListener("keydown",event=>{
      if(event.key!=="Escape")return;
      closeMenu();
      if($("receiptOverlay"))$("receiptOverlay").hidden=true;
    });
    document.addEventListener("click",event=>{
      if(menu.hidden || menu.contains(event.target) || toggle.contains(event.target))return;
      closeMenu();
    });
    // Hand-off for mint completion. This changes only the current visible card.
    window.__xrpmanFlowGo=goTo;
    window.__xrpmanFlowCurrent=()=>current;
    window.__xrpmanFlowReady=true;
    goTo("home",{scroll:false});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});
  else boot();
})();
