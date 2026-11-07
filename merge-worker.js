import {mergeReplay} from './merge.js';
import {createMergeDestination} from './merge-destination.js';
self.onmessage=async event=>{
  let destination;
  try{
    destination=await createMergeDestination();
    self.postMessage({type:'destination',storageKey:destination.storageKey});
    const blob=await mergeReplay(event.data.blobs,(done,total)=>self.postMessage({type:'progress',done,total}),destination,event.data.options||{});
    self.postMessage({type:'complete',blob,storageKey:destination.storageKey});
  }catch(error){await destination?.abort();self.postMessage({type:'error',message:error.message||String(error)});}
};
