// Local binary file reading with real per-byte progress, bounded memory, no remote calls.
export async function readFileWithProgress(file, onProgress=()=>{}, chunkSize=256*1024){
  if(!file || !Number.isSafeInteger(file.size) || file.size<1 || file.size>5*1024*1024)
    throw new Error("Choose a nonempty file of 5 MiB or less");
  if(!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>1024*1024)
    throw new Error("Invalid read chunk size");
  const bytes=new Uint8Array(file.size);
  let loaded=0;
  onProgress(loaded,file.size);
  for(let offset=0;offset<file.size;offset+=chunkSize){
    const blob=file.slice(offset,Math.min(offset+chunkSize,file.size));
    const chunk=new Uint8Array(await blob.arrayBuffer());
    if(chunk.length!==blob.size)throw new Error("Unexpected binary read length");
    bytes.set(chunk,offset);
    loaded+=chunk.length;
    onProgress(loaded,file.size);
  }
  if(loaded!==file.size)throw new Error("Incomplete file read");
  return bytes;
}
