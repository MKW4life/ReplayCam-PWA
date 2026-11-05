export function mergeReplayLocally(blobs,onProgress=()=>{}){
  return new Promise((resolve,reject)=>{
    if(typeof Worker==='undefined'){reject(Error('このブラウザでは動画結合を利用できません。ZIPで保存してください。'));return;}
    const worker=new Worker(new URL('./merge-worker.js',import.meta.url),{type:'module'});
    const timer=setTimeout(()=>finish(Error('結合が時間内に完了しませんでした。ZIPで保存してください。')),180000);
    function finish(error,blob){clearTimeout(timer);worker.terminate();error?reject(error):resolve(blob);}
    worker.onmessage=({data})=>{
      if(data.type==='progress')onProgress(data.done,data.total);
      else if(data.type==='complete')finish(null,data.blob);
      else if(data.type==='error')finish(Error(data.message));
    };
    worker.onerror=event=>{event.preventDefault();finish(Error('この端末で動画を結合できませんでした。ZIPで保存してください。'));};
    worker.onmessageerror=()=>finish(Error('結合結果を読み込めませんでした。ZIPで保存してください。'));
    try{worker.postMessage({blobs});}catch(error){finish(error);}
  });
}
