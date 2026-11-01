import * as xrpl from "xrpl";
import {
  CHUNK_BYTES, MAX_FILE_BYTES, MEMO_TYPE, MANIFEST_MEMO_TYPE,
  toHex, digestHex, manifestFor, encodeChunk, decodeChunk,
  validateReceipt, reassemble
} from "./protocol.js";
import { assertTestNetwork, fundAndVerifyTestWallet, readValidatedDrops } from "./test-wallet.js";
import { createDiagnosticStore, mountLadybug, installGlobalDiagnostics, scrubText } from "./diagnostics.js";
import { readFileWithProgress } from "./file-reader.js";
import { uploadPlan, estimateFeeDrops, assertFeeBudget, runAutoUpload, SERVICE_FEE_DROPS } from "./autopilot.js";
import { putGalleryReceipt, getGalleryReceipt, listGalleryReceipts, summarizeReceipt, extractVaultArchiveId } from "./gallery.js";
import { lookupValidatedTx } from "./ledger-verify.js";
import { mapValidatedParallel, MAX_READ_CONCURRENCY } from "./parallel-verify.js";

const $ = id => document.getElementById(id);
const SERVERS = Object.freeze({
  testnet: "wss://s.altnet.rippletest.net:51233/",
  devnet: "wss://s.devnet.rippletest.net:51233/"
});
const CHECKPOINT_KEY = "xrpman-memo-vault-test-archive-v1";
// Independent read-only peers: NEVER use these to sign/submit transactions.
const READ_SERVERS=Object.freeze({
  testnet:"wss://testnet.honeycluster.io/",
  devnet:"wss://devnet.honeycluster.io/"
});
const MAX_FEE_DROPS = 200000;
const tfAllOrNothing = 65536;
const tfInnerBatchTxn = 1073741824;
const textHex = value => toHex(new TextEncoder().encode(value));
const diagnostics = createDiagnosticStore(window.localStorage);
mountLadybug(diagnostics);installGlobalDiagnostics(diagnostics);
const trace = (stage,details={},level="info") => diagnostics.add(level,stage,details);
const info = text => { $("writeStatus").textContent = scrubText(text); };
const txLog = text => {
  const message = scrubText(text);
  $("txLog").textContent = new Date().toLocaleTimeString()+" "+message+"\n"+$("txLog").textContent.slice(0,10000);
  const level = /ERROR|FAILED|UNRESOLVED|UNCERTAIN|STOPPED|NOT FUNDED|REJECTED/i.test(message) ? "error" : "info";
  trace("ledger.message",{message},level);
};
const checked = () => { if (!$("consent").checked) throw new Error("Confirm the Testnet/Devnet ledger-write disclosure first"); };
const safeText = err => scrubText(err instanceof Error ? err.message : String(err));
let client = null, wallet = null, rawBytes = null, receipt = null;
let readerReceipt = null, busy = false, previewUrl = null, walletFunded = false;
let autoUploadRunning = false, pauseUploadRequested = false, activeAuthorization = null;
let readPeer = null, readPeerNetwork = null, readPeerCooldownUntil = 0;
let estimatedFeeDrops = null, gallerySaving = Promise.resolve(), galleryRefreshCount = 0;
let droppedMediaFile=null, localPreviewURL=null;
function selectedMediaFile(){return droppedMediaFile || $("sourceFile").files[0] || null;}
function showSelectedMediaPreview(file){
  if(localPreviewURL){URL.revokeObjectURL(localPreviewURL);localPreviewURL=null}
  const region=$("selectedPreview");
  region.replaceChildren();
  if(!file)return;
  let media=null;
  if(file.type?.startsWith("image/"))media=document.createElement("img");
  else if(file.type?.startsWith("audio/")){media=document.createElement("audio");media.controls=true}
  else if(file.type?.startsWith("video/")){media=document.createElement("video");media.controls=true}
  if(!media)return;
  localPreviewURL=URL.createObjectURL(file);
  media.src=localPreviewURL;
  media.alt="Selected media (local preview; not yet on XRPL)";
  region.append(media);
}

