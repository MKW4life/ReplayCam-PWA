import {mergeReplay} from './merge.js';
self.onmessage=async event=>{
  try{
    const blob=await mergeReplay(event.data.blobs,(done,total)=>self.postMessage({type:'progress',done,total}));
    self.postMessage({type:'complete',blob});
  }catch(error){self.postMessage({type:'error',message:error.message||String(error)});}
};
