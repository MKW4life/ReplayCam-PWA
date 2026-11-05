import {SEGMENT_LENGTH_MS, safeSettings, formatDuration, formatBytes, chooseMimeType, extensionFor, selectReplayParts, fileStamp} from './lib.js';
import {openDB, addPart, getPart, deletePart, putSaved, deleteSaved, listSaved, reclaimParts} from './storage.js';
import {createZip} from './zip.js';

const el=id=>document.getElementById(id);
const ui={
  video:el('camera'),empty:el('empty-camera'),start:el('start-button'),save:el('save-button'),stop:el('stop-button'),
  modeReplay:el('mode-replay'),modeStandard:el('mode-standard'),duration:el('duration'),resolution:el('resolution'),
  fps:el('fps'),audio:el('audio'),flip:el('flip-button'),elapsed:el('elapsed'),counter:el('buffer-counter'),
  indicator:el('record-indicator'),state:el('record-state'),facts:el('camera-facts'),settingsNote:el('settings-note'),
  durationField:el('duration-field'),modeExplanation:el('mode-explanation'),storage:el('storage-display'),
  library:el('library-items'),refresh:el('refresh-library'),connection:el('connection'),connectionLabel:el('connection-label'),
  toast:el('toast'),dialog:el('clip-dialog'),dialogClose:el('dialog-close'),clipTitle:el('clip-title'),
  clipDescription:el('clip-description'),exportAll:el('export-all'),deleteClip:el('delete-clip'),
  segments:el('segment-list'),playback:el('clip-playback'),exportProgress:el('export-progress')
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
let currentMediaType='';
let startedAt=0;
let liveParts=[];
let selectedItem=null;
let previewURL=null;
let toastTimeout=0;
let libraryBusy=false;
let wasHiddenDuringRecording=false;

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
  for(const input of [ui.duration,ui.resolution,ui.fps,ui.audio])input.disabled=busy;
  ui.flip.disabled=busy;
  ui.durationField.hidden=!isReplay;
  ui.counter.textContent=isReplay?`保存範囲 ${settings.duration}:00`:'連続録画';
  ui.save.hidden=!isReplay;
  ui.start.disabled=busy;
  ui.stop.disabled=!running||stopping;
  ui.save.disabled=!running||stopping||savingReplay||!isReplay;
  ui.stop.textContent=isReplay?'停止':'終了して保存';
  ui.start.querySelector('span:last-child').textContent=starting?'カメラ起動中…':'録画開始';
  ui.state.textContent=starting?'接続中':stopping?'終了処理中':running?(isReplay?'BUFFER':'REC'):'待機';
  ui.indicator.classList.toggle('active',running);
  ui.settingsNote.textContent=busy?'録画中は変更できません':'録画開始前に変更できます';
  ui.modeExplanation.textContent=isReplay
    ?'古い録画区間を破棄しながら、直前の指定時間を保持します。現段階ではリプレイを分割動画のZIPとして書き出します。区間の継ぎ目に短い欠落が生じる場合があります。'
    :'終了すると開始から終了までの動画を1ファイルとして保存します。長時間の録画では端末の空き容量に注意してください。';
  ui.resolution.value=String(settings.resolution);
  ui.fps.value=String(settings.fps);
  ui.duration.value=String(settings.duration);
  ui.audio.value=settings.audio?'on':'off';
}
function setCameraFacts(){
  const track=stream?.getVideoTracks()[0];
  const actual=track?.getSettings?.()||{};
  if (!stream){ui.facts.textContent='—';return;}
  const d=(actual.width&&actual.height)?`${actual.width}×${actual.height}`:`${settings.resolution}p`;
  const f=actual.frameRate?` · ${Math.round(actual.frameRate)}fps`:' · fps未確認';
  ui.facts.textContent=d+f;
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
  const video={
    facingMode:{ideal:settings.facing},
    width:{ideal:settings.resolution===1080?1920:1280},
    height:{ideal:settings.resolution===1080?1080:720},
    frameRate:{ideal:settings.fps,max:settings.fps}
  };
  const audio=settings.audio?{echoCancellation:false,noiseSuppression:false,autoGainControl:false}:false;
  try{stream=await navigator.mediaDevices.getUserMedia({video,audio});}
  catch(error){
    if(audio){
      try{
        stream=await navigator.mediaDevices.getUserMedia({video,audio:false});
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
  if(actual.frameRate && actual.frameRate < settings.fps-5)toast(`この端末の実際の録画フレームレートは約${Math.round(actual.frameRate)}fpsです。`,6000);
}
function makeRecorder(){
  const mime=chooseMimeType();
  const targetBitrate=settings.resolution===1080?(settings.fps===60?8_000_000:6_000_000):(settings.fps===60?5_000_000:3_500_000);
  let instance;
  try{
    instance=new MediaRecorder(stream,{
      ...(mime?{mimeType:mime}:{}),
      videoBitsPerSecond:targetBitrate,
      audioBitsPerSecond:128_000
    });
  }catch{
    instance=new MediaRecorder(stream,mime?{mimeType:mime}:{});
  }
  currentMediaType=instance.mimeType||mime||'video/mp4';
  return instance;
}
function recordSegment(){
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
      resolve({blob,started:itemStart,ended:Date.now(),mime:blob.type||currentMediaType});
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
async function runReplay(){
  try{
    while(running){
      const item=await recordSegment();
      if(item.blob.size>0){
        const id=await addPart({...item,bytes:item.blob.size});
        liveParts.push({id,started:item.started,ended:item.ended,bytes:item.blob.size,mime:item.mime});
        const selected=selectReplayParts(liveParts,settings.duration*60*1000);
        const keep=new Set(selected.map(p=>p.id));
        const expired=liveParts.filter(part=>!keep.has(part.id));
        liveParts=selected;
        // Avoid scanning all recorded blobs on every 15-second segment.
        await deleteExpiredParts(expired);
        if(pendingReplaySave){
          pendingReplaySave=false;
          try{await saveReplaySnapshot();}catch(error){toast(`保存に失敗しました: ${error.message}`,7000);}
          savingReplay=false;
        }
      }else if(pendingReplaySave){
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
    bytes:parts.reduce((sum,p)=>sum+p.bytes,0),mime:parts[0].mime
  };
  await putSaved(item);
  await refreshLibrary();
  toast(`リプレイを保存しました（${formatDuration(item.seconds)}・${parts.length}区間）`);
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
          bytes:size,mime};
        await putSaved(item);
        toast(`録画を保存しました（${formatDuration(item.seconds)}）`);
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
  starting=true;updateControls();
  try{
    await openDB();
    await enableCamera();
    navigator.storage?.persist?.().catch(()=>{});
    liveParts=[];
    startedAt=Date.now();
    running=true;starting=false;
    updateControls();
    if(mode==='replay')void runReplay();
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
  savingReplay=true;pendingReplaySave=true;
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
    if(est?.usage!==undefined){ui.storage.textContent=`保存領域 ${formatBytes(est.usage)} 使用`;return;}
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
      addText(info,'small',`${dateLabel(item.created)} · ${formatDuration(item.seconds)} · ${formatBytes(item.bytes)}`);
      row.appendChild(info);
      const btn=addText(row,'button','開く','open-clip');btn.type='button';
      btn.addEventListener('click',()=>openClip(item));
      ui.library.appendChild(row);
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
  ui.clipDescription.textContent=`${dateLabel(item.created)} · ${formatDuration(item.seconds)} · ${formatBytes(item.bytes)}${item.kind==='replay'?' · 分割動画':' · 1本の動画'}`;
  ui.exportAll.textContent=item.kind==='standard'?'動画を書き出す':item.partIds.length===1?'動画を書き出す':'ZIPを書き出す';
  ui.exportProgress.hidden=true;
  ui.segments.replaceChildren();
  if(item.kind==='replay'){
    addText(ui.segments,'p','各区間は個別に再生・書き出しできます。ZIPは結合済みの動画ではありません。','dialog-description');
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
async function saveBlob(blob,filename){
  const file=new File([blob],filename,{type:blob.type||'application/octet-stream'});
  if(navigator.canShare?.({files:[file]})&&navigator.share){
    try{await navigator.share({files:[file],title:'ReplayCam'});return;}
    catch(error){if(error.name==='AbortError')return;/* use download fallback */}
  }
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;
  document.body.appendChild(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),120000);
  toast('書き出しを開始しました。必要に応じて「ファイル」に保存してください。');
}
async function exportClip(){
  if(!selectedItem||ui.exportAll.disabled)return;
  const item=selectedItem;
  ui.exportAll.disabled=true;
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
    }else if(entries.length===1){
      await saveBlob(entries[0].blob,entries[0].name);
    }else{
      ui.exportProgress.textContent='ZIP作成中…';
      const zip=await createZip(entries,(n,total)=>{ui.exportProgress.textContent=`ZIP作成中 ${n}/${total}`;});
      await saveBlob(zip,`${item.name}.zip`);
    }
    ui.exportProgress.textContent='書き出し処理が完了しました。';
  }catch(error){
    ui.exportProgress.textContent=`書き出しに失敗: ${error.message||error}`;
    toast(`書き出しに失敗しました: ${error.message||error}`,7500);
  }finally{ui.exportAll.disabled=false;}
}
async function removeClip(){
  if(!selectedItem||!confirm('この録画を削除しますか？ 削除後は元に戻せません。'))return;
  const item=selectedItem;
  try{
    await deleteSaved(item.id);
    await reclaimParts(liveParts.map(part=>part.id));
    selectedItem=null;
    ui.dialog.close();
    revokePreview();
    await refreshLibrary();
    toast('録画を削除しました');
  }catch(error){toast(`削除できませんでした: ${error.message}`);}
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
  ui.flip.addEventListener('click',()=>{
    if(running||starting||stopping)return;
    settings.facing=settings.facing==='environment'?'user':'environment';
    storeSettings();releaseCamera();toast(settings.facing==='user'?'前面カメラを選択しました':'背面カメラを選択しました');
  });
  ui.refresh.addEventListener('click',refreshLibrary);
  ui.dialogClose.addEventListener('click',()=>ui.dialog.close());
  ui.dialog.addEventListener('close',()=>{revokePreview();selectedItem=null;});
  ui.exportAll.addEventListener('click',exportClip);
  ui.deleteClip.addEventListener('click',removeClip);
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
