import {removeExportFile} from './merge-destination.js';
const PENDING_KEY='replaycam-pending-exports';
function pendingExports(){try{const value=JSON.parse(sessionStorage.getItem(PENDING_KEY)||'[]');return Array.isArray(value)?value.filter(name=>typeof name==='string'):[];}catch{return [];}}
function rememberExport(key){if(!key)return;try{sessionStorage.setItem(PENDING_KEY,JSON.stringify([...new Set([...pendingExports(),key]) ]));}catch{}}
async function releaseExport(key){
  await removeExportFile(key);
  try{sessionStorage.setItem(PENDING_KEY,JSON.stringify(pendingExports().filter(name=>name!==key)));}catch{}
}
// A reload discards the prepared link, but not the private temporary file.
// Recover this tab's old files without touching exports open in another tab.
for(const key of pendingExports())setTimeout(()=>void releaseExport(key),120000);
export function mergeReplayLocally(blobs,onProgress=()=>{},options={}){
  return new Promise((resolve,reject)=>{
    if(typeof Worker==='undefined'){reject(Error('このブラウザでは動画結合を利用できません。ZIPで保存してください。'));return;}
    const worker=new Worker(new URL('./merge-worker.js',import.meta.url),{type:'module'});
    let storageKey,timer,finished=false;
    const resetTimer=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(Error('結合処理が応答しませんでした。もう一度お試しください。')),180000);};
    function finish(error,blob){
      if(finished)return;finished=true;clearTimeout(timer);worker.terminate();
      if(error){void releaseExport(storageKey);reject(error);}
      else resolve({blob,release:()=>releaseExport(storageKey)});
    }
    resetTimer();
    worker.onmessage=({data})=>{
      resetTimer();
      if(data.type==='destination'){storageKey=data.storageKey;rememberExport(storageKey);}
      else if(data.type==='progress')onProgress(data.done,data.total);
      else if(data.type==='complete')finish(null,data.blob);
      else if(data.type==='error')finish(Error(data.message));
    };
    worker.onerror=event=>{event.preventDefault();finish(Error('この端末で動画を結合できませんでした。ZIPで保存してください。'));};
    worker.onmessageerror=()=>finish(Error('結合結果を読み込めませんでした。ZIPで保存してください。'));
    try{worker.postMessage({blobs,options});}catch(error){finish(error);}
  });
}
