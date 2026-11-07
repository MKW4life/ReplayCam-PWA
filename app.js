import {SEGMENT_LENGTH_MS, safeSettings, formatDuration, formatBytes, chooseMimeType, extensionFor, selectReplayParts, selectContinuousParts, fileStamp, resolutionDimensions, targetVideoBitrate, estimateRecordingBytes, cameraLabel, captureOrientation, orientationLabel, containedFrame} from './lib.js';
import {openDB, addPart, getPart, deletePart, putSaved, putReplaySnapshot, deleteSaved, listSaved, reclaimParts} from './storage.js';
import {createZip} from './zip.js';
import {requestCamera} from './camera.js';
import {capturePipeline} from './replay-pipeline.js';
import {mergeReplayLocally} from './merge-client.js';

const el=id=>document.getElementById(id);
const ui={
  viewfinder:el('viewfinder'),frame:el('capture-boundary'),frameNote:el('frame-note'),orientationStatus:el('orientation-status'),fpsStatus:el('capture-fps'),shareVideo:el('share-video'),shareHelp:el('share-help'),
  video:el('camera'),empty:el('empty-camera'),start:el('start-button'),save:el('save-button'),stop:el('stop-button'),
  modeReplay:el('mode-replay'),modeStandard:el('mode-standard'),duration:el('duration'),resolution:el('resolution'),
  fps:el('fps'),audio:el('audio'),facing:el('facing'),cameraStatus:el('camera-status'),estimate:el('capacity-estimate'),estimateDetail:el('capacity-detail'),elapsed:el('elapsed'),counter:el('buffer-counter'),
  indicator:el('record-indicator'),state:el('record-state'),facts:el('camera-facts'),settingsNote:el('settings-note'),
  durationField:el('duration-field'),modeExplanation:el('mode-explanation'),storage:el('storage-display'),
  library:el('library-items'),refresh:el('refresh-library'),connection:el('connection'),connectionLabel:el('connection-label'),
  toast:el('toast'),dialog:el('clip-dialog'),dialogClose:el('dialog-close'),clipTitle:el('clip-title'),
  clipDescription:el('clip-description'),exportAll:el('export-all'),deleteClip:el('delete-clip'),exportZip:el('export-zip'),
  segments:el('segment-list'),playback:el('clip-playback'),exportProgress:el('export-progress'),downloadResult:el('download-result')
};

let settings=safeSettings(readSettings());
let mode='replay';
let stream=null;
let recorder=null;
let running=false;
let starting=false;
let stopping=false;
let savingReplay=false;
let pendingReplaySave=false;
let captureSequence=0;
let activeSegmentSequence=0;
let pendingSaveSequence=0;
let continuousReplay=false;
let pendingMediaTime=0;
let recordingStats=null;
let currentMediaType='';
let lockedMediaType='';
let startedAt=0;
let liveParts=[];
let selectedItem=null;
let previewURL=null;
let downloadURL=null;
let preparedFile=null;
let releasePrepared=null;
let sharing=false;
let toastTimeout=0;
let libraryBusy=false;
let exporting=false;
let deletingClip=false;
let measuredBytes=0;
let measuredSeconds=0;
let wasHiddenDuringRecording=false;
let recordingOrientation='unknown';
let rotationStopped=false;
const landscapeQuery=window.matchMedia('(orientation: landscape)');