function currentNetwork() { return $("network").value; }
function syncControls() {
  const hasReceipt = !!receipt;
  const canWrite = !!client?.isConnected() && !!wallet && walletFunded && !!rawBytes &&
    hasReceipt && receipt.wallet===wallet.address && receipt.manifest.network===currentNetwork() &&
    $("consent").checked && !receipt.pending && !busy;
  $("submit").disabled = !canWrite || receipt.confirmed.length>=receipt.manifest.totalChunks;
  $("mint").disabled = !canWrite || receipt.confirmed.length!==receipt.manifest.totalChunks || !!receipt.nftHash;
  $("resolve").disabled = !client?.isConnected() || !receipt?.pending || busy;
  $("export").disabled = !receipt;
  $("prepare").disabled = busy;
  $("sourceFile").disabled = busy;
  $("connect").disabled = busy;
  $("connect").textContent = busy ? "Connecting & funding…" : walletFunded ? "Test Wallet Connected" : wallet ? "Retry Test Wallet" : "Connect Test Wallet";
  $("backupWallet").disabled = !wallet || busy;
  $("network").disabled = busy;
  $("importWallet").disabled = busy;
  $("forgetWallet").disabled = busy;
  $("readLedger").disabled = busy;
  $("autoMint").disabled = busy || !wallet || !walletFunded || !rawBytes || !receipt ||
    receipt.wallet!==wallet.address || receipt.manifest.network!==currentNetwork() ||
    !!receipt.pending || !!receipt.nftHash;
  $("refreshGallery").disabled = busy;
  $("pauseAuto").hidden = !autoUploadRunning;
}
function setBusy(value) { busy = value; syncControls(); }
function saveReceipt() {
  if (receipt) {
    try { localStorage.setItem(CHECKPOINT_KEY,JSON.stringify(receipt)) }
    catch(error) {
      trace("checkpoint.save.error",{message:safeText(error)},"error");
      throw new Error("Cannot save checkpoint. Download a receipt or clear browser storage before uploading.");
    }
  }
  syncControls();
}
function rememberGalleryReceipt(force=false) {
  if(!receipt)return gallerySaving;
  if(!force && receipt.confirmed.length%80!==0 && !receipt.nftHash)return gallerySaving;
  const snapshot=structuredClone(receipt);
  gallerySaving=gallerySaving.catch(()=>{}).then(()=>putGalleryReceipt(snapshot)).catch(error=>{
    trace("gallery.save.error",{message:safeText(error)},"error");
    $("galleryStatus").textContent="Gallery storage unavailable; use Download Archive Receipt for backup.";
  });
  return gallerySaving;
}
function displayReceipt(){
  if (!receipt) return;
  const m=receipt.manifest;
  $("fileName").textContent=m.filename;
  $("fileSize").textContent=m.size.toLocaleString()+" bytes";
  $("chunkCount").textContent=m.totalChunks.toLocaleString();
  $("batchCount").textContent=Math.ceil(m.totalChunks/8).toLocaleString();
  $("doneCount").textContent=receipt.confirmed.length.toLocaleString();
  $("hashShort").textContent=m.sha256.slice(0,16)+"…";
  $("archiveId").textContent="Archive ID: "+m.archiveId;
  $("progress").max=m.totalChunks;
  $("progress").value=receipt.confirmed.length;
  info(receipt.pending?"UNRESOLVED SIGNED TX "+receipt.pending.hash+" — resolve it before further signing."
     : receipt.nftHash?"Archive minted (validated): "+receipt.nftHash
     : receipt.confirmed.length===m.totalChunks?"All chunks validated. You can mint the archive NFT."
     : receipt.confirmed.length+" / "+m.totalChunks+" verified chunks. Resume as needed.");
  syncControls();
}
function exportJson(obj, name){
  const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function assertConnected(){
  if (!client?.isConnected()) throw new Error("Connect the selected non-mainnet XRPL network first");
  if (currentNetwork()!=="testnet" && currentNetwork()!=="devnet") throw new Error("Unsupported network: mainnet disabled");
}
function assertSigner(){
  assertConnected();
  if (!wallet) throw new Error("Import a disposable test wallet JSON first");
  if (!receipt || receipt.wallet!==wallet.address) throw new Error("Uploaded archive wallet must match the loaded signer");
  if (receipt.manifest.network!==currentNetwork())throw new Error("Archive network does not match selected network");
  if (receipt.pending)throw new Error("Previous signed transaction unresolved. Use Resolve Pending first.");
  checked();
}
async function connectNetwork() {
  const selected = currentNetwork();
  assertTestNetwork(selected); // rejects mainnet, even if UI is manipulated
  if (client?.isConnected()) return;
  if (client) { try { await client.disconnect(); } catch {} }
  client = new xrpl.Client(SERVERS[selected], {connectionTimeout:10000, timeout:15000});
  try {
    await client.connect();
    const response = await client.request({command:"server_info"});
    const infoObj=response?.result?.info || {};
    $("networkLabel").textContent=selected.toUpperCase();
    $("netStatus").textContent="Connected to "+selected.toUpperCase()+" node";
    txLog("Network connected: "+selected+" · "+(infoObj.build_version||"version unknown"));
  } catch (error) {
    try { await client.disconnect(); } catch {}
    client=null;
    throw error;
  }
}
function walletBackup() {
  if (!wallet) throw new Error("No test wallet connected");
  assertTestNetwork(currentNetwork());
  if (!wallet.seed) throw new Error("This wallet cannot export an XRPL family seed");
  // Only a local browser download; NEVER upload to the app server or faucet.
  exportJson({
    format:"XRPMan-Disposable-Test-Wallet",version:1,network:currentNetwork(),
    address:wallet.address,seed:wallet.seed
  },"xrpman-"+currentNetwork()+"-wallet-"+wallet.address+".json");
  $("backupStatus").textContent="Test wallet JSON backup download requested. Check your device's Downloads before closing this page.";
}
async function refreshBalance() {
  walletFunded=false;
  if(!wallet || !client?.isConnected()) {
    $("balance").textContent="—";
    syncControls();
    return 0n;
  }
  try {
    const drops=await readValidatedDrops(client,wallet.address);
    walletFunded=drops>0n;
    $("balance").textContent=(Number(drops)/1000000).toFixed(6)+" TEST XRP";
    syncControls();
    return drops;
  } catch (error) {
    $("balance").textContent="Ledger lookup failed";
    walletFunded=false;
    syncControls();
    throw error;
  }
}
function forgetWallet() {
  if(wallet && !confirm("Disconnect this test wallet? Save its JSON backup first if you plan to resume an archive."))
    return;
  wallet=null;walletFunded=false;
  $("walletAddr").textContent="Not loaded";$("balance").textContent="—";
  $("seedFile").value="";
  $("walletState").textContent="Disconnected. Click Connect Test Wallet for a new disposable account.";
  $("netStatus").textContent=client?.isConnected()?"Node connected, no wallet":"Not connected";
  txLog("Wallet cleared from app state. Browser memory cannot be guaranteed erased.");
  syncControls();
}
async function connectTestWallet() {
  if (busy)return;
  setBusy(true);
  const selected=currentNetwork();
  let created=false;
  try {
    assertTestNetwork(selected);
    if(!wallet) {
      // Wallet keys are generated on this device, not by the faucet.
      wallet=xrpl.Wallet.generate();
      created=true;
      walletFunded=false;
      $("walletAddr").textContent=wallet.address;
      $("walletState").textContent="Wallet generated locally · requesting Testnet XRP...";
      // Run backup within the originating click before any asynchronous await.
      walletBackup();
      txLog("Disposable "+selected+" wallet generated: "+wallet.address+" · JSON download requested");
    }
    $("netStatus").textContent="Connecting to "+selected.toUpperCase()+"...";
    await connectNetwork();
    const funding=await fundAndVerifyTestWallet({
      client,wallet,network:selected,
      onStatus: stage => {
        trace("wallet.funding.stage",{stage,network:selected});
        if(stage==="request-faucet")$("walletState").textContent="Requesting free "+selected+" XRP from the test faucet...";
        if(stage==="verify-ledger")$("walletState").textContent="Checking confirmed wallet balance on the "+selected+" ledger...";
      }
    });
    walletFunded=funding.balanceDrops>0n;
    $("balance").textContent=(Number(funding.balanceDrops)/1000000).toFixed(6)+" TEST XRP";
    $("walletState").textContent=walletFunded ? "Testnet wallet connected and funded. Ready to prepare a file." : "Waiting for validated funding.";
    $("netStatus").textContent=walletFunded?"Connected & funded":"Connected · awaiting funds";
    txLog("VALIDATED "+selected+" balance for "+wallet.address+": "+funding.balanceDrops+" drops"+
      (funding.alreadyFunded?" (existing funded account)":" (faucet funded)"));
    info("Test wallet is funded. Choose a file and press Prepare file.");
    refreshGallery().catch(error=>trace("gallery.refresh.error",{message:safeText(error)},"warn"));
    trace("wallet.funded",{balanceDrops:String(funding.balanceDrops),network:selected});
  } catch(error) {
    walletFunded=false;
    trace("wallet.funding.error",{message:safeText(error)},"error");
    $("walletState").textContent="Not funded yet: "+safeText(error);
    $("netStatus").textContent="Not ready · press Retry Test Wallet";
    txLog("WALLET NOT FUNDED: "+safeText(error)+" · same wallet kept for retry");
    // Never silently create a replacement wallet when faucet / network is unavailable.
  } finally {
    setBusy(false);
    if(walletFunded && selectedMediaFile() && !rawBytes) {
      try{await prepareFile()}
      catch(error){trace("file.auto.prepare.error",{message:safeText(error)},"error")}
    }
  }
}
async function importWallet(){
  if (busy)return;
  const file=$("seedFile").files[0];
  if(!file)throw new Error("Choose a local JSON wallet backup file first");
  if(file.size>4096)throw new Error("Wallet JSON over 4 KB is not accepted");
  setBusy(true);
  try{
    const data=JSON.parse(await file.text());
    const seed=data?.seed ?? data?.familySeed ?? data?.wallet?.seed;
    if(typeof seed!=="string" || !/^s[1-9A-HJ-NP-Za-km-z]{15,60}$/.test(seed))
      throw new Error("Wallet JSON must contain an XRPL family seed (s...).");
    assertTestNetwork(currentNetwork());
    if(data?.network && data.network!==currentNetwork())
      throw new Error("Wallet backup is for "+data.network+"; change network before restoring");
    const restored=xrpl.Wallet.fromSeed(seed);
    if(data?.address && data.address!==restored.address)
      throw new Error("Wallet backup address does not match seed");
    wallet=restored;walletFunded=false;
    $("walletAddr").textContent=wallet.address;
    $("seedFile").value="";
    $("walletState").textContent="Wallet restored locally. Press Connect Test Wallet to check and fund if needed.";
    txLog("Test wallet restored locally: "+wallet.address+" (secret not logged)");
    if(client?.isConnected()) {
      try { await refreshBalance(); } catch {
        $("walletState").textContent="Wallet restored; node lookup failed. Use Connect Test Wallet to retry.";
      }
    }
    if(walletFunded) $("walletState").textContent="Test wallet restored and funded. Ready.";
  } finally {setBusy(false);}
}
function prepareUI(message,{active=false,progress=null,error=false,ready=false}={}){
  const status=$("prepareStatus"),work=$("prepareWork"),bar=$("prepareReadProgress");
  status.textContent=message;
  status.classList.toggle("error",error);
  status.classList.toggle("ready",ready);
  work.hidden=!active;
  $("prepareStage").textContent=message;
  if(progress===null){bar.removeAttribute("value")}else{bar.value=progress}
  $("prepare").textContent=active?"Preparing…":"Prepare file";
}
const deferPaint=()=>new Promise(resolve=>setTimeout(resolve,0));
async function prepareFile(){
  if(busy) {
    trace("prepare.blocked",{reason:"another operation active"},"warn");
    return;
  }
  const file=selectedMediaFile();
  if(!file) {
    prepareUI("Select an image, song or other file before pressing Prepare.",{error:true});
    throw new Error("No file selected");
  }
  if(file.size<1 || file.size>MAX_FILE_BYTES) {
    prepareUI("File is empty or exceeds the current 5 MiB limit. Choose a smaller file.",{error:true});
    throw new Error("Allowed file size: 1 byte to 5 MiB (streaming uploads planned later)");
  }
  if(!wallet || !walletFunded) {
    prepareUI("Connect and fund the Test Wallet before preparing the file.",{error:true});
    throw new Error("Press Connect Test Wallet first; funding must be verified");
  }
  try { assertConnected(); }
  catch(error){
    prepareUI("XRPL node is disconnected. Reconnect the Test Wallet and retry.",{error:true});
    throw error;
  }
  setBusy(true);
  const started=performance.now();
  let lastPercent=-1;
  const mediaType=file.type?.split("/")[0]||"unknown";
  trace("prepare.start",{sizeBytes:file.size,mediaType,network:currentNetwork()});
  prepareUI("Preparing your file · reading 0%",{active:true,progress:0});
  try{
    await deferPaint(); // let the progress UI paint before reading/hashing
    const loadedBytes=await readFileWithProgress(file,(loaded,total)=>{
      const percent=Math.round(loaded/total*100);
      prepareUI("Reading image/file: "+percent+"% ("+loaded.toLocaleString()+" / "+total.toLocaleString()+" bytes)",{active:true,progress:percent});
      if(percent===100 || percent>=lastPercent+20){
        lastPercent=percent;
        trace("prepare.read",{percent,loadedBytes:loaded,totalBytes:total});
      }
    });
    prepareUI("File loaded · calculating SHA-256 fingerprint…",{active:true,progress:null});
    trace("prepare.hash.start",{sizeBytes:file.size});
    await deferPaint();
    const hash=await digestHex(loadedBytes);
    trace("prepare.hash.complete",{hash,elapsedMs:Math.round(performance.now()-started)});
    prepareUI("Building upload manifest and checking saved progress…",{active:true,progress:null});
    await deferPaint();
    const manifest=manifestFor(file,hash,currentNetwork());
    const saved=localStorage.getItem(CHECKPOINT_KEY);
    let old=null;
    if(saved) {
      try{old=JSON.parse(saved);validateReceipt(old)}
      catch(error){old=null;trace("prepare.checkpoint.invalid",{reason:safeText(error)},"warn")}
    }
    if(old && old.manifest.archiveId===manifest.archiveId &&
        old.manifest.network===manifest.network && old.wallet===wallet.address){
      if(old.manifest.size!==manifest.size||old.manifest.totalChunks!==manifest.totalChunks)throw new Error("Saved checkpoint conflicts with selected file");
      receipt=old;
      trace("prepare.checkpoint.resumed",{confirmed:old.confirmed.length,total:manifest.totalChunks});
      txLog("Resumed saved checkpoint. "+old.confirmed.length+" chunks already verified.");
    }else{
      if(old && (old.confirmed?.length || old.pending) &&
          !confirm("This browser holds a different upload checkpoint. Export it before starting a new file. Replace checkpoint now?"))
        throw new Error("Kept existing checkpoint");
      receipt={format:"XRPMan-MemoVault-Receipt",version:1,manifest,
        wallet:wallet.address,confirmed:[],outerTransactions:[],pending:null,nftHash:null};
    }
    rawBytes=loadedBytes; // do not overwrite previously active file until the receipt is accepted
    saveReceipt();
    displayReceipt();
    rememberGalleryReceipt(true).then(()=>refreshGallery({scanWallet:false})).catch(()=>{});
    const batches=Math.ceil(manifest.totalChunks/8);
    prepareUI("✓ Prepared successfully: "+manifest.totalChunks.toLocaleString()+
      " memo chunks · about "+batches.toLocaleString()+
      " batches. No transactions submitted yet. Continue to Section 03.",{ready:true});
    trace("prepare.success",{chunks:manifest.totalChunks,batches,hash,elapsedMs:Math.round(performance.now()-started)});
    txLog("File prepared locally: "+manifest.totalChunks+" chunks, "+batches+" estimated batches. Zero ledger writes.");
    $("autoStatus").textContent="File ready! Check the network fee estimate and press Pay & Mint once.";
    updateQuote().catch(error=>trace("quote.error",{message:safeText(error)},"warn"));
  }catch(error){
    prepareUI("Preparation failed: "+safeText(error)+". Tap the ladybug to export the diagnostic log.",{error:true});
    trace("prepare.error",{message:safeText(error),elapsedMs:Math.round(performance.now()-started)},"error");
    throw error;
  }finally{setBusy(false)}
}
function nextIndices(){
  const completed=new Set(receipt.confirmed.map(c=>c.index));
  const out=[];
  for(let i=0;i<receipt.manifest.totalChunks;i++)if(!completed.has(i))out.push(i);
  return out;
}
function memoForChunk(index){
  const begin=index*CHUNK_BYTES;
  const chunk=rawBytes.subarray(begin,Math.min(rawBytes.length,begin+CHUNK_BYTES));
  return [{Memo:{MemoType:textHex(MEMO_TYPE),MemoData:encodeChunk(chunk,receipt.manifest.sha256,index,receipt.manifest.totalChunks)}}];
}
function resultCode(result){return typeof result.meta==="string"?result.meta:result.meta?.TransactionResult;}
async function openReadPeer(){
  const network=currentNetwork();
  if(readPeer?.isConnected() && readPeerNetwork===network)return true;
  if(Date.now()<readPeerCooldownUntil)return false;
  if(readPeer){try{await readPeer.disconnect()}catch{}readPeer=null}
  const url=READ_SERVERS[network];
  if(!url)return false;
  const peer=new xrpl.Client(url,{connectionTimeout:5000,timeout:9000});
  try{
    await peer.connect();
    // Only a read-only connection; all submissions stay on the existing TX client.
    await peer.request({command:"server_info"});
    readPeer=peer;readPeerNetwork=network;
    trace("read.peer.ready",{network,provider:"honeycluster",mode:"read-only"});
    return true;
  }catch(error){
    try{await peer.disconnect()}catch{}
    readPeer=null;readPeerNetwork=null;readPeerCooldownUntil=Date.now()+60000;
    trace("read.peer.unavailable",{network,message:safeText(error),fallback:"primary"},"warn");
    return false;
  }
}
async function readValidated(hash,expectedType=null,{preferReadPeer=false}={}){
  trace("tx.lookup",{hash,expectedType,readLane:preferReadPeer?"standby-preferred":"primary"});
  let usedPeer=false;
  if(preferReadPeer && readPeer?.isConnected() && readPeerNetwork===currentNetwork() &&
     Date.now()>=readPeerCooldownUntil){
    usedPeer=true;
    try {
      const result=await lookupValidatedTx(readPeer,hash,expectedType,{
        attempts:2,initialDelayMs:350,
        onRetry:({attempt,reason})=>trace("read.peer.retry",{hash,attempt,reason},"warn")
      });
      trace("tx.validated",{hash,type:result.tx.TransactionType,ledgerIndex:result.result.ledger_index,
        provider:"honeycluster"});
      return result;
    }catch(error){
      readPeerCooldownUntil=Date.now()+60000;
      trace("read.peer.fallback",{hash,message:safeText(error)},"warn");
      // Missing proof from standby never proves failure. Verify exact hash on primary instead.
    }
  }
  const out=await lookupValidatedTx(client,hash,expectedType,{
    attempts:5,initialDelayMs:800,
    onRetry:({attempt,reason})=>trace("tx.lookup.retry",{hash,attempt,reason},"warn")
  });
  trace("tx.validated",{hash,type:out.tx.TransactionType,ledgerIndex:out.result.ledger_index,
    provider:usedPeer?"primary-fallback":"primary"});
  return out;
}
async function settlePending(){
  if(!receipt?.pending)return;
  assertConnected();
  const started=performance.now();
  const p=receipt.pending;
  trace("tx.reconcile.start",{kind:p.kind,hash:p.hash,entries:p.entries.length});
  if(autoUploadRunning)$("autoStatus").textContent="Verifying ledger confirmation for "+p.kind+"…";
  const {tx}=await readValidated(p.hash,p.kind==="batch"?"Batch":p.kind==="mint"?"NFTokenMint":"AccountSet");
  if(tx.Account!==receipt.wallet)throw new Error("Validated account differs from receipt");
  if(p.kind==="batch" && (!Array.isArray(tx.RawTransactions)||tx.RawTransactions.length!==p.entries.length))
    throw new Error("Batch content differs from the signed receipt");
  // Read-only parallel queries, bounded to 3. Do not advance receipt until ALL
  // inner transaction hashes are validated, even if the outer Batch says tesSUCCESS.
  const validated = await mapValidatedParallel(
    p.entries,
    async(entry,index)=>{
      const inner=await readValidated(entry.hash,"AccountSet",{preferReadPeer:index%2===1});
      if(inner.tx.Account!==receipt.wallet)throw new Error("Inner account mismatch");
      const memo=inner.tx.Memos?.find(m=>m?.Memo?.MemoType===textHex(MEMO_TYPE));
      if(!memo?.Memo?.MemoData)throw new Error("Expected data memo missing at "+entry.hash);
      const data=decodeChunk(memo.Memo.MemoData,receipt.manifest.sha256,entry.index,receipt.manifest.totalChunks);
      const length=Math.min(CHUNK_BYTES,receipt.manifest.size-entry.index*CHUNK_BYTES);
      if(data.length!==length)throw new Error("Validated chunk size mismatch");
      if(rawBytes){
        const original=rawBytes.subarray(entry.index*CHUNK_BYTES,entry.index*CHUNK_BYTES+length);
        if(toHex(data)!==toHex(original))throw new Error("Validated bytes do not match selected file");
      }
      return {index:entry.index,hash:entry.hash};
    },
    MAX_READ_CONCURRENCY,
    ({completed,total})=>{
      if(autoUploadRunning)$("autoStatus").textContent="Verifying "+p.kind+" data: "+completed+" / "+total+
        " transaction"+(total===1?"":"s")+" confirmed…";
    }
  );
  if(p.kind==="mint"){
    const expectedURI=textHex("xrpman://v1/"+receipt.manifest.sha256);
    if(tx.URI!==expectedURI)throw new Error("NFT anchor URI mismatch");
    receipt.nftHash=p.hash;
  }else{
    const complete=new Set(receipt.confirmed.map(e=>e.index));
    for(const entry of validated)if(!complete.has(entry.index))receipt.confirmed.push(entry);
    receipt.confirmed.sort((a,b)=>a.index-b.index);
  }
  receipt.outerTransactions.push({kind:p.kind,hash:p.hash,entries:p.entries.map(e=>e.hash)});
  receipt.pending=null;
  saveReceipt();displayReceipt();
  rememberGalleryReceipt(p.kind==="mint" || receipt.confirmed.length===receipt.manifest.totalChunks)
    .then(()=>refreshGallery({scanWallet:p.kind==="mint"})).catch(()=>{});
  const elapsedMs=Math.round(performance.now()-started);
  txLog("LEDGER VALIDATED "+p.kind.toUpperCase()+" "+p.hash+" ("+p.entries.length+" chunks)");
  trace("tx.reconcile.success",{kind:p.kind,hash:p.hash,entries:p.entries.length,
    verificationMode:"parallel-read-only",readConcurrency:MAX_READ_CONCURRENCY,elapsedMs});
}
async function signAndCommit(tx,kind,indices){
  // Caller has already passed the explicit-gate and pending checks.
  trace("tx.prepare.start",{kind,chunkCount:indices.length,network:currentNetwork()});
  let prepared;
  if(kind==="batch"){
    prepared=await client.autofill(tx);
    if(!Array.isArray(prepared.RawTransactions)||prepared.RawTransactions.length<2||prepared.RawTransactions.length>8)
      throw new Error("Batch inner count must be 2–8");
    for(const {RawTransaction:t} of prepared.RawTransactions){
      if((t.Flags&tfInnerBatchTxn)!==tfInnerBatchTxn || t.Fee!=="0" || t.SigningPubKey!=="" || !Number.isSafeInteger(t.Sequence))
        throw new Error("Batch inner transaction structure invalid — no signing performed");
    }
  }else{
    prepared=await client.autofill(tx);
  }
  if(prepared.Account!==wallet.address)throw new Error("Signer account mismatch");
  if(receipt.pending)throw new Error("An earlier signed transaction remains unresolved — cannot sign a replacement");
  if(!Number.isSafeInteger(Number(prepared.Fee)) || Number(prepared.Fee)<1 || Number(prepared.Fee)>MAX_FEE_DROPS)
    throw new Error("Network fee exceeds the hard cap of 0.2 XRP; submission blocked");
  if(activeAuthorization){
    assertFeeBudget({feeDrops:prepared.Fee,committedDrops:activeAuthorization.committedDrops,
      approvedMaxDrops:activeAuthorization.maxDrops});
  }
  if(!Number.isSafeInteger(prepared.LastLedgerSequence))
    throw new Error("No validated LastLedgerSequence; submission blocked");
  xrpl.validate(prepared);
  const signed=wallet.sign(prepared);
  if(!/^[A-F0-9]{64}$/i.test(signed.hash))throw new Error("Signing failed to produce transaction hash");
  if(activeAuthorization){
    activeAuthorization.committedDrops+=BigInt(prepared.Fee);
    trace("upload.fee.reserved",{feeDrops:String(prepared.Fee),
      committedDrops:String(activeAuthorization.committedDrops),maxDrops:String(activeAuthorization.maxDrops)});
  }
  const entries=(kind==="batch"
    ?prepared.RawTransactions.map((x,i)=>({index:indices[i],hash:xrpl.hashes.hashSignedTx(x.RawTransaction)}))
    :kind==="single"?[{index:indices[0],hash:signed.hash}]:[]);
  trace("tx.signed",{kind,hash:signed.hash,feeDrops:prepared.Fee,chunkCount:entries.length});
  receipt.pending={kind,hash:signed.hash,entries,feeDrops:prepared.Fee,
    sequence:prepared.Sequence,lastLedgerSequence:prepared.LastLedgerSequence};
  saveReceipt();displayReceipt(); // checkpoint BEFORE network submission
  txLog("SIGNED "+kind+" "+signed.hash+" fee="+prepared.Fee+" drops. Submitting...");
  try{
    trace("tx.submit.start",{kind,hash:signed.hash});
    const submitStarted=performance.now();
    if(autoUploadRunning)$("autoStatus").textContent="Submitting ${kind} transaction; waiting for XRPL ledger validation…";
    const response=await client.submitAndWait(signed.tx_blob);
    trace("tx.submit.timing",{kind,hash:signed.hash,elapsedMs:Math.round(performance.now()-submitStarted)});
    const r=response.result||{};
    trace("tx.submit.response",{kind,hash:signed.hash,validated:!!r.validated,result:resultCode(r)||"unknown"});
    if(r.validated && resultCode(r) && resultCode(r)!=="tesSUCCESS")
      throw new Error("Ledger rejected "+kind+": "+resultCode(r));
  }catch(e){
    // Do not replace or retry any signed transaction when submission outcome is unknown.
    txLog("TRANSPORT / SUBMIT OUTCOME UNCERTAIN "+signed.hash+": "+safeText(e));
  }
  await settlePending(); // exact hash must be validated, including every inner
}
async function submitGroups(){
  if(busy)return;
  assertSigner();
  if(!rawBytes)throw new Error("Reselect the original file after browser reload");
  const mode=$("mode").value, maxOuter=Math.min(4,Math.max(1,Number($("perRun").value)||1));
  const remain=nextIndices();if(!remain.length)throw new Error("All chunks confirmed; use Mint NFT");
  const nextEstimate=mode==="batch"?Math.ceil(remain.length/8):remain.length;
  if(!confirm("Submit up to "+Math.min(maxOuter,nextEstimate)+" REAL "+currentNetwork().toUpperCase()+" outer transaction(s) using "+wallet.address+"? Every included memo becomes public permanently. Maximum 0.2 XRP per outer transaction."))return;
  setBusy(true);
  try{
    for(let outer=0;outer<maxOuter;outer++){
      const remaining=nextIndices();if(!remaining.length)break;
      const indices=(mode==="batch" && remaining.length>=2)?remaining.slice(0,8):remaining.slice(0,1);
      const batch=indices.length>=2;
      const inners=indices.map(i=>({
        TransactionType:"AccountSet",Account:wallet.address,
        ...(batch?{Flags:tfInnerBatchTxn}:{}),
        Memos:memoForChunk(i)
      }));
      if(batch){
        const tx={TransactionType:"Batch",Account:wallet.address,Flags:tfAllOrNothing,
          RawTransactions:inners.map(RawTransaction=>({RawTransaction}))};
        await signAndCommit(tx,"batch",indices);
      }else await signAndCommit(inners[0],"single",indices);
      displayReceipt();
    }
    await refreshBalance();
  }catch(e){txLog("STOPPED — "+safeText(e));info("STOPPED: "+safeText(e)+
    (receipt?.pending?"\nHash remains unresolved. DO NOT repeat; use Resolve Pending.":"")); }
  finally{setBusy(false);displayReceipt()}
}
async function resolvePendingAction(){
  if(busy)return;
  setBusy(true);
  try{await settlePending();info("Pending signed transaction is validated and reconciled.");}
  catch(e){txLog("PENDING REMAINS: "+safeText(e));info("Unresolved: "+safeText(e)+". No replacement has been signed.");}
  finally{setBusy(false);displayReceipt()}
}
async function mintNFT(){
  if(busy)return;
  assertSigner();
  if(receipt.confirmed.length!==receipt.manifest.totalChunks)throw new Error("Archive incomplete");
  if(receipt.nftHash)throw new Error("NFT already minted in this receipt");
  const m=receipt.manifest;
  const manifestBytes=new TextEncoder().encode(JSON.stringify(m));
  if(manifestBytes.length>850)throw new Error("Manifest too large for mint memo");
  if(!confirm("Mint a REAL transferable Testnet/Devnet NFT referencing archive SHA-256 "+m.sha256+"? This cannot be undone automatically."))return;
  setBusy(true);
  try{
    const nftTx={
      TransactionType:"NFTokenMint",Account:wallet.address,Flags:8,NFTokenTaxon:0,
      URI:textHex("xrpman://v1/"+m.sha256),
      Memos:[{Memo:{MemoType:textHex(MANIFEST_MEMO_TYPE),MemoData:toHex(manifestBytes)}}]
    };
    await signAndCommit(nftTx,"mint",[]);
    txLog("NFT MINT VERIFIED: "+receipt.nftHash);
  }catch(e){txLog("MINT STOPPED: "+safeText(e));info("Mint not verified: "+safeText(e))}
  finally{setBusy(false);displayReceipt()}
}
async function readReceiptFile(){
  const f=$("receiptFile").files[0];if(!f)throw new Error("Choose a receipt JSON file");
  if(f.size>1500000)throw new Error("Receipt JSON over 1.5MB not supported");
  const obj=JSON.parse(await f.text());validateReceipt(obj);
  readerReceipt=obj;
  await putGalleryReceipt(obj);
  refreshGallery({scanWallet:false}).catch(()=>{});
  $("readStatus").textContent="Loaded "+obj.manifest.filename+": "+obj.confirmed.length+"/"+obj.manifest.totalChunks+
    " data receipts · "+obj.manifest.network.toUpperCase()+" · "+obj.manifest.sha256;
}
async function readLedger(){
  if(busy)return;
  assertConnected();
  const r=readerReceipt;if(!r)throw new Error("Load an XRPMan upload receipt first");
  const m=validateReceipt(r);
  if(m.network!==currentNetwork())throw new Error("Select "+m.network+" to read this receipt; cross-network reads are blocked");
  if(r.confirmed.length!==m.totalChunks)throw new Error("Receipt incomplete; need every transaction hash");
  setBusy(true);
  trace("read.start",{chunks:m.totalChunks,network:m.network});
  try{
    const chunks=new Map();
    for(let n=0;n<r.confirmed.length;n++){
      const entry=r.confirmed[n];
      const {tx}=await readValidated(entry.hash,"AccountSet");
      if(tx.Account!==r.wallet)throw new Error("Source wallet differs from receipt at chunk "+entry.index);
      const memo=tx.Memos?.find(e=>e.Memo?.MemoType===textHex(MEMO_TYPE));
      if(!memo?.Memo?.MemoData)throw new Error("Data memo missing at chunk "+entry.index);
      chunks.set(entry.index,decodeChunk(memo.Memo.MemoData,m.sha256,entry.index,m.totalChunks));
      $("readStatus").textContent="Reading ledger: "+(n+1)+"/"+m.totalChunks+" validated chunks";
      if(n%25===0){trace("read.progress",{verified:n+1,total:m.totalChunks});await new Promise(resolve=>setTimeout(resolve,0))}
    }
    const binary=reassemble(chunks,m);
    const sha=await digestHex(binary);
    if(sha!==m.sha256)throw new Error("Full-file SHA-256 mismatch — file rejected");
    const blob=new Blob([binary],{type:m.mime});
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(blob);
    $("preview").replaceChildren();
    const link=$("downloadFile");link.href=previewUrl;link.download=m.filename;link.hidden=false;link.textContent="Download verified "+m.filename;
    let view=null;
    if(m.mime.startsWith("image/")) view=document.createElement("img");
    else if(m.mime.startsWith("audio/")){view=document.createElement("audio");view.controls=true}
    else if(m.mime.startsWith("video/")){view=document.createElement("video");view.controls=true}
    if(view){view.src=previewUrl;$("preview").append(view)}
    trace("read.success",{chunks:m.totalChunks,hash:sha});
    $("readStatus").textContent="VERIFIED FROM XRPL: "+m.filename+"\n"+m.totalChunks+
      " validated transactions\nSHA-256 "+sha+"\nNetwork: "+m.network;
  }catch(e){trace("read.error",{message:safeText(e)},"error");$("readStatus").textContent="VERIFY FAILED / INCOMPLETE: "+safeText(e)}
  finally{setBusy(false)}
}

const formatDrops = drops => (Number(drops)/1000000).toFixed(6)+" TEST XRP";
async function updateQuote() {
  if(!receipt) {
    $("quotePrice").textContent="Upload a file to calculate the price.";
    $("quoteDetails").textContent="Service charge: 0 Test XRP during testing. Future 2 XRP fee not active.";
    estimatedFeeDrops=null;
    return;
  }
  const plan=uploadPlan(receipt.manifest.totalChunks,receipt.confirmed.length);
  let networkBase=10,approx=true;
  if(client?.isConnected()){
    try{
      const fee=await client.request({command:"fee"});
      const drops=Number(fee.result?.drops?.open_ledger_fee || fee.result?.drops?.base_fee);
      if(Number.isSafeInteger(drops)&&drops>=10&&drops<=100000){networkBase=drops;approx=false;}
    }catch(error){trace("fee.quote.unavailable",{message:safeText(error)},"warn")}
  }
  estimatedFeeDrops=estimateFeeDrops(plan,networkBase);
  $("quotePrice").textContent=plan.outerTransactions+" automatic submission"+(plan.outerTransactions===1?"":"s")+
    " + 1 NFT · estimated network fee "+formatDrops(estimatedFeeDrops);
  $("quoteDetails").textContent=(approx?"Approximate estimate (fee node unavailable). ":"Estimated using current network fees. ")+
    "Platform charge: "+formatDrops(SERVICE_FEE_DROPS)+
    ". Maximum authorized fee budget confirmed before signing; Mainnet disabled.";
  trace("fee.quote",{chunks:plan.remaining,outer:plan.outerTransactions,baseFeeDrops:networkBase,
    estimateDrops:String(estimatedFeeDrops),approx});
}
async function mintApproved(){
  if(receipt?.pending)throw new Error("Cannot mint with unresolved transaction");
  if(receipt?.nftHash)return;
  if(receipt?.confirmed.length!==receipt?.manifest.totalChunks)throw new Error("File is not fully verified yet");
  const m=receipt.manifest;
  const manifestBytes=new TextEncoder().encode(JSON.stringify(m));
  if(manifestBytes.length>850)throw new Error("Manifest is too large");
  const nftTx={
    TransactionType:"NFTokenMint",Account:wallet.address,Flags:8,NFTokenTaxon:0,
    URI:textHex("xrpman://v1/"+m.sha256),
    Memos:[{Memo:{MemoType:textHex(MANIFEST_MEMO_TYPE),MemoData:toHex(manifestBytes)}}]
  };
  trace("upload.mint.start",{archiveId:m.sha256});
  await signAndCommit(nftTx,"mint",[]);
  await rememberGalleryReceipt(true);
  trace("upload.mint.success",{hash:receipt.nftHash});
}
async function startAutoMint(){
  if(busy || autoUploadRunning) return;
  assertConnected();
  if(!wallet||!walletFunded||!receipt||!rawBytes)throw new Error("Connect a funded Test Wallet and select a file first");
  if(receipt.wallet!==wallet.address || receipt.manifest.network!==currentNetwork())
    throw new Error("Uploaded file and wallet/network do not match");
  if(receipt.pending)throw new Error("A signed transaction is unresolved. Use Advanced → Resolve first.");
  if(receipt.nftHash)throw new Error("This archive already has a confirmed NFT mint");
  const expected=await updateQuote();
  const plan=uploadPlan(receipt.manifest.totalChunks,receipt.confirmed.length);
  if(plan.outerTransactions>1500)throw new Error("Upload exceeds the bounded automatic transaction limit");
  const estimate=estimatedFeeDrops||estimateFeeDrops(plan,10);
  const proposed=estimate*5n>100000n?estimate*5n:100000n;
  const maximum=proposed>1000000n?1000000n:proposed;
  if(estimate>maximum)throw new Error("Network fees exceed the 1 Test XRP session cap. Upload blocked.");
  const approval="Pay & Mint on XRPL "+currentNetwork().toUpperCase()+"?\n\n"+
    "File: "+receipt.manifest.filename+"\n"+
    "Remaining batches / outer submissions: "+plan.outerTransactions+"\n"+
    "Estimated network fee including NFT: "+formatDrops(estimate)+"\n"+
    "Maximum fee authorized for this run: "+formatDrops(maximum)+"\n"+
    "Platform charge: 0 Test XRP (the future 2 XRP fee is NOT enabled)\n\n"+
    "Your file is permanently public on this test ledger. The app runs sequentially while this tab stays open. "+
    "It pauses when hidden or offline and stops on any unresolved signed transaction.\n\n"+
    "Approve this complete upload and NFT mint?";
  if(!confirm(approval)){
    trace("upload.approval.declined",{chunks:plan.remaining});
    $("autoStatus").textContent="Nothing submitted. Your file remains prepared.";
    return;
  }
  await openReadPeer(); // optional independent Honeycluster read lane; never a submission path
  activeAuthorization={maxDrops:maximum,committedDrops:0n,archiveId:receipt.manifest.archiveId};
  pauseUploadRequested=false;
  autoUploadRunning=true;
  setBusy(true);
  $("autoMint").textContent="Uploading & verifying…";
  $("autoStatus").textContent="Starting automatically. Keep this tab open. You can pause after the current batch.";
  $("uploadProgress").hidden=false;
  $("uploadProgress").max=receipt.manifest.totalChunks;
  $("uploadProgress").value=receipt.confirmed.length;
  trace("upload.started",{archiveId:receipt.manifest.archiveId,remaining:plan.remaining,
    estimatedFeeDrops:String(estimate),maxApprovedFeeDrops:String(maximum)});
  const currentArchive=receipt.manifest.archiveId;
  try{
    const result=await runAutoUpload({
      getRemaining:()=>nextIndices(),
      maxOuter:1500,
      shouldPause:()=>pauseUploadRequested || document.visibilityState==="hidden" ||
        !navigator.onLine || !client?.isConnected(),
      submitChunkGroup:async(indices)=>{
        if(!activeAuthorization||activeAuthorization.archiveId!==currentArchive)throw new Error("Upload authorization changed");
        if(receipt.pending)throw new Error("Previous signed hash unresolved; upload stopped");
        const batch=indices.length>=2;
        const innerTransactions=indices.map(i=>({
          TransactionType:"AccountSet",Account:wallet.address,
          ...(batch?{Flags:tfInnerBatchTxn}:{}),
          Memos:memoForChunk(i)
        }));
        const transaction=batch?{
          TransactionType:"Batch",Account:wallet.address,Flags:tfAllOrNothing,
          RawTransactions:innerTransactions.map(RawTransaction=>({RawTransaction}))
        }:innerTransactions[0];
        $("autoStatus").textContent="Uploading · "+receipt.confirmed.length.toLocaleString()+
          " / "+receipt.manifest.totalChunks.toLocaleString()+" pieces verified…";
        await signAndCommit(transaction,batch?"batch":"single",indices);
      },
      mint:async()=>{
        $("autoStatus").textContent="Every data chunk verified. Minting the NFT now…";
        await mintApproved();
      },
      onProgress:({sent,remaining})=>{
        $("uploadProgress").value=receipt.confirmed.length;
        $("autoStatus").textContent="Saving to XRPL · "+receipt.confirmed.length.toLocaleString()+
          " / "+receipt.manifest.totalChunks.toLocaleString()+" chunks verified"+
          " · "+remaining.toLocaleString()+" remaining.";
        if(sent%10===0||remaining===0)trace("upload.progress",{outerSubmitted:sent,confirmed:receipt.confirmed.length,remaining});
      },
      yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0))
    });
    if(result.state==="complete"){
      $("autoStatus").textContent="Mint complete! Your file is verified on XRPL. Find it in My Gallery below.";
      trace("upload.complete",{archiveId:currentArchive,nftHash:receipt.nftHash,outerSent:result.sent});
      await rememberGalleryReceipt(true);
      refreshGallery({scanWallet:true}).catch(error=>trace("gallery.refresh.error",{message:safeText(error)},"warn"));
      $("gallerySection").scrollIntoView({behavior:"smooth",block:"start"});
    }else{
      const why=result.state==="limit"?"The maximum batch limit was reached.":"Upload paused to protect your wallet.";
      $("autoStatus").textContent=why+" "+result.remaining+" chunks remain. Tap Pay & Mint to resume with a new fee approval.";
      trace("upload.paused",{state:result.state,remaining:result.remaining,outerSent:result.sent},"warn");
    }
  }catch(error){
    const pending=!!receipt?.pending;
    $("autoStatus").textContent="Upload stopped: "+safeText(error)+
      (pending?"\nA signed transaction is unresolved. Do not restart until it has been verified.":"\nYour verified progress is saved; you can resume safely.");
    trace("upload.stopped",{message:safeText(error),pending,confirmed:receipt?.confirmed?.length||0},"error");
  }finally{
    activeAuthorization=null;
    autoUploadRunning=false;
    $("autoMint").textContent=receipt?.nftHash?"Minted ✓":"Pay & Mint";
    setBusy(false);displayReceipt();
    updateQuote().catch(()=>{});
    await refreshBalance().catch(()=>{});
    rememberGalleryReceipt(true).catch(()=>{});
  }
}
function mediaIcon(mime) {
  if(mime?.startsWith("image/"))return "🖼️";
  if(mime?.startsWith("audio/"))return "♫";
  if(mime?.startsWith("video/"))return "▶";
  if(mime==="application/pdf")return "▣";
  return "▤";
}
async function queryOwnedVaultNfts(){
  if(!wallet||!client?.isConnected())return [];
  const found=[];let marker=null,pages=0;
  do{
    const request={command:"account_nfts",account:wallet.address,ledger_index:"validated",limit:200};
    if(marker)request.marker=marker;
    const response=await client.request(request);
    for(const nft of response.result?.account_nfts||[]) {
      const archiveId=extractVaultArchiveId(nft);
      if(archiveId)found.push({archiveId,network:currentNetwork(),nftId:nft.NFTokenID,
        issuer:nft.Issuer,holder:wallet.address});
    }
    marker=response.result?.marker||null;
    pages++;
  }while(marker&&pages<15);
  if(marker)trace("gallery.nft.scan.partial",{pages}, "warn");
  return found;
}
async function refreshGallery({scanWallet=true}={}){
  const request=++galleryRefreshCount;
  let saved=[];
  try{saved=await listGalleryReceipts()}
  catch(error){
    trace("gallery.storage.error",{message:safeText(error)},"warn");
    $("galleryStatus").textContent="Local gallery storage unavailable. Download the upload receipt for backup.";
  }
  if(receipt){
    try{
      const meta=summarizeReceipt(receipt);
      saved=saved.filter(x=>x.meta.id!==meta.id);
      saved.unshift({receipt:structuredClone(receipt),meta,updatedAt:new Date().toISOString()});
    }catch(error){trace("gallery.checkpoint.invalid",{message:safeText(error)},"warn")}
  }
  let held=[];
  if(scanWallet && wallet && client?.isConnected()){
    try{held=await queryOwnedVaultNfts()}
    catch(error){trace("gallery.nft.scan.error",{message:safeText(error)},"warn")}
  }
  if(request!==galleryRefreshCount)return;
  const ownedByArchive=new Map(held.map(x=>[x.archiveId,x]));
  const items=new Map();
  for(const entry of saved){
    const chain=ownedByArchive.get(entry.meta.archiveId);
    items.set(entry.meta.id,{...entry,chain});
  }
  for(const nft of held){
    const key=nft.network+"::"+nft.archiveId;
    if(![...items.values()].some(e=>e.meta.archiveId===nft.archiveId && e.meta.network===nft.network)){
      items.set(key,{meta:{id:key,archiveId:nft.archiveId,network:nft.network,
        filename:"NFT "+nft.nftId.slice(0,12)+"…",mime:"",size:null,confirmed:0,totalChunks:null,
        minted:true,nftHash:null,nftId:nft.nftId,wallet:nft.holder,pending:false},
        receipt:null,chain:nft});
    }
  }
  const list=[...items.values()];
  const grid=$("galleryGrid");
  grid.replaceChildren();
  for(const item of list){
    const m=item.meta,card=document.createElement("article");
    card.className="gallery-item";
    const icon=document.createElement("div");icon.className="gallery-icon";icon.textContent=mediaIcon(m.mime);
    const name=document.createElement("div");name.className="gallery-title";name.textContent=m.filename;
    const kind=document.createElement("div");kind.className="gallery-type";
    kind.textContent=m.mime||"XRPL NFT · archive receipt needed";
    const state=document.createElement("div");
    const minted=!!m.nftHash || !!item.chain;
    state.className=minted?"status-ready":"status-pending";
    state.textContent=minted?"NFT minted ✓":m.pending?"Transaction awaiting verification":
      m.confirmed===m.totalChunks?"Data stored · NFT pending":"Archive in progress";
    const count=document.createElement("div");count.className="gallery-count";
    count.textContent=m.totalChunks==null?"On-ledger NFT · file index unavailable":
      m.confirmed+" / "+m.totalChunks+" data pieces verified";
    card.append(icon,name,kind,state,count);
    if(item.receipt && item.receipt.confirmed.length===m.totalChunks){
      const view=document.createElement("button");view.type="button";view.textContent="View Media from XRPL";
      view.addEventListener("click",async()=>{
        try{
          if(busy)throw new Error("Another operation is active. Try opening the gallery item after it completes.");
          readerReceipt=item.receipt;
          if(currentNetwork()!==m.network)throw new Error("Switch to "+m.network+" before reading this archive");
          await connectNetwork();await readLedger();
          $("galleryViewer").scrollIntoView({behavior:"smooth",block:"start"});
        }catch(error){
          $("readStatus").textContent="Unable to open: "+safeText(error);
          trace("gallery.open.error",{message:safeText(error)},"error");
        }
      });
      card.append(view);
    }
    if(item.receipt){
      const download=document.createElement("button");download.type="button";
      download.className="secondary";download.textContent="Save Archive Receipt";
      download.addEventListener("click",()=>exportJson(item.receipt,"xrpman-receipt-"+m.archiveId.slice(0,16)+".json"));
      card.append(download);
    }
    const nftId=item.chain?.nftId||m.nftId;
    if(nftId){
      const short=document.createElement("small");short.className="gallery-count";
      short.textContent="NFTokenID: "+nftId.slice(0,16)+"…";
      card.append(short);
    }
    if(!item.receipt){
      const note=document.createElement("small");note.className="gallery-count";
      note.textContent="Import the original archive receipt to reconstruct this NFT's media.";
      card.append(note);
    }
    grid.append(card);
  }
  $("galleryStatus").textContent=list.length?list.length+" saved or wallet-owned archive"+(list.length===1?"":"s")+
    " · files are verified from ledger transaction history when opened.":
    "No archived media yet. Upload a file and mint it to add your first gallery item.";
  trace("gallery.render",{items:list.length,walletNFTs:held.length});
}

