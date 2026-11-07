const NAME = 'replaycam-v1';
const VERSION = 1;
let dbPromise;
export function openDB() {
  if (!dbPromise) {
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(NAME, VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts',{keyPath:'id',autoIncrement:true});
        if (!db.objectStoreNames.contains('saved')) db.createObjectStore('saved',{keyPath:'id'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('データベースを開けません。別のタブを閉じてください。'));
    }).catch(error=>{dbPromise=null;throw error;});
  }
  return dbPromise;
}
async function run(store, mode, handler) {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode);
    const request=handler(tx.objectStore(store));
    let result;
    request.onsuccess=()=>{result=request.result;};
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error || request.error);
    tx.onabort=()=>reject(tx.error || new Error('ストレージ処理が中断されました'));
  });
}
// Persist owned bytes: sliced/composite Blobs can fail WebKit's IndexedDB
// Blob registration, including after crossing a worker boundary. Materialize
// before opening the transaction so asynchronous reads cannot expire it.
export async function addPart(part){
  const {blob,...metadata}=part;
  if(!(blob instanceof Blob))throw Error('保存する動画データを読み取れません');
  const data=await blob.arrayBuffer();
  if(data.byteLength!==blob.size)throw Error('保存する動画データのサイズが一致しません');
  return run('parts','readwrite',store=>store.add({...metadata,data,blobType:blob.type}));
}
export async function getPart(id){
  const part=await run('parts','readonly',store=>store.get(id));
  if(!part)return part;
  if(part.data instanceof ArrayBuffer){
    const {data,blobType,...metadata}=part;
    return {...metadata,blob:new Blob([data],{type:blobType||part.mime||'video/mp4'})};
  }
  // Keep v0.4.0 and earlier recordings readable. Copy old stored Blobs to
  // owned bytes before slicing, worker transfer, ZIP assembly or download.
  if(part.blob instanceof Blob){
    const data=await part.blob.arrayBuffer();
    if(data.byteLength!==part.blob.size)throw Error('保存済み動画の読み出しサイズが一致しません');
    return {...part,blob:new Blob([data],{type:part.blob.type||part.mime||'video/mp4'})};
  }
  return part;
}
export const deletePart=id=>run('parts','readwrite',store=>store.delete(id));
export const listParts=()=>run('parts','readonly',store=>store.getAll());
export const putSaved=item=>run('saved','readwrite',store=>store.put(item));

// The same ordered media parts represent the same available replay snapshot.
// Give them a stable key and check/insert in ONE readwrite transaction so
// repeated taps and automatic recovery cannot create two library entries.
export async function putReplaySnapshot(item){
  const key=new TextEncoder().encode(JSON.stringify({continuous:!!item.continuous,partIds:item.partIds}));
  const digest=await crypto.subtle.digest('SHA-256',key);
  const id='replay-'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('saved','readwrite'),store=tx.objectStore('saved');
    const request=store.get(id);let result;
    request.onsuccess=()=>{
      if(request.result){result={item:request.result,created:false};return;}
      const saved={...item,id};store.add(saved);result={item:saved,created:true};
    };
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error||request.error);
    tx.onabort=()=>reject(tx.error||Error('リプレイの保存が中断されました'));
  });
}

export const getSaved=id=>run('saved','readonly',store=>store.get(id));
export const deleteSaved=id=>run('saved','readwrite',store=>store.delete(id));
export const listSaved=()=>run('saved','readonly',store=>store.getAll());
export async function reclaimParts(liveIds = []) {
  const saved=await listSaved();
  const keep=new Set(liveIds);
  for(const item of saved) for(const id of item.partIds) keep.add(id);
  // ArrayBuffer records contain actual bytes; never load the whole video
  // library just to find orphaned keys.
  const ids=await run('parts','readonly',store=>store.getAllKeys());
  const expired=ids.filter(id=>!keep.has(id));
  for(const id of expired)await deletePart(id);
  return expired.length;
}
