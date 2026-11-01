// Early independent debug controls. Loads before the XRPL application bundle.
// This tiny script keeps the debug button working even if the main module fails.
(function () {
  "use strict";
  const KEY = "xrpman-memo-diagnostics-v1";
  function boot() {
    const byId = id => document.getElementById(id);
    const panel = byId("debugPanel");
    const buttons = [byId("ladybugToggle"), byId("debugDockToggle")].filter(Boolean);
    const status = byId("debugHealth");
    if (!panel || buttons.length === 0) return;
    window.__xrpmanDebugBoot = true;
    if (status) status.textContent = "Debug ready · waiting for application";
    const fallback = () => {
      let events = [];
      try {
        const previous = JSON.parse(localStorage.getItem(KEY) || "null");
        if (Array.isArray(previous?.events)) events = previous.events.slice(-350);
      } catch {}
      return {
        app:"XRPMan Memo Minter", version:"debug-bootstrap-fallback",
        exportedAt:new Date().toISOString(), note:"Main app debugger was not available",
        events
      };
    };
    function renderFallback() {
      if (window.__xrpmanDebugReady) {
        if (typeof window.__xrpmanDebugRender === "function") window.__xrpmanDebugRender();
        return;
      }
      const e = byId("debugEntries"), last = byId("debugLast");
      if (last) last.textContent = "Debugger loaded independently; application not yet initialized.";
      if (e) {
        e.replaceChildren();
        const line = document.createElement("div");
        line.textContent = "The debug controls are working. If the app has stalled, choose Download Log to get recent events.";
        e.append(line);
      }
    }
    function showPanel(open) {
      panel.hidden = !open;
      for (const button of buttons) button.setAttribute("aria-expanded",String(open));
      if (open) renderFallback();
    }
    for (const button of buttons) button.addEventListener("click",()=>showPanel(panel.hidden));
    byId("debugClose")?.addEventListener("click",()=>showPanel(false));
    // Main module owns downloads, copy, and clear if available. Fallback is
    // only used when the XRPL module never initialized.
    byId("debugDownload")?.addEventListener("click",()=>{
      if(window.__xrpmanDebugReady)return;
      const blob=new Blob([JSON.stringify(fallback(),null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download="xrpman-debug-fallback.json";a.click();
      setTimeout(()=>URL.revokeObjectURL(url),15000);
    });
    byId("debugCopy")?.addEventListener("click",async()=>{
      if(window.__xrpmanDebugReady)return;
      try{await navigator.clipboard.writeText(JSON.stringify(fallback(),null,2))}
      catch{if(status)status.textContent="Clipboard unavailable; use Download Log"}
    });
    byId("debugClear")?.addEventListener("click",()=>{
      if(window.__xrpmanDebugReady)return;
      if(confirm("Clear locally stored debug events?"))try{localStorage.removeItem(KEY)}catch{}
      renderFallback();
    });
    // If main bundle fails to load, persist only generic failure metadata.
    // Never serialize Error objects, wallet fields, or raw messages.
    function recordBootstrapError(stage,source="",line=0){
      if(window.__xrpmanDebugReady)return;
      try {
        const entry={time:new Date().toISOString(),level:"error",stage,
          details:{source:String(source).split("/").pop().slice(0,70),line:Number(line)||0}};
        const previous=fallback();
        const events=[...previous.events,entry].slice(-350);
        localStorage.setItem(KEY,JSON.stringify({version:1,events}));
        if(status)status.textContent="Debug detected a startup error";
      }catch{}
    }
    window.addEventListener("error",event=>recordBootstrapError("startup.script.error",event.filename,event.lineno));
    window.addEventListener("unhandledrejection",()=>recordBootstrapError("startup.unhandledrejection"));
    window.__xrpmanDebugBootReady = true;
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});
  else boot();
})();
