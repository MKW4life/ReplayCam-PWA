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
export const addPart=part=>run('parts','readwrite',store=>store.add(part));
export const getPart=id=>run('parts','readonly',store=>store.get(id));
export const deletePart=id=>run('parts','readwrite',store=>store.delete(id));
export const listParts=()=>run('parts','readonly',store=>store.getAll());
export const putSaved=item=>run('saved','readwrite',store=>store.put(item));
export const getSaved=id=>run('saved','readonly',store=>store.get(id));
export const deleteSaved=id=>run('saved','readwrite',store=>store.delete(id));
export const listSaved=()=>run('saved','readonly',store=>store.getAll());
export async function reclaimParts(liveIds = []) {
  const saved=await listSaved();
  const keep=new Set(liveIds);
  for(const item of saved) for(const id of item.partIds) keep.add(id);
  const parts=await listParts();
  for(const part of parts) if(!keep.has(part.id)) await deletePart(part.id);
  return parts.filter(part=>!keep.has(part.id)).length;
}
