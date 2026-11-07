const CHUNK_SIZE=1024*1024;
export const EXPORT_DIRECTORY='replaycam-export-temp-v1';

// Keep independent Blob blocks, rather than allocating a full-sized
// ArrayBuffer. Handles the header backpatches made by MP4/WebM muxers.
export function createBlobDestination(chunkSize=CHUNK_SIZE){
  const chunks=new Map();
  let length=0;
  return {
    async write({data,position}){
      if(!Number.isSafeInteger(position)||position<0)throw Error('出力位置が不正です');
      for(let offset=0;offset<data.length;){
        const index=Math.floor((position+offset)/chunkSize),within=(position+offset)%chunkSize;
        const count=Math.min(chunkSize-within,data.length-offset);
        const old=chunks.get(index)||new Blob([]);
        chunks.set(index,new Blob([old.slice(0,within),...(old.size<within?[new Uint8Array(within-old.size)]:[]),data.subarray(offset,offset+count),old.slice(within+count)]));
        offset+=count;
      }
      length=Math.max(length,position+data.length);
    },
    async finish(mime){
      const blocks=[];
      for(let i=0;i<Math.ceil(length/chunkSize);i++)blocks.push(chunks.get(i)||new Blob([new Uint8Array(Math.min(chunkSize,length-i*chunkSize))]));
      const result=new Blob(blocks,{type:mime});chunks.clear();return result;
    },
    async abort(){chunks.clear();}
  };
}

export async function removeExportFile(name){
  if(!/^export-\d+-[a-f0-9-]+$/.test(name||''))return;
  try{
    const root=await navigator.storage.getDirectory();
    const directory=await root.getDirectoryHandle(EXPORT_DIRECTORY);
    await directory.removeEntry(name);
  }catch{/* A previously removed file or unavailable private storage is harmless. */}
}

// Called in the dedicated merge worker. OPFS avoids holding the entire
// exported video in JS memory on mobile. Unsupported browsers use Blob blocks.
export async function createMergeDestination(){
  if(!globalThis.navigator?.storage?.getDirectory)return createBlobDestination();
  const name=`export-${Date.now()}-${crypto.randomUUID()}`;
  let directory,access;
  try{
    directory=await (await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY,{create:true});
    const file=await directory.getFileHandle(name,{create:true});
    if(!file.createSyncAccessHandle){await directory.removeEntry(name);return createBlobDestination();}
    access=await file.createSyncAccessHandle();
    let closed=false;
    const close=async()=>{if(!closed){closed=true;await access.close();}};
    return {
      storageKey:name,
      async write({data,position}){
        let written=0;
        while(written<data.length){
          const count=access.write(data.subarray(written),{at:position+written});
          if(!count)throw Error('動画の一時保存に失敗しました。空き容量を確認してください。');
          written+=count;
        }
      },
      async finish(mime){await access.flush();await close();const blob=await file.getFile();return blob.slice(0,blob.size,mime);},
      async abort(){try{await close();}finally{await directory.removeEntry(name).catch(()=>{});}}
    };
  }catch(error){
    try{await access?.close();}catch{}
    await directory?.removeEntry(name).catch(()=>{});
    if(error.name==='QuotaExceededError')throw Error('結合用の空き容量が不足しています。保存済みの元動画は残っています。');
    return createBlobDestination();
  }
}
