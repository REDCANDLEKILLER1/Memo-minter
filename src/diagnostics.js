// XRPMan Memo Minter — local-only diagnostics. Never pass a wallet/seed object here.
// No telemetry endpoint; log persistence is limited, redacted and local to this browser.
const KEY = "xrpman-memo-diagnostics-v1";
const LIMIT = 350;
const MAX_FIELD = 500;
const KEY_SECRET = /seed|secret|private|mnemonic|password|tx_blob|signed_blob|signingkey|memodata|filebytes|rawbytes|walletjson|authorization/i;

export function scrubText(raw) {
  let s = String(raw ?? "");
  // XRPL seeds, standalone or embedded inside a message.
  s = s.replace(/\bs[1-9A-HJ-NP-Za-km-z]{15,60}\b/g, "[REDACTED_SEED]");
  s = s.replace(/\b(?:seed|familySeed|privateKey|secret|mnemonic|password|tx_blob|MemoData)\b\s*[:=]\s*["']?[^"'\s,}]+/gi, "[REDACTED_FIELD]");
  // Never retain raw signed transaction blobs or file hex data.
  s = s.replace(/\b[A-Fa-f0-9]{129,}\b/g, "[REDACTED_LONG_HEX]");
  return s.slice(0, MAX_FIELD);
}
export function scrubDetails(value, depth=0) {
  if (depth>3) return "[TRUNCATED]";
  if (value==null || typeof value==="boolean" || typeof value==="number") return value;
  if (typeof value==="string") return scrubText(value);
  if (Array.isArray(value)) return value.slice(0,12).map(v=>scrubDetails(v,depth+1));
  if (typeof value==="object") {
    const out={};
    for (const [key,item] of Object.entries(value).slice(0,24)) {
      out[scrubText(key)] = KEY_SECRET.test(key) ? "[REDACTED]" : scrubDetails(item,depth+1);
    }
    return out;
  }
  return String(typeof value);
}
export function createDiagnosticStore(storage=null, now=()=>new Date().toISOString()) {
  let events=[];
  try {
    const previous=JSON.parse(storage?.getItem(KEY) || "null");
    if(Array.isArray(previous?.events)) events=previous.events.slice(-LIMIT)
      .filter(x=>x && typeof x==="object")
      .map(x=>({
        time:scrubText(x.time),
        level:scrubText(x.level),
        stage:scrubText(x.stage),
        details:scrubDetails(x.details)
      }));
  }catch {}
  const listeners=new Set();
  const notify=()=>{for(const fn of listeners){try{fn()}catch{}}};
  const persist=()=>{try{storage?.setItem(KEY,JSON.stringify({version:1,events}))}catch{}};
  return {
    add(level,stage,details={}) {
      const item={time:now(),level:scrubText(level),stage:scrubText(stage),details:scrubDetails(details)};
      events.push(item);
      if(events.length>LIMIT)events=events.slice(-LIMIT);
      persist();notify();
      return item;
    },
    list(){return events.map(e=>({time:e.time,level:e.level,stage:e.stage,details:scrubDetails(e.details)}))},
    report(){return {app:"XRPMan Memo Minter",version:"0.2.2-debug",exportedAt:now(),network:"LOCAL_DIAGNOSTICS_ONLY",events:this.list()}},
    clear(){events=[];persist();notify()},
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn)}
  };
}
export function mountLadybug(store, doc=document, globalWindow=window) {
  const toggle=doc.getElementById("ladybugToggle");
  const panel=doc.getElementById("debugPanel");
  const items=doc.getElementById("debugEntries");
  const count=doc.getElementById("debugCount");
  const last=doc.getElementById("debugLast");
  if(!toggle || !panel || !items || !count || !last) return;
  const render=()=>{
    const events=store.list();
    const errors=events.filter(e=>e.level==="error").length;
    count.textContent=errors ? String(Math.min(errors,99)) : "";
    count.hidden=!errors;
    const e=events.at(-1);
    last.textContent=e ? "Latest: "+e.stage+" · "+e.level : "Nothing logged yet.";
    if(panel.hidden)return;
    items.replaceChildren();
    for(const item of events.slice(-80).reverse()) {
      const line=doc.createElement("div");
      line.className="debug-entry debug-"+(item.level==="error"?"error":"normal");
      const stamp=doc.createElement("small");
      stamp.textContent=item.time+" · "+item.level.toUpperCase()+" · "+item.stage;
      const detail=doc.createElement("div");
      detail.textContent=JSON.stringify(item.details);
      line.append(stamp,detail);items.append(line);
    }
  };
  toggle.addEventListener("click",()=>{
    panel.hidden=!panel.hidden;
    toggle.setAttribute("aria-expanded",String(!panel.hidden));
    render();
  });
  doc.getElementById("debugClose").addEventListener("click",()=>{
    panel.hidden=true;toggle.setAttribute("aria-expanded","false");
  });
  doc.getElementById("debugDownload").addEventListener("click",()=>{
    const blob=new Blob([JSON.stringify(store.report(),null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=doc.createElement("a");
    a.download="xrpman-debug-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
    a.href=url;a.click();
    globalWindow.setTimeout(()=>URL.revokeObjectURL(url),15000);
  });
  doc.getElementById("debugCopy").addEventListener("click",async()=>{
    try{
      await globalWindow.navigator.clipboard.writeText(JSON.stringify(store.report(),null,2));
      last.textContent="Diagnostic log copied to clipboard.";
    }catch{last.textContent="Copy unavailable. Use Download Log instead.";}
  });
  doc.getElementById("debugClear").addEventListener("click",()=>{
    if(globalWindow.confirm("Clear the local diagnostic history?"))store.clear();
  });
  store.subscribe(render);render();
}
export function installGlobalDiagnostics(store, win=window, doc=document) {
  // Capture console warnings/errors, but never serialize arbitrary objects:
  // SDK objects and responses could contain secret-bearing fields.
  const logger=win.console;
  if(logger)for(const method of ["warn","error"]){
    const original=typeof logger[method]==="function" ? logger[method].bind(logger) : null;
    if(!original)continue;
    logger[method]=(...args)=>{
      try{
        const message=args.slice(0,5).map(arg=>{
          if(typeof arg==="string")return scrubText(arg);
          if(arg instanceof Error)return scrubText(arg.message);
          return "[non-text value omitted]";
        }).join(" ").slice(0,MAX_FIELD);
        store.add(method==="error"?"error":"warn","console."+method,{message});
      }catch{}
      return original(...args);
    };
  }
  win.addEventListener("error",event=>store.add("error","browser.error",{
    message:event.message,source:String(event.filename||"").split("/").pop(),
    line:event.lineno,column:event.colno
  }));
  win.addEventListener("unhandledrejection",event=>store.add("error","browser.unhandledrejection",{
    message:event.reason instanceof Error ? event.reason.message : "Unhandled promise rejection"
  }));
  win.addEventListener("online",()=>store.add("info","browser.online"));
  win.addEventListener("offline",()=>store.add("warn","browser.offline"));
  doc.addEventListener("visibilitychange",()=>store.add("info","browser.visibility",{state:doc.visibilityState}));
}
