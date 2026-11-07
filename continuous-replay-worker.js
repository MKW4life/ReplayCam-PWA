import {Mp4FragmentCollector} from './mp4-fragments.js';
import {Input,MP4,BlobSource,EncodedPacketSink} from './vendor/mediabunny.js';

const collector=new Mp4FragmentCollector();
let queue=Promise.resolve(),failed=false;
let frames=0,videoFirst=Infinity,videoLast=-Infinity,previousVideo=-Infinity,maxGap=0;
async function sendFragment(blob){
  const input=new Input({source:new BlobSource(blob),formats:[MP4]});
  try{
    const tracks=await input.getTracks();let first=Infinity,last=-Infinity,hasKey=false,keyTime=null;
    for(const track of tracks){
      const sink=new EncodedPacketSink(track),options={metadataOnly:true,skipLiveWait:true};
      const begin=await sink.getFirstPacket(options),end=await sink.getPacket(Infinity,options);
      if(begin&&end){first=Math.min(first,begin.timestamp);last=Math.max(last,end.timestamp+end.duration);}
      if(track.type==='video'){
        const key=await sink.getFirstKeyPacket(options);hasKey=!!key;keyTime=key?.timestamp??null;
        const times=[];
        for await(const packet of sink.packets(undefined,undefined,options)){frames++;videoFirst=Math.min(videoFirst,packet.timestamp);videoLast=Math.max(videoLast,packet.timestamp+packet.duration);times.push(packet.timestamp);}
        times.sort((a,b)=>a-b);
        for(const time of times){if(Number.isFinite(previousVideo)&&time>previousVideo)maxGap=Math.max(maxGap,time-previousVideo);previousVideo=Math.max(previousVideo,time);}
      }
    }
    if(Number.isFinite(first)&&Number.isFinite(last)&&last>first)self.postMessage({type:'fragment',blob,first,last,hasKey,keyTime,stats:{frames,fps:videoLast>videoFirst?frames/(videoLast-videoFirst):0,maxGap}});
  }finally{input.dispose();}
}
self.onmessage=({data})=>{
  queue=queue.then(async()=>{
    if(failed)return;
    const fragments=data.type==='finish'?await collector.finish():await collector.push(data.blob);
    for(const blob of fragments)await sendFragment(blob);
    if(data.type==='finish')self.postMessage({type:'finished'});
  }).catch(error=>{failed=true;self.postMessage({type:'error',message:error.message||String(error)});});
};
