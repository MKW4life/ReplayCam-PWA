// At most one next segment is captured while the consumer persists the last
// completed segment. Storage latency must not become a gap in camera capture.
export async function* capturePipeline(recordSegment,isRunning,stopCapture){
  const start=()=>{const promise=Promise.resolve(recordSegment());promise.catch(()=>{});return promise;};
  let pending;
  try{
    pending=start();
    while(pending){
      const item=await pending;
      pending=isRunning()?start():null;
      yield item;
    }
  }finally{
    if(pending){await stopCapture();await pending.catch(()=>{});}
  }
}
