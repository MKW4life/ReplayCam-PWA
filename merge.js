import {Input,MP4,WEBM,BlobSource,Output,StreamTarget,Mp4OutputFormat,WebMOutputFormat,EncodedPacketSink,EncodedVideoPacketSource,EncodedAudioPacketSource} from './vendor/mediabunny.js';
import {createBlobDestination} from './merge-destination.js';
import {joinContinuousFragments} from './mp4-fragments.js';

function configKey(config){
  if(!config)return null;
  const {description,...rest}=config;
  return JSON.stringify({...rest,description:description?Array.from(new Uint8Array(description.buffer||description,description.byteOffset||0,description.byteLength)):null});
}

// Remux encoded packets, retaining both tracks and their relative timing.
// No decoder, encoder, network request or video upload is involved.
export async function mergeReplay(blobs,onProgress=()=>{},destination=createBlobDestination(),options={}){
  if(!blobs.length)throw Error('録画区間がありません');
  let output,videoSource,audioSource,baseline,offset=0,mime;
  try{
    const originalCount=blobs.length;
    if(options.continuous)blobs=[await joinContinuousFragments(blobs)];
    for(let i=0;i<blobs.length;i++){
      const input=new Input({source:new BlobSource(blobs[i]),formats:[MP4,WEBM]});
      try{
        const video=await input.getPrimaryVideoTrack();
        const audio=await input.getPrimaryAudioTrack();
        if(!video)throw Error('動画トラックを読み取れません。ZIPで保存してください。');
        const videoCodec=await video.getCodec(),audioCodec=audio?await audio.getCodec():null;
        const videoConfig=await video.getDecoderConfig(),audioConfig=audio?await audio.getDecoderConfig():null;
        const rotation=await video.getRotation();
        if(!videoCodec||!videoConfig||(audio&&(!audioCodec||!audioConfig)))throw Error('対応していない動画形式です。ZIPで保存してください。');
        const signature=JSON.stringify([videoCodec,audioCodec,configKey(videoConfig),configKey(audioConfig),rotation]);
        if(i===0){
          baseline=signature;
          const mp4=['avc','hevc','av1'].includes(videoCodec);
          mime=mp4?'video/mp4':'video/webm';
          output=new Output({format:mp4?new Mp4OutputFormat({fastStart:false}):new WebMOutputFormat(),target:new StreamTarget(new WritableStream({write:chunk=>destination.write(chunk)}),{chunked:true,chunkSize:1024*1024})});
          videoSource=new EncodedVideoPacketSource(videoCodec);
          output.addVideoTrack(videoSource,{rotation});
          if(audio){audioSource=new EncodedAudioPacketSource(audioCodec);output.addAudioTrack(audioSource);}
          await output.start();
        }else if(signature!==baseline){
          throw Error('区間ごとに動画・音声の形式や設定が異なります。ZIPで保存してください。');
        }
        const videoSink=new EncodedPacketSink(video),readOptions={skipLiveWait:true};
        let firstKey=null,endKey=null,cutoff=Infinity;
        if(options.continuous){
          firstKey=await videoSink.getKeyPacket(Math.max(0,options.startTime||0),readOptions)||await videoSink.getFirstKeyPacket(readOptions);
          if(!firstKey)throw Error('まだ保存可能な映像がありません。数秒後にもう一度保存してください。');
          if(Number.isFinite(options.endTime)&&firstKey.timestamp>=options.endTime)throw Error('指定した時点までに再生可能な映像がありません');
          if(Number.isFinite(options.endTime)){
            const prior=await videoSink.getKeyPacket(options.endTime,readOptions);
            endKey=prior&&prior.timestamp>=options.endTime?prior:prior?await videoSink.getNextKeyPacket(prior,readOptions):null;
            if(endKey)cutoff=endKey.timestamp;
          }
        }
        const origin=firstKey?firstKey.timestamp:await input.getFirstTimestamp();
        if(!Number.isFinite(origin))throw Error('動画の時刻を読み取れません');
        const streams=[{track:video,source:videoSource,config:videoConfig},...(audio?[{track:audio,source:audioSource,config:audioConfig}]:[])];
        let end=0;
        try{
          for(const s of streams){
            const sink=new EncodedPacketSink(s.track);
            const start=options.continuous?(s.track===video?firstKey:await sink.getPacket(origin,readOptions)||await sink.getFirstPacket(readOptions)):undefined;
            s.iterator=sink.packets(start,s.track===video?endKey||undefined:undefined,readOptions);
            s.next=await s.iterator.next();s.count=0;
          }
          if(streams[0].next.done||streams[0].next.value.type!=='key'||streams.some(s=>s.next.done))throw Error('動画または音声の区間が不完全です。ZIPで保存してください。');
          while(streams.some(s=>!s.next.done)){
            // Merge tracks without buffering a whole audio/video track. Each
            // iterator remains in decode order, including video B frames.
            const active=streams.filter(s=>!s.next.done).sort((a,b)=>a.next.value.timestamp-b.next.value.timestamp);
            const s=active[0],packet=s.next.value;
            if(options.continuous&&packet.timestamp>=cutoff){s.next={done:true};continue;}
            const timestamp=packet.timestamp-origin;
            end=Math.max(end,timestamp+packet.duration);
            await s.source.add(packet.clone({timestamp:offset+timestamp,sequenceNumber:-1}),s.count===0?{decoderConfig:s.config}:undefined);
            s.count++;s.next=await s.iterator.next();
            if(s.count%256===0)onProgress(options.continuous?0:i,originalCount);
          }
        }finally{for(const s of streams)await s.iterator?.return();}
        if(!(end>0))throw Error('録画時間を読み取れません');
        offset+=end;
        onProgress(options.continuous?originalCount:i+1,originalCount);
      }finally{input.dispose();}
    }
    videoSource.close();audioSource?.close();
    await output.finalize();
    return await destination.finish(mime);
  }catch(error){
    await output?.cancel().catch(()=>{});
    await destination.abort();
    throw error;
  }
}