function on(id,cb){
  $(id).addEventListener("click",async()=>{
    const started=performance.now();
    trace("ui.action.start",{action:id,network:currentNetwork()});
    try{
      await cb();
      trace("ui.action.complete",{action:id,elapsedMs:Math.round(performance.now()-started)});
    }catch(e){
      trace("ui.action.error",{action:id,message:safeText(e),elapsedMs:Math.round(performance.now()-started)},"error");
      txLog("ERROR "+safeText(e));
      info("ERROR: "+safeText(e));
      if(id==="autoMint")$("autoStatus").textContent="Cannot start: "+safeText(e);
      if(id==="refreshGallery")$("galleryStatus").textContent="Cannot refresh gallery: "+safeText(e);
      if(id==="prepare" && !$("prepareStatus").classList.contains("error"))
        prepareUI("Preparation failed: "+safeText(e),{error:true});
      if(id==="loadReceipt"||id==="readLedger")$("readStatus").textContent="ERROR: "+safeText(e);
    }finally{syncControls()}
  });
}
async function handleMediaSelection(file){
  if(busy) {
    prepareUI("Finish or pause the current upload before selecting another file.",{error:true});
    trace("file.selection.blocked",{reason:"upload active"},"warn");
    return;
  }
  rawBytes=null;syncControls();
  showSelectedMediaPreview(file);
  if(!file){prepareUI("Choose your media to mint.");return}
  prepareUI("Selected "+file.name+" · "+file.size.toLocaleString()+" bytes. Preparing automatically…");
  trace("file.selected",{sizeBytes:file.size,mediaType:file.type?.split("/")[0]||"unknown"});
  if(!wallet || !walletFunded){
    prepareUI("Media selected. Press Connect Test Wallet; preparation starts automatically.");
    return;
  }
  try {await prepareFile()}
  catch(error){trace("file.auto.prepare.error",{message:safeText(error)},"error")}
}
$("sourceFile").addEventListener("change",async()=>{
  droppedMediaFile=null;
  await handleMediaSelection(selectedMediaFile());
});
const dropArea=document.querySelector(".drop-media");
if(dropArea){
  dropArea.addEventListener("dragover",event=>{event.preventDefault();dropArea.classList.add("dragging")});
  dropArea.addEventListener("dragleave",()=>dropArea.classList.remove("dragging"));
  dropArea.addEventListener("drop",async event=>{
    event.preventDefault();dropArea.classList.remove("dragging");
    if(busy){prepareUI("An upload is running. Pause it before choosing a new file.",{error:true});return}
    const file=event.dataTransfer?.files?.[0];
    if(!file)return;
    droppedMediaFile=file;
    $("sourceFile").value="";
    await handleMediaSelection(file);
  });
}
on("connect",connectTestWallet);on("importWallet",importWallet);on("forgetWallet",()=>forgetWallet());
on("backupWallet",()=>walletBackup());
on("prepare",prepareFile);on("autoMint",startAutoMint);on("refreshGallery",()=>refreshGallery());
$("pauseAuto").addEventListener("click",()=>{
  pauseUploadRequested=true;
  $("autoStatus").textContent="Pausing safely after the current transaction is verified…";
  trace("upload.pause.requested");
});
on("submit",submitGroups);on("resolve",resolvePendingAction);
on("mint",mintNFT);on("loadReceipt",readReceiptFile);on("readLedger",readLedger);
on("export",()=>{if(receipt)exportJson(receipt,"xrpman-receipt-"+receipt.manifest.sha256.slice(0,16)+".json")});
on("clearCheckpoint",()=>{
  if(!confirm("Discard this browser's saved upload checkpoint? Export its receipt first. This does NOT delete ledger transactions."))return;
  localStorage.removeItem(CHECKPOINT_KEY);receipt=null;rawBytes=null;droppedMediaFile=null;$("sourceFile").value="";showSelectedMediaPreview(null);
  $("fileName").textContent="—";$("doneCount").textContent="0";$("progress").value=0;
  txLog("Local checkpoint discarded; ledger data remains public.");
  prepareUI("Checkpoint discarded. Select a file and press Prepare.");
  trace("checkpoint.cleared");
});
$("consent").addEventListener("change",syncControls);
$("network").addEventListener("change",async()=>{
  wallet=null;walletFunded=false;rawBytes=null;receipt=null;readerReceipt=null;
  $("walletAddr").textContent="Not loaded";$("balance").textContent="—";
  $("walletState").textContent="Network changed. Press Connect Test Wallet to generate and fund a new test account.";
  $("backupStatus").textContent="The new wallet will request a JSON backup download. Save it for recovery.";
  if(client){try{await client.disconnect()}catch{}client=null}
  if(readPeer){try{await readPeer.disconnect()}catch{}readPeer=null;readPeerNetwork=null}
  readPeerCooldownUntil=0;
  $("netStatus").textContent="Not connected. Wallet erased from app state on network change.";
  $("networkLabel").textContent=currentNetwork().toUpperCase();
  $("readStatus").textContent="Network changed. Reimport matching receipt.";
  $("autoStatus").textContent="Network changed. Connect the test wallet before minting.";
  updateQuote().catch(()=>{});
  refreshGallery({scanWallet:false}).catch(()=>{});
  prepareUI("Network changed. Choose the file again after connecting your wallet.");
  trace("network.changed",{network:currentNetwork()});
  syncControls();
});
window.addEventListener("pagehide",()=>{wallet=null});
window.addEventListener("beforeunload",event=>{
  if(autoUploadRunning){event.preventDefault();event.returnValue="";}
});
document.addEventListener("visibilitychange",()=>{
  if(autoUploadRunning && document.visibilityState==="hidden"){
    pauseUploadRequested=true;
    trace("upload.background.pause",{reason:"tab hidden"},"warn");
  }
});
try{
  const cached=JSON.parse(localStorage.getItem(CHECKPOINT_KEY)||"null");
  if(cached){summarizeReceipt(cached);receipt=cached;displayReceipt();
    $("autoStatus").textContent="Previous archive detected. Restore its test wallet and reselect the same file to resume.";
    trace("checkpoint.restored",{archiveId:receipt.manifest.archiveId,
      confirmed:receipt.confirmed.length,pending:!!receipt.pending});}
}catch(error){trace("checkpoint.restore.error",{message:safeText(error)},"warn")}
updateQuote().catch(()=>{});
refreshGallery({scanWallet:false}).catch(error=>trace("gallery.init.error",{message:safeText(error)},"warn"));
syncControls();
trace("app.initialized",{version:"0.2.2",network:currentNetwork(),online:navigator.onLine});
txLog("Ready. Testnet / Devnet enabled. Mainnet and background signing disabled.");
