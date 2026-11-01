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

const $ = id => document.getElementById(id);
const SERVERS = Object.freeze({
  testnet: "wss://s.altnet.rippletest.net:51233/",
  devnet: "wss://s.devnet.rippletest.net:51233/"
});
const CHECKPOINT_KEY = "xrpman-memo-vault-test-archive-v1";
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
let estimatedFeeDrops = null, gallerySaving = Promise.resolve(), galleryRefreshCount = 0;

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
  const file=$("sourceFile").files[0];
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
function readTxJson(result){return result.tx_json || result.tx || result.transaction || result;}
function resultCode(result){return typeof result.meta==="string"?result.meta:result.meta?.TransactionResult;}
async function readValidated(hash,expectedType=null){
  trace("tx.lookup",{hash,expectedType});
  const response=await client.request({command:"tx",transaction:hash});
  const result=response.result||{};
  if(result.validated!==true)throw new Error("Transaction not validated: "+hash);
  const tx=readTxJson(result);
  if(expectedType && tx.TransactionType!==expectedType)throw new Error("Unexpected transaction type at "+hash);
  if(resultCode(result)!=="tesSUCCESS")throw new Error("Ledger result "+(resultCode(result)||"unknown")+" for "+hash);
  trace("tx.validated",{hash,type:tx.TransactionType,ledgerIndex:result.ledger_index});
  return {tx,result};
}
async function settlePending(){
  if(!receipt?.pending)return;
  assertConnected();
  const p=receipt.pending;
  trace("tx.reconcile.start",{kind:p.kind,hash:p.hash,entries:p.entries.length});
  const {tx}=await readValidated(p.hash,p.kind==="batch"?"Batch":p.kind==="mint"?"NFTokenMint":"AccountSet");
  if(tx.Account!==receipt.wallet)throw new Error("Validated account differs from receipt");
  if(p.kind==="batch" && (!Array.isArray(tx.RawTransactions)||tx.RawTransactions.length!==p.entries.length))
    throw new Error("Batch content differs from the signed receipt");
  // An outer Batch tesSUCCESS does not prove any inner transaction succeeded.
  for(const entry of p.entries){
    const inner=await readValidated(entry.hash,"AccountSet");
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
  }
  if(p.kind==="mint"){
    const expectedURI=textHex("xrpman://v1/"+receipt.manifest.sha256);
    if(tx.URI!==expectedURI)throw new Error("NFT anchor URI mismatch");
    receipt.nftHash=p.hash;
  }else{
    const complete=new Set(receipt.confirmed.map(e=>e.index));
    for(const e of p.entries)if(!complete.has(e.index))receipt.confirmed.push(e);
    receipt.confirmed.sort((a,b)=>a.index-b.index);
  }
  receipt.outerTransactions.push({kind:p.kind,hash:p.hash,entries:p.entries.map(e=>e.hash)});
  receipt.pending=null;
  saveReceipt();displayReceipt();
  rememberGalleryReceipt(p.kind==="mint" || receipt.confirmed.length===receipt.manifest.totalChunks)
    .then(()=>refreshGallery({scanWallet:p.kind==="mint"})).catch(()=>{});
  txLog("LEDGER VALIDATED "+p.kind.toUpperCase()+" "+p.hash+" ("+p.entries.length+" chunks)");
  trace("tx.reconcile.success",{kind:p.kind,hash:p.hash,entries:p.entries.length});
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
    const response=await client.submitAndWait(signed.tx_blob);
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
      if(id==="prepare" && !$("prepareStatus").classList.contains("error"))
        prepareUI("Preparation failed: "+safeText(e),{error:true});
      if(id==="loadReceipt"||id==="readLedger")$("readStatus").textContent="ERROR: "+safeText(e);
    }finally{syncControls()}
  });
}
$("sourceFile").addEventListener("change",()=>{
  const f=$("sourceFile").files[0];
  if(!f){prepareUI("Select a file, then press Prepare file.");return}
  prepareUI("Selected "+f.name+" · "+f.size.toLocaleString()+" bytes. Press Prepare file.");
  trace("file.selected",{sizeBytes:f.size,mediaType:f.type?.split("/")[0]||"unknown"});
});
on("connect",connectTestWallet);on("importWallet",importWallet);on("forgetWallet",()=>forgetWallet());
on("backupWallet",()=>walletBackup());
on("prepare",prepareFile);on("submit",submitGroups);on("resolve",resolvePendingAction);
on("mint",mintNFT);on("loadReceipt",readReceiptFile);on("readLedger",readLedger);
on("export",()=>{if(receipt)exportJson(receipt,"xrpman-receipt-"+receipt.manifest.sha256.slice(0,16)+".json")});
on("clearCheckpoint",()=>{
  if(!confirm("Discard this browser's saved upload checkpoint? Export its receipt first. This does NOT delete ledger transactions."))return;
  localStorage.removeItem(CHECKPOINT_KEY);receipt=null;rawBytes=null;$("sourceFile").value="";
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
  $("netStatus").textContent="Not connected. Wallet erased from app state on network change.";
  $("networkLabel").textContent=currentNetwork().toUpperCase();
  $("readStatus").textContent="Network changed. Reimport matching receipt.";
  prepareUI("Network changed. Choose the file again after connecting your wallet.");
  trace("network.changed",{network:currentNetwork()});
  syncControls();
});
window.addEventListener("pagehide",()=>{wallet=null});
syncControls();
trace("app.initialized",{version:"0.2.2",network:currentNetwork(),online:navigator.onLine});
txLog("Ready. Testnet / Devnet enabled. Mainnet and background signing disabled.");