function readSettings(){try{return JSON.parse(localStorage.getItem('replaycam-settings')||'{}');}catch{return {};}}
function storeSettings(){try{localStorage.setItem('replaycam-settings',JSON.stringify(settings));}catch{/* Storage may be disabled. */}}
function toast(message,time=4500){
  ui.toast.textContent=message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout=setTimeout(()=>ui.toast.classList.remove('show'),time);
}
function setMode(next){
  if(running||starting||stopping)return;
  mode=next;
  updateControls();
}
function updateControls(){
  const busy=running||starting||stopping;
  const isReplay=mode==='replay';
  ui.modeReplay.classList.toggle('active',isReplay);
  ui.modeStandard.classList.toggle('active',!isReplay);
  ui.modeReplay.setAttribute('aria-pressed',String(isReplay));
  ui.modeStandard.setAttribute('aria-pressed',String(!isReplay));
  ui.modeReplay.disabled=busy;
  ui.modeStandard.disabled=busy;
  for(const input of [ui.duration,ui.resolution,ui.fps,ui.audio,ui.facing])input.disabled=busy;
  ui.durationField.hidden=!isReplay;
  ui.counter.textContent=isReplay?`保存範囲 ${settings.duration}:00`:'連続録画';
  ui.save.hidden=!isReplay;
  ui.save.querySelector('span:last-child').textContent=savingReplay?'保存処理中…':'直前を保存';
  ui.start.disabled=busy;
  ui.stop.disabled=!running||stopping;
  ui.save.disabled=!running||stopping||savingReplay||!isReplay;
  ui.stop.textContent=isReplay?'停止':'終了して保存';
  ui.start.querySelector('span:last-child').textContent=starting?'カメラ起動中…':'録画開始';
  ui.state.textContent=starting?'接続中':stopping?'終了処理中':running?(isReplay?(continuousReplay?'連続BUFFER':'BUFFER'):'REC'):'待機';
  ui.indicator.classList.toggle('active',running);
  ui.settingsNote.textContent=busy?'録画中は変更できません':'録画前に設定';
  document.getElementById('quality-note').hidden=settings.resolution<1440;
  ui.modeExplanation.textContent=isReplay
    ?`直前${settings.duration}分を残すには「直前を保存」`
    :'開始から停止までを1本の動画で保存';
  ui.resolution.value=String(settings.resolution);
  ui.fps.value=String(settings.fps);
  ui.duration.value=String(settings.duration);
  ui.audio.value=settings.audio?'on':'off';
  ui.facing.value=settings.facing;
  updateEstimate();
  updateCameraStatus();
  updateOrientationStatus();
  updateFpsStatus();
}
function updateEstimate(){
  const observed=running&&measuredSeconds>0?{bytes:measuredBytes,seconds:measuredSeconds}:null;
  const seconds=mode==='replay'?settings.duration*60:60;
  const bytes=estimateRecordingBytes(settings,seconds,observed);
  ui.estimate.textContent=mode==='replay'?`直前${settings.duration}分の予想容量：約${formatBytes(bytes)}`:`通常録画1分あたり：約${formatBytes(bytes)}`;
  ui.estimateDetail.textContent=(observed?'容量は録画中の実測から推定。':'容量は画質・fpsからの概算。')+'映像の内容で変わります。';
}
function updateCameraStatus(){
  const actual=stream?.getVideoTracks()[0]?.getSettings?.()||{};
  ui.cameraStatus.textContent=stream?`使用中：${cameraLabel(actual.facingMode)} · 希望：${cameraLabel(settings.facing)}`:`選択中：${cameraLabel(settings.facing)}`;
}
function updateFpsStatus(){
  const actual=stream?.getVideoTracks()[0]?.getSettings?.()||{};
  ui.fpsStatus.textContent=stream
    ?`希望 ${settings.fps}fps / カメラ設定 ${actual.frameRate?'約'+Math.round(actual.frameRate)+'fps':'未確認'}。保存動画の実際のfpsは端末や録画処理にも依存します。`
    :`希望 ${settings.fps}fps。カメラの対応状況は録画開始時に確認します。`;
  if(recordingStats?.frames)ui.fpsStatus.textContent+=` ${running?'録画データ':'直前の録画データ'}：平均${recordingStats.fps.toFixed(1)}fps / 最大フレーム間隔${recordingStats.maxGap.toFixed(2)}秒。`;
}
function actualOrientation(){
  const actual=stream?.getVideoTracks()[0]?.getSettings?.()||{};
  return captureOrientation(ui.video.videoWidth||actual.width,ui.video.videoHeight||actual.height);
}
function updateCaptureBoundary(){
  const frame=stream?containedFrame(ui.viewfinder.clientWidth,ui.viewfinder.clientHeight,ui.video.videoWidth,ui.video.videoHeight):null;
  ui.frame.hidden=!frame;
  if(frame){for(const [key,value] of Object.entries(frame))ui.frame.style[key]=`${value}px`;}
  ui.frameNote.textContent=frame?'白枠内を保存':'白枠が録画範囲です';
}
function updateOrientationStatus(){
  const orientation=stream?actualOrientation():(landscapeQuery.matches?'landscape':'portrait');
  ui.orientationStatus.textContent=stream
    ?`${orientationLabel(orientation)}${running?'で録画中':'のカメラ映像'}`
    :`端末：${orientationLabel(orientation)} · 録画開始前に向きを合わせてください`;
  const actual=stream?.getVideoTracks()[0]?.getSettings?.()||{};
  const width=ui.video.videoWidth||actual.width,height=ui.video.videoHeight||actual.height;
  if(width>0&&height>0)ui.viewfinder.style.setProperty('--camera-ratio',`${width} / ${height}`);
  else ui.viewfinder.style.removeProperty('--camera-ratio');
  updateCaptureBoundary();
}
function handleDeviceRotation(){
  updateOrientationStatus();
  if(!running||stopping)return;
  rotationStopped=true;
  // Replay normally discards the unsaved buffer when stopped. Snapshot it
  // before stopping so rotating the phone cannot discard the current take.
  if(mode==='replay')requestReplaySave();
  stopRecording();
  toast('端末の向きが変わったため録画を終了します。保存済みを確認してから再開してください。',8000);
}
function handleVideoResize(){
  setCameraFacts();
  const current=actualOrientation();
  if(running&&recordingOrientation!=='unknown'&&current!=='unknown'&&current!==recordingOrientation)handleDeviceRotation();
}
function setCameraFacts(){
  updateFpsStatus();
  updateCameraStatus();
  updateOrientationStatus();
  const track=stream?.getVideoTracks()[0];
  const actual=track?.getSettings?.()||{};
  if (!stream){ui.facts.textContent='—';return;}
  const width=ui.video.videoWidth||actual.width,height=ui.video.videoHeight||actual.height;
  const d=(width&&height)?`${width}×${height}`:'解像度未確認';
  const f=actual.frameRate?` · カメラ約${Math.round(actual.frameRate)}fps`:' · fps未確認';
  ui.facts.textContent=`${d}${recordingStats?.frames?' · 保存'+recordingStats.fps.toFixed(1)+'fps':f}`;
}
function releaseCamera(){
  const old=stream;stream=null;
  ui.video.srcObject=null;
  if(old)for(const track of old.getTracks()){track.onended=null;track.stop();}
  ui.empty.hidden=false;
  setCameraFacts();
}
async function enableCamera(){
  if(stream && stream.active)return;
  if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
    throw new Error('カメラはHTTPS上でのみ利用できます。HTTPSで公開したURLをSafariで開いてください。');
  }
  if(typeof MediaRecorder==='undefined')throw new Error('このブラウザはMediaRecorderに対応していません。');
  const dimensions=resolutionDimensions(settings.resolution);
  const video={
    facingMode:{ideal:settings.facing},
    width:{ideal:dimensions.width},
    height:{ideal:dimensions.height},
    frameRate:{ideal:settings.fps,max:settings.fps}
  };
  const audio=settings.audio?{echoCancellation:false,noiseSuppression:false,autoGainControl:false}:false;
  try{stream=await requestCamera(navigator.mediaDevices,video,audio);}
  catch(error){
    if(audio){
      try{
        stream=await requestCamera(navigator.mediaDevices,video,false);
        settings.audio=false;storeSettings();
        toast('マイクが使えなかったため、音声なしで録画します。',6500);
        updateControls();
      }catch{throw error;}
    }else throw error;
  }
  const videoTrack=stream.getVideoTracks()[0];
  if(!videoTrack)throw new Error('カメラ映像を取得できませんでした');
  for(const track of stream.getTracks())track.onended=()=>{
    if(running){toast('カメラまたはマイクが中断されました。録画を終了します。',6500);stopRecording();}
  };
  ui.video.srcObject=stream;
  ui.empty.hidden=true;
  try{await ui.video.play();}catch{/* autoplay is not always permitted */}
  setCameraFacts();
  const actual=videoTrack.getSettings?.()||{};
  if(actual.width&&actual.height&&Math.min(actual.width,actual.height)<settings.resolution)toast(`希望の解像度に届かないため、実際は${actual.width}×${actual.height}で録画します。`,6500);
  if(actual.facingMode&&actual.facingMode!==settings.facing)toast(`選択したカメラは使えず、${cameraLabel(actual.facingMode)}を使用します。`,6500);
  if(actual.frameRate && actual.frameRate < settings.fps-5)toast(`カメラ設定は約${Math.round(actual.frameRate)}fpsです（希望${settings.fps}fps）。この解像度・ブラウザでは希望値に届いていません。`,6000);
}
function makeRecorder(){
  const mime=lockedMediaType||chooseMimeType();
  const targetBitrate=targetVideoBitrate(settings);
  let instance;
  try{
    instance=new MediaRecorder(stream,{
      ...(mime?{mimeType:mime}:{}),
      videoBitsPerSecond:targetBitrate,
      audioBitsPerSecond:128_000,
      ...(mode==='replay'?{videoKeyFrameIntervalDuration:1000}:{})
    });
  }catch{
    try{instance=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:targetBitrate,audioBitsPerSecond:128_000});}
    catch{instance=new MediaRecorder(stream,mime?{mimeType:mime}:{});}
  }
  currentMediaType=instance.mimeType||mime||'video/mp4';
  return instance;
}
function recordSegment(){
  const sequence=++captureSequence;
  activeSegmentSequence=sequence;
  return new Promise((resolve,reject)=>{
    const chunks=[];
    const itemStart=Date.now();
    let timer=0,done=false;
    let instance;
    try{instance=makeRecorder();}catch(error){reject(error);return;}
    recorder=instance;
    function fail(error){
      if(done)return;done=true;clearTimeout(timer);
      if(recorder===instance)recorder=null;
      reject(error);
    }
    instance.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
    instance.onerror=e=>fail(e.error||new Error('動画の録画に失敗しました'));
    instance.onstop=()=>{
      if(done)return;done=true;clearTimeout(timer);
      if(recorder===instance)recorder=null;
      const blob=new Blob(chunks,{type:instance.mimeType||currentMediaType});
      if(blob.size)lockedMediaType=blob.type;
      resolve({blob,started:itemStart,ended:Date.now(),mime:blob.type||currentMediaType,sequence});
    };
    try{
      instance.start();
      timer=setTimeout(()=>{if(instance.state==='recording')instance.stop();},SEGMENT_LENGTH_MS);
    }catch(error){fail(error);}
  });
}
async function deleteExpiredParts(expired){
  if(!expired.length)return;
  const saved=await listSaved();
  const protectedIds=new Set(saved.flatMap(item=>item.partIds));
  for(const part of expired)if(!protectedIds.has(part.id))await deletePart(part.id);
}
async function saveContinuousSnapshot(target){
  const parts=selectContinuousParts(liveParts,target,settings.duration*60);
  if(!parts.length)throw Error('まだ保存可能な映像がありません。数秒後にもう一度お試しください。');
  if(!parts.some(part=>part.hasKey&&part.keyTime<target))throw Error('まだ再生できる映像がありません。数秒後にもう一度保存してください。');
  const now=new Date();
  const item={id:crypto.randomUUID(),name:`Replay_${fileStamp(now)}`,kind:'replay',continuous:true,created:now.getTime(),
    partIds:parts.map(part=>part.id),rangeStart:Math.max(0,target-settings.duration*60),rangeEnd:target,
    seconds:Math.min(settings.duration*60,Math.max(0,target-parts[0].mediaStart)),bytes:parts.reduce((sum,part)=>sum+part.bytes,0),mime:'video/mp4',orientation:recordingOrientation};
  const saved=await putReplaySnapshot(item);await refreshLibrary();
  if(!saved.created){toast('この区間は保存済みです。新しい映像が増えると、別の録画として保存できます。');return;}
  toast(`${rotationStopped?'端末の向きが変わったため録画を終了しました。':''}リプレイを保存しました（連続録画・${formatDuration(item.seconds)}）`);
}
async function runContinuousReplay(){
  let instance,worker,finished=false,workerFailed=false,writeQueue=Promise.resolve(),failure=null;
  const finish=async()=>{
    if(finished)return;finished=true;
    await writeQueue;
    if(pendingReplaySave&&liveParts.length){
      pendingReplaySave=false;
      try{await saveContinuousSnapshot(Math.min(pendingMediaTime,liveParts.at(-1).mediaEnd));}
      catch(error){toast(`保存に失敗しました: ${error.message}`,8000);}
    }
    worker?.terminate();
    recorder=null;running=false;starting=false;stopping=false;savingReplay=false;pendingReplaySave=false;
    liveParts=[];releaseCamera();
    await reclaimParts().catch(()=>{});updateControls();updateStorage();
    if(failure)toast(`連続録画を終了しました: ${failure.message||failure} 保存済みの動画は残っています。`,10000);
  };
  const fail=error=>{
    failure=error;workerFailed=true;
    // Finish an outstanding user save, but never invent a second save
    // request after the user's snapshot has already completed.
    if(pendingReplaySave&&liveParts.length)pendingMediaTime=Math.min(pendingMediaTime,liveParts.at(-1).mediaEnd);
    running=false;stopping=true;updateControls();
    if(instance?.state==='recording')instance.stop();else void finish();
  };
  try{
    instance=makeRecorder();recorder=instance;
    worker=new Worker(new URL('./continuous-replay-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
      if(data.type==='error'){fail(Error(data.message));return;}
      if(data.type==='fragment'){
        writeQueue=writeQueue.then(async()=>{
          const part={blob:data.blob,bytes:data.blob.size,mime:'video/mp4',started:startedAt+data.first*1000,ended:startedAt+data.last*1000,mediaStart:data.first,mediaEnd:data.last,hasKey:data.hasKey,keyTime:data.keyTime};
          const id=await addPart(part);
          measuredBytes+=part.bytes;measuredSeconds=Math.max(measuredSeconds,data.last);recordingStats=data.stats;
          liveParts.push({...part,id,blob:undefined});
          const selected=selectContinuousParts(liveParts,data.last,settings.duration*60),keep=new Set(selected.map(item=>item.id));
          const expired=liveParts.filter(item=>!keep.has(item.id));liveParts=selected;
          await deleteExpiredParts(expired);
          if(pendingReplaySave&&data.last>=pendingMediaTime){
            const target=pendingMediaTime;pendingReplaySave=false;
            try{await saveContinuousSnapshot(target);}catch(error){toast(`保存できませんでした: ${error.message}`,8000);}
            savingReplay=false;
          }
          updateControls();setCameraFacts();
        }).catch(fail);
      }else if(data.type==='finished')void finish();
    };
    worker.onerror=event=>{event.preventDefault();fail(Error('連続録画データの処理に失敗しました'));};
    worker.onmessageerror=()=>fail(Error('連続録画データを受信できませんでした'));
    instance.ondataavailable=event=>{if(event.data?.size&&!workerFailed)worker.postMessage({type:'append',blob:event.data});};
    instance.onerror=event=>fail(event.error||Error('録画処理が中断されました'));
    instance.onstop=()=>{running=false;stopping=true;updateControls();if(workerFailed)void finish();else worker.postMessage({type:'finish'});};
    instance.start(1000);
  }catch(error){fail(error);}
}
async function runSegmentedReplay(){
  try{
    const stopCapture=()=>{running=false;if(recorder?.state==='recording')recorder.stop();};
    for await(const item of capturePipeline(recordSegment,()=>running,stopCapture)){
      if(item.blob.size>0){
        const id=await addPart({...item,bytes:item.blob.size});
        measuredBytes+=item.blob.size;measuredSeconds+=(item.ended-item.started)/1000;
        liveParts.push({id,started:item.started,ended:item.ended,bytes:item.blob.size,mime:item.mime});
        const selected=selectReplayParts(liveParts,settings.duration*60*1000);
        const keep=new Set(selected.map(p=>p.id));
        const expired=liveParts.filter(part=>!keep.has(part.id));
        liveParts=selected;
        // Avoid scanning all recorded blobs on every 15-second segment.
        await deleteExpiredParts(expired);
        if(pendingReplaySave&&item.sequence>=pendingSaveSequence){
          pendingReplaySave=false;
          try{await saveReplaySnapshot();}catch(error){toast(`保存に失敗しました: ${error.message}`,7000);}
          savingReplay=false;
        }
      }else if(pendingReplaySave&&item.sequence>=pendingSaveSequence){
        pendingReplaySave=false;savingReplay=false;
        toast('まだ録画データがありません。数秒後にもう一度試してください。');
      }
      updateControls();
    }
  }catch(error){toast(`録画を終了しました: ${error.message||error}`,7000);}
  finally{
    if(pendingReplaySave){
      pendingReplaySave=false;
      try{await saveReplaySnapshot();}catch(error){toast(`保存に失敗しました: ${error.message}`,7000);}
    }
    running=false;starting=false;stopping=false;savingReplay=false;
    recorder=null;
    liveParts=[];
    releaseCamera();
    try{await reclaimParts();}catch{/* Best effort */}
    updateControls();
    updateStorage();
  }
}
async function saveReplaySnapshot(){
  if(!liveParts.length){toast('保存可能な映像がまだありません。');return;}
  const parts=selectReplayParts(liveParts,settings.duration*60*1000);
  const now=new Date();
  const item={
    id:crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`,
    name:`Replay_${fileStamp(now)}`,kind:'replay',created:now.getTime(),
    partIds:parts.map(p=>p.id),seconds:parts.reduce((sum,p)=>sum+(p.ended-p.started)/1000,0),
    bytes:parts.reduce((sum,p)=>sum+p.bytes,0),mime:parts[0].mime,orientation:recordingOrientation
  };
  const saved=await putReplaySnapshot(item);
  await refreshLibrary();
  if(!saved.created){toast('この区間は保存済みです。');return;}
  toast(`${rotationStopped?'端末の向きが変わったため録画を終了しました。':''}リプレイを保存しました（${formatDuration(item.seconds)}・${parts.length}区間）`);
}
function runStandard(){
  let instance;
  try{instance=makeRecorder();}catch(error){toast(error.message);running=false;releaseCamera();updateControls();return;}
  recorder=instance;
  let writeQueue=Promise.resolve();
  const partIds=[];
  let size=0;
  let storeError=null;
  const mime=currentMediaType;
  instance.ondataavailable=event=>{
    if(!event.data?.size)return;
    const blob=event.data;
    writeQueue=writeQueue.then(async()=>{
      const id=await addPart({blob,started:Date.now(),ended:Date.now(),bytes:blob.size,mime});
      partIds.push(id);size+=blob.size;
      measuredBytes=size;measuredSeconds=(Date.now()-startedAt)/1000;updateEstimate();
    }).catch(error=>{
      storeError=error;
      if(instance.state==='recording')instance.stop();
    });
  };
  instance.onerror=event=>{toast(`録画エラー: ${event.error?.message||'不明なエラー'}`,7000);if(instance.state==='recording')instance.stop();};
  instance.onstop=async()=>{
    try{
      await writeQueue;
      if(storeError)throw storeError;
      if(partIds.length){
        const now=new Date();
        const item={id:crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`,name:`Recording_${fileStamp(now)}`,
          kind:'standard',created:now.getTime(),partIds,seconds:(Date.now()-startedAt)/1000,
          bytes:size,mime,orientation:recordingOrientation};
        await putSaved(item);
        toast(`${rotationStopped?'端末の向きが変わったため録画を終了しました。':''}録画を保存しました（${formatDuration(item.seconds)}）`);
        await refreshLibrary();
      }else toast('録画データがありませんでした');
    }catch(error){toast(`保存に失敗しました: ${error.message}`,7000);}
    finally{
      recorder=null;running=false;starting=false;stopping=false;
      releaseCamera();
      await reclaimParts().catch(()=>{});
      updateControls();
      updateStorage();
    }
  };
  try{instance.start(3000);}catch(error){
    recorder=null;running=false;stopping=false;
    releaseCamera();updateControls();toast(`録画を開始できません: ${error.message}`,7000);
  }
}
async function startRecording(){
  if(running||starting||stopping)return;
  rotationStopped=false;
  starting=true;updateControls();
  try{
    await openDB();
    await enableCamera();
    navigator.storage?.persist?.().catch(()=>{});
    liveParts=[];measuredBytes=0;measuredSeconds=0;lockedMediaType='';captureSequence=0;activeSegmentSequence=0;recordingStats=null;continuousReplay=mode==='replay'&&chooseMimeType().startsWith('video/mp4')&&typeof Worker!=='undefined';
    startedAt=Date.now();
    recordingOrientation=actualOrientation();
    running=true;starting=false;
    updateControls();
    if(mode==='replay'){if(continuousReplay)void runContinuousReplay();else{toast('互換録画モードです。区間切り替え時に映像が途切れる場合があります。',7000);void runSegmentedReplay();}}
    else runStandard();
  }catch(error){
    starting=false;running=false;
    releaseCamera();updateControls();
    const reason=error.name==='NotAllowedError'?'カメラの使用が許可されていません。Safariの設定を確認してください。':(error.message||String(error));
    toast(reason,8500);
  }
}
function saveReplay(){
  if(mode!=='replay'||!running||savingReplay||stopping)return;
  requestReplaySave();
}
function requestReplaySave(){
  if(continuousReplay){
    savingReplay=true;pendingReplaySave=true;pendingMediaTime=(Date.now()-startedAt)/1000;updateControls();
    if(recorder?.state==='recording')recorder.requestData();
    return;
  }
  savingReplay=true;pendingReplaySave=true;pendingSaveSequence=activeSegmentSequence;
  updateControls();
  if(recorder?.state==='recording')recorder.stop();
}
function stopRecording(){
  if(!running||stopping)return;
  stopping=true;
  running=false;
  if(recorder?.state==='recording')recorder.stop();
  updateControls();
}
async function updateStorage(){
  try{
    const est=await navigator.storage?.estimate?.();
    if(est?.usage!==undefined){ui.storage.textContent=`このサイトの使用量 ${formatBytes(est.usage)}${est.quota?' / ブラウザ保存上限 '+formatBytes(est.quota):''}`;return;}
  }catch{/* Browsers may deny estimate. */}
  ui.storage.textContent='保存領域 —';
}
function dateLabel(time){
  return new Date(time).toLocaleString('ja-JP',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function addText(parent,tag,content,cls){
  const node=document.createElement(tag);node.textContent=content;
  if(cls)node.className=cls;
  parent.appendChild(node);return node;
}
async function refreshLibrary(){
  if(libraryBusy)return;
  libraryBusy=true;
  try{
    const items=(await listSaved()).sort((a,b)=>b.created-a.created);
    ui.library.replaceChildren();
    if(!items.length){addText(ui.library,'div','保存した動画はここに表示されます。','empty-library');return;}
    for(const item of items){
      const row=document.createElement('div');row.className='clip-row';
      const info=document.createElement('div');info.className='clip-info';
      addText(info,'b',item.kind==='replay'?'リプレイ':'通常録画');
      addText(info,'small',`${dateLabel(item.created)} · ${formatDuration(item.seconds)} · ${formatBytes(item.bytes)}${item.orientation&&item.orientation!=='unknown'?' · '+orientationLabel(item.orientation):''}`);
      row.appendChild(info);
      const actions=document.createElement('div');actions.className='clip-row-actions';
      const btn=addText(actions,'button','開く','open-clip');btn.type='button';
      btn.addEventListener('click',()=>openClip(item));
      const remove=addText(actions,'button','','delete-clip');remove.type='button';
      remove.title='削除';remove.setAttribute('aria-label',`${dateLabel(item.created)}の録画を削除`);
      remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg>';
      remove.addEventListener('click',()=>void removeClip(item));
      row.appendChild(actions);ui.library.appendChild(row);
    }
  }catch(error){toast(`動画一覧の読み込みに失敗しました: ${error.message}`);}
  finally{libraryBusy=false;updateStorage();}
}
function revokePreview(){
  ui.playback.pause();ui.playback.removeAttribute('src');ui.playback.load();
  ui.playback.hidden=true;
  if(previewURL){URL.revokeObjectURL(previewURL);previewURL=null;}
}
async function previewPart(partId){
  try{
    const part=await getPart(partId);
    if(!part)throw Error('ファイルが見つかりません');
    revokePreview();
    previewURL=URL.createObjectURL(part.blob);
    ui.playback.src=previewURL;
    ui.playback.hidden=false;
    await ui.playback.play().catch(()=>{});
  }catch(error){toast(`再生できません: ${error.message}`);}
}
async function exportPart(partId,index){
  if(exporting||sharing)return;
  try{
    const item=selectedItem;
    if(!item)return;
    const part=await getPart(partId);
    if(!part)throw Error('この録画区間が見つかりません');
    const ext=extensionFor(part.mime||item.mime);
    await saveBlob(part.blob,`${item.name}_part${String(index+1).padStart(3,'0')}.${ext}`);
  }catch(error){toast(`書き出しに失敗しました: ${error.message}`,7000);}
}
function openClip(item){
  selectedItem=item;
  revokePreview();
  ui.clipTitle.textContent=item.kind==='replay'?'リプレイ録画':'通常録画';
  ui.clipDescription.textContent=`${item.orientation&&item.orientation!=='unknown'?orientationLabel(item.orientation)+' · ':''}${dateLabel(item.created)} · ${formatDuration(item.seconds)} · ${formatBytes(item.bytes)}`;
  ui.exportAll.textContent=item.kind==='replay'&&(item.partIds.length>1||item.continuous)?'1本の動画にする':'動画を準備';
  ui.exportZip.hidden=item.kind!=='replay';
  const exportDetails=document.getElementById('export-details');
  exportDetails.hidden=item.kind!=='replay';exportDetails.open=false;
  ui.exportZip.textContent=item.continuous?'元データをZIPで保存':'ZIPで保存';
  ui.exportProgress.hidden=true;
  clearDownload();
  ui.segments.replaceChildren();
  if(item.kind==='replay'&&item.continuous){
    addText(ui.segments,'p','ZIPは復旧用です。区間単体では再生できない場合があります。動画の開始・終了は数秒前後することがあります。','dialog-description');
  }else if(item.kind==='replay'){
    addText(ui.segments,'p','区間ごとの再生・保存と、元データのZIP保存ができます。','dialog-description');
    item.partIds.forEach((id,index)=>{
      const row=document.createElement('div');row.className='segment';
      const info=document.createElement('div');
      addText(info,'b',`区間 ${String(index+1).padStart(2,'0')}`);
      addText(info,'small',`約${SEGMENT_LENGTH_MS/1000}秒（最後の区間は短い場合があります）`);
      row.appendChild(info);
      const preview=addText(row,'button','再生');preview.type='button';
      preview.addEventListener('click',()=>previewPart(id));
      const download=addText(row,'button','保存');download.type='button';
      download.addEventListener('click',()=>exportPart(id,index));
      ui.segments.appendChild(row);
    });
  }else{
    addText(ui.segments,'p','録画データを1本の動画として書き出します。','dialog-description');
  }
  ui.dialog.showModal();
}
async function saveBlob(blob,filename,release=null){
  clearDownload();
  releasePrepared=release;
  preparedFile=new File([blob],filename,{type:blob.type||'application/octet-stream'});
  downloadURL=URL.createObjectURL(preparedFile);
  ui.downloadResult.href=downloadURL;ui.downloadResult.download=filename;
  ui.downloadResult.textContent=blob.type.startsWith('video/')?'動画をダウンロード（ファイルに保存）':'ZIPをダウンロード';
  ui.downloadResult.hidden=false;
  let shareable=false;
  try{shareable=blob.type.startsWith('video/')&&!!navigator.share&&!!navigator.canShare?.({files:[preparedFile]});}catch{}
  ui.shareVideo.hidden=!shareable;ui.shareHelp.hidden=!shareable;
  if(shareable){toast('動画の準備ができました。「写真に保存・共有」を押してください。',7000);}
  else{ui.downloadResult.click();toast('ダウンロードを開始しました。端末への保存完了を確認してください。');}
}
function clearDownload(){
  if(downloadURL){
    const old=downloadURL,release=releasePrepared;
    // Let an in-progress download finish before discarding its OPFS file.
    setTimeout(()=>{URL.revokeObjectURL(old);void release?.();},120000);
  }else void releasePrepared?.();
  downloadURL=null;preparedFile=null;releasePrepared=null;
  ui.downloadResult.hidden=true;ui.downloadResult.removeAttribute('href');
  ui.shareVideo.hidden=true;ui.shareHelp.hidden=true;
}
function setExportControls(busy){
  for(const button of [ui.exportAll,ui.exportZip,ui.deleteClip,ui.dialogClose,ui.shareVideo])button.disabled=busy;
}
async function sharePreparedVideo(){
  if(!preparedFile||exporting||sharing)return;
  sharing=true;setExportControls(true);
  try{
    // Call synchronously from this fresh button click. Preparing the video
    // inside this handler would expire Safari's user activation.
    await navigator.share({files:[preparedFile],title:'ReplayCam'});
    ui.exportProgress.textContent='共有画面へ動画を渡しました。写真またはファイルへの保存結果を確認してください。';
  }catch(error){
    if(error.name!=='AbortError')ui.exportProgress.textContent='共有できませんでした。下のリンクから動画をダウンロードできます。';
  }finally{sharing=false;setExportControls(false);}
}
async function exportClip(asZip=false){
  if(!selectedItem||exporting||sharing)return;
  exporting=true;
  const item=selectedItem;
  setExportControls(true);
  clearDownload();
  ui.exportProgress.hidden=false;
  try{
    const entries=[];
    for(let i=0;i<item.partIds.length;i++){
      const part=await getPart(item.partIds[i]);
      if(!part?.blob)throw new Error(`区間${i+1}が見つかりません`);
      entries.push({name:`${item.name}_part${String(i+1).padStart(3,'0')}.${extensionFor(part.mime||item.mime)}`,blob:part.blob});
      ui.exportProgress.textContent=`動画を読み込み中 ${i+1}/${item.partIds.length}`;
    }
    if(item.kind==='standard'){
      // Chunks are consecutive dataavailable blobs from the SAME MediaRecorder;
      // combining these in order reconstructs one complete recording.
      const type=item.mime||'video/mp4';
      const full=new Blob(entries.map(x=>x.blob),{type});
      ui.exportProgress.textContent='動画を書き出しています…';
      await saveBlob(full,`${item.name}.${extensionFor(type)}`);
    }else if(entries.length===1&&!asZip&&!item.continuous){
      await saveBlob(entries[0].blob,`${item.name}.${extensionFor(item.mime)}`);
    }else if(asZip){
      if(item.continuous)entries.push({name:'replay-manifest.json',blob:new Blob([JSON.stringify({format:'ReplayCam continuous MP4 fragments',version:1,rangeStart:item.rangeStart,rangeEnd:item.rangeEnd,parts:entries.map(entry=>entry.name)},null,2)],{type:'application/json'})});
      const zip=await createZip(entries,(n,total)=>{ui.exportProgress.textContent=`ZIP作成中 ${n}/${total}`;});
      await saveBlob(zip,`${item.name}.zip`);
    }else{
      ui.exportProgress.textContent=`全区間を1本にしています 0/${entries.length}`;
      const result=await mergeReplayLocally(entries.map(entry=>entry.blob),(done,total)=>{ui.exportProgress.textContent=`全区間を1本にしています ${done}/${total}`;},{continuous:!!item.continuous,startTime:item.rangeStart,endTime:item.rangeEnd});
      try{await saveBlob(result.blob,`${item.name}.${extensionFor(result.blob.type)}`,result.release);}
      catch(error){await result.release();throw error;}
    }
    ui.exportProgress.textContent=!ui.shareVideo.hidden?'1本の動画の準備ができました。「写真に保存・共有」かダウンロードを選んでください。':'ダウンロードを開始しました。端末への保存完了を確認してください。';
  }catch(error){
    ui.exportProgress.textContent=`1本の動画を出力できませんでした: ${error.message||error} 元の区間は保存済みに残っています。`;
    toast(`書き出しに失敗しました: ${error.message||error}`,7500);
  }finally{exporting=false;setExportControls(false);}
}
async function removeClip(item=selectedItem){
  if(!item||deletingClip||exporting||sharing)return;
  if(!confirm('この録画を削除しますか？ 削除後は元に戻せません。'))return;
  deletingClip=true;
  try{
    await deleteSaved(item.id);
    // Active recorder writes can commit after a cleanup key scan starts.
    // Let recording finalization reclaim unused parts after its writes settle.
    const deferred=running||starting||stopping;
    if(!deferred)await reclaimParts();
    if(selectedItem?.id===item.id){selectedItem=null;ui.dialog.close();revokePreview();}
    await refreshLibrary();
    toast(deferred?'一覧から削除しました。容量は録画終了後に整理します。':'録画を削除しました');
  }catch(error){toast(`削除できませんでした: ${error.message}`);}
  finally{deletingClip=false;}
}
function updateClock(){
  if(!running){ui.elapsed.textContent='00:00';return;}
  ui.elapsed.textContent=formatDuration((Date.now()-startedAt)/1000);
}
function updateConnection(){
  const offline=!navigator.onLine;
  ui.connection.classList.toggle('offline',offline);
  ui.connection.classList.toggle('online',!offline);
  ui.connectionLabel.textContent=offline?'オフライン':'ローカル保存';
}
function bindEvents(){
  if('ResizeObserver' in window)new ResizeObserver(updateCaptureBoundary).observe(ui.viewfinder);
  else window.addEventListener('resize',updateCaptureBoundary);
  ui.video.addEventListener('loadedmetadata',handleVideoResize);
  ui.video.addEventListener('resize',handleVideoResize);
  landscapeQuery.addEventListener('change',handleDeviceRotation);
  if(screen.orientation?.addEventListener)screen.orientation.addEventListener('change',handleDeviceRotation);
  else window.addEventListener('orientationchange',handleDeviceRotation);
  ui.start.addEventListener('click',startRecording);
  ui.save.addEventListener('click',saveReplay);
  ui.stop.addEventListener('click',stopRecording);
  ui.modeReplay.addEventListener('click',()=>setMode('replay'));
  ui.modeStandard.addEventListener('click',()=>setMode('standard'));
  const bind=(input,key,converter=value=>value)=>input.addEventListener('change',()=>{
    if(running||starting||stopping)return;
    settings[key]=converter(input.value);storeSettings();updateControls();
    if(stream)releaseCamera();
  });
  bind(ui.duration,'duration',Number);
  bind(ui.resolution,'resolution',Number);
  bind(ui.fps,'fps',Number);
  bind(ui.audio,'audio',value=>value==='on');
  bind(ui.facing,'facing');
  ui.refresh.addEventListener('click',refreshLibrary);
  ui.dialogClose.addEventListener('click',()=>{if(!exporting&&!sharing)ui.dialog.close();});
  ui.dialog.addEventListener('cancel',event=>{if(exporting||sharing)event.preventDefault();});
  ui.dialog.addEventListener('close',()=>{revokePreview();clearDownload();selectedItem=null;});
  ui.exportAll.addEventListener('click',()=>exportClip());
  ui.exportZip.addEventListener('click',()=>exportClip(true));
  ui.shareVideo.addEventListener('click',sharePreparedVideo);
  ui.deleteClip.addEventListener('click',()=>void removeClip());
  window.addEventListener('online',updateConnection);
  window.addEventListener('offline',updateConnection);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&running)wasHiddenDuringRecording=true;
    if(!document.hidden&&wasHiddenDuringRecording){
      wasHiddenDuringRecording=false;
      toast('録画中に画面が非表示になりました。録画に欠落がないか確認してください。',7000);
    }
  });
  window.addEventListener('pagehide',()=>{
    // Do not assume async IndexedDB writes can complete during page teardown.
    if(recorder?.state==='recording')recorder.stop();
    releaseCamera();
  });
}
async function init(){
  bindEvents();
  updateControls();updateConnection();updateClock();
  setInterval(updateClock,500);
  try{
    await openDB();
    await reclaimParts();
    await refreshLibrary();
  }catch(error){toast(`端末内ストレージを利用できません: ${error.message}`,7500);}
  if('serviceWorker'in navigator&&window.isSecureContext){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}
init();
