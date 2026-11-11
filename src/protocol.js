// XRPMan Memo Vault v1: pure, deterministic binary chunk protocol.
export const CHUNK_BYTES = 720;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAGIC = new Uint8Array([0x58,0x4d,0x56,0x31]); // XMV1
export const HEADER_BYTES = 28;
export const MEMO_TYPE = "xrpman/chunk-v1";
export const MANIFEST_MEMO_TYPE = "xrpman/manifest-v1";

export function toHex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Expected bytes");
  let result = "";
  for (let i = 0; i < bytes.length; i++) result += bytes[i].toString(16).padStart(2,"0");
  return result.toUpperCase();
}
export function fromHex(value) {
  if (typeof value !== "string" || value.length % 2 || !/^[0-9A-F]*$/i.test(value)) throw new Error("Malformed hex");
  const out = new Uint8Array(value.length/2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i*2,i*2+2),16);
  return out;
}
export async function digestHex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export function manifestFor(file, sha256, network) {
  if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  if (!["testnet","devnet"].includes(network)) throw new Error("Invalid network");
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("File must be between 1 byte and 5 MiB");
  const filename = (file.name || "file.bin").split(/[/\\]/).pop().slice(0,96);
  const mime = (file.type || "application/octet-stream").slice(0,90);
  return {
    protocol:"XRPMan-MemoVault", version:1, network, archiveId:sha256,
    filename,mime,size:file.size,chunkBytes:CHUNK_BYTES,
    totalChunks:Math.ceil(file.size/CHUNK_BYTES),sha256
  };
}
export function encodeChunk(data, sha256, index, total) {
  if (!(data instanceof Uint8Array) || data.length<1 || data.length>CHUNK_BYTES) throw new Error("Chunk length invalid");
  if (!Number.isSafeInteger(index) || index<0 || !Number.isSafeInteger(total) || total<=0 || index>=total) throw new Error("Chunk index invalid");
  const sha=fromHex(sha256);
  if (sha.length!==32) throw new Error("Invalid file hash");
  const packed=new Uint8Array(HEADER_BYTES+data.length);
  packed.set(MAGIC,0); packed.set(sha.subarray(0,16),4);
  const dv=new DataView(packed.buffer);
  dv.setUint32(20,index,false);dv.setUint32(24,total,false);
  packed.set(data,HEADER_BYTES);
  return toHex(packed);
}
export function decodeChunk(hex, sha256, expectedIndex, expectedTotal) {
  const bytes=fromHex(hex);
  if (bytes.length<=HEADER_BYTES || bytes.length>HEADER_BYTES+CHUNK_BYTES) throw new Error("Invalid chunk envelope length");
  for(let i=0;i<4;i++) if(bytes[i]!==MAGIC[i]) throw new Error("Not an XRPMan chunk");
  const sha=fromHex(sha256);
  for(let i=0;i<16;i++) if(bytes[i+4]!==sha[i]) throw new Error("Archive ID mismatch");
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(dv.getUint32(20,false)!==expectedIndex || dv.getUint32(24,false)!==expectedTotal) throw new Error("Chunk index / total mismatch");
  return bytes.slice(HEADER_BYTES);
}
export function validateReceipt(receipt) {
  const m=receipt?.manifest;
  if(!m || m.protocol!=="XRPMan-MemoVault" || m.version!==1 ||
     !["testnet","devnet"].includes(m.network) ||
     !/^[A-F0-9]{64}$/.test(m.sha256) || m.archiveId!==m.sha256 ||
     !Number.isSafeInteger(m.size) || m.size<1 || m.size>MAX_FILE_BYTES ||
     m.chunkBytes!==CHUNK_BYTES || m.totalChunks!==Math.ceil(m.size/CHUNK_BYTES))
    throw new Error("Unsupported or invalid receipt manifest");
  if (!Array.isArray(receipt.confirmed) || receipt.confirmed.length>m.totalChunks) throw new Error("Invalid receipt entries");
  const indices=new Set();
  for(const chunk of receipt.confirmed) {
    if(!Number.isSafeInteger(chunk.index)||chunk.index<0||chunk.index>=m.totalChunks||
      !/^[A-F0-9]{64}$/i.test(chunk.hash)||indices.has(chunk.index))throw new Error("Invalid or repeated chunk receipt");
    indices.add(chunk.index);
  }
  if (receipt.wallet && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(receipt.wallet))throw new Error("Invalid receipt wallet");
  return m;
}
export function reassemble(chunks, manifest) {
  const out=new Uint8Array(manifest.size);
  if (chunks.size!==manifest.totalChunks) throw new Error("Missing chunk receipts");
  let cursor=0;
  for(let i=0;i<manifest.totalChunks;i++){
    const item=chunks.get(i);
    if(!item)throw new Error("Missing chunk "+i);
    const len=Math.min(CHUNK_BYTES,manifest.size-cursor);
    if(item.length!==len) throw new Error("Chunk size mismatch "+i);
    out.set(item,cursor); cursor+=len;
  }
  return out;
}
