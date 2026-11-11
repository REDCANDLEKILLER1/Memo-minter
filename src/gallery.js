import {validateReceipt} from "./protocol.js";

const DB_NAME="xrpman-memo-gallery-v1";
const STORE="receipts";
const PREFIX="xrpman::";
export function galleryKey(network,archiveId) {
  if(!["testnet","devnet"].includes(network)||!/^[A-F0-9]{64}$/i.test(archiveId))throw new Error("Invalid gallery identity");
  return PREFIX+network+"::"+archiveId.toUpperCase();
}
export function summarizeReceipt(receipt) {
  const m=validateReceipt(receipt);
  return {
    id:galleryKey(m.network,m.archiveId),archiveId:m.archiveId,network:m.network,
    filename:m.filename,mime:m.mime,size:m.size,confirmed:receipt.confirmed.length,
    totalChunks:m.totalChunks,minted:!!receipt.nftHash,nftHash:receipt.nftHash||null,
    nftId:receipt.nftId||null,wallet:receipt.wallet||"",pending:!!receipt.pending
  };
}
export function extractVaultArchiveId(nft) {
  if(!nft || typeof nft.URI!=="string"||!/^[0-9a-f]*$/i.test(nft.URI)||nft.URI.length>512)return null;
  const decoded=new TextDecoder("utf-8",{fatal:true});
  try {
    const array=new Uint8Array(nft.URI.length/2);
    for(let i=0;i<array.length;i++)array[i]=parseInt(nft.URI.slice(2*i,2*i+2),16);
    const url=decoded.decode(array);
    const match=/^xrpman:\/\/v1\/([A-F0-9]{64})$/i.exec(url);
    return match?match[1].toUpperCase():null;
  }catch {return null}
}
// IndexedDB stores only public receipts, never a media file or signing credentials.
// If IndexedDB is denied, callers retain the existing localStorage checkpoint and export option.
export function openGallery(dbApi=globalThis.indexedDB) {
  if(!dbApi) return Promise.reject(new Error("Browser gallery storage unavailable; download receipt JSON for backup"));
  return new Promise((resolve,reject)=>{
    const req=dbApi.open(DB_NAME,1);
    req.onerror=()=>reject(req.error||new Error("Gallery database open failed"));
    req.onupgradeneeded=()=>{
      if(!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE,{keyPath:"id"});
    };
    req.onsuccess=()=>resolve(req.result);
  });
}
function galleryRequest(db,mode,makeRequest){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
    let value,done=false;
    tx.oncomplete=()=>{done=true;resolve(value)};
    tx.onerror=()=>{if(!done)reject(tx.error||new Error("Gallery database error"))};
    tx.onabort=()=>{if(!done)reject(tx.error||new Error("Gallery database abort"))};
    const req=makeRequest(store);
    req.onsuccess=()=>{value=req.result};
    req.onerror=()=>{if(!done)reject(req.error||new Error("Gallery read/write rejected"))};
  });
}
export async function putGalleryReceipt(receipt){
  const meta=summarizeReceipt(receipt),db=await openGallery();
  try{
    // Do not serialize pending signed transaction blobs; only hashes and public fields.
    const record={id:meta.id,updatedAt:new Date().toISOString(),receipt:structuredClone(receipt)};
    await galleryRequest(db,"readwrite",s=>s.put(record));
    return meta;
  }finally{db.close()}
}
export async function getGalleryReceipt(network,archiveId){
  const key=galleryKey(network,archiveId),db=await openGallery();
  try{
    const row=await galleryRequest(db,"readonly",s=>s.get(key));
    if(!row?.receipt)return null;
    summarizeReceipt(row.receipt);
    return row.receipt;
  }finally{db.close()}
}
export async function listGalleryReceipts(){
  const db=await openGallery();
  try{
    const rows=await galleryRequest(db,"readonly",s=>s.getAll());
    return (rows||[]).filter(r=>r?.receipt).map(r=>({receipt:r.receipt,meta:summarizeReceipt(r.receipt),updatedAt:r.updatedAt}))
      .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,150);
  }finally{db.close()}
}
