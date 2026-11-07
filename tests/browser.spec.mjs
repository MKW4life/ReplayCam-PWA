import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {Input,MP4,WEBM,BlobSource,EncodedPacketSink} from '../vendor/mediabunny.js';

test('mobile controls persist high resolution and camera choice, estimates respond to settings',async({page})=>{
  await page.goto('/');
  await expect(page.locator('#capacity-estimate')).toContainText('174.4 MB');
  await page.locator('#resolution').selectOption('2160');
  await expect(page.locator('#capacity-estimate')).toContainText('689.4 MB');
  await page.locator('#facing').selectOption('user');
  await expect(page.locator('#camera-status')).toContainText('選択中：内カメラ');
  await page.reload();
  await expect(page.locator('#resolution')).toHaveValue('2160');
  await expect(page.locator('#facing')).toHaveValue('user');
  await expect(page.locator('#camera-status')).toContainText('内カメラ');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#mode-standard').click();
  await expect(page.locator('#capacity-estimate')).toContainText('通常録画1分あたり');
});

test('real browser recording exports a merged file with audio, explicit ZIP and offline export',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await expect(page.locator('#facing')).toBeDisabled();
  await page.waitForTimeout(1800);
  await page.locator('#save-button').click();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await expect(page.locator('#save-button')).toBeEnabled();
  await page.waitForTimeout(1500);
  await page.locator('#save-button').click();
  await expect(page.locator('.clip-row')).toHaveCount(2);
  await page.locator('#stop-button').click();
  await expect(page.locator('#start-button')).toBeEnabled();
  await page.locator('.open-clip').first().click();
  await expect(page.locator('#export-all')).toHaveText('全区間を1本の動画にする');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.evaluate(()=>caches.open('unrelated-project-cache'));
  await context.setOffline(true);
  const downloadEvent=page.waitForEvent('download');
  await page.locator('#export-all').click();
  await expect(page.locator('#download-result')).toBeVisible();
  if(await page.locator('#share-video').isVisible())await page.locator('#download-result').click();
  const download=await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  const input=new Input({source:new BlobSource(new Blob([await readFile(await download.path())])),formats:[MP4,WEBM]});
  try{
    expect(await input.getPrimaryVideoTrack()).toBeTruthy();
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(2);
    let count=0;for await(const p of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets())count++;
    expect(count).toBeGreaterThan(20);
  }finally{input.dispose();}
  const zipEvent=page.waitForEvent('download');
  await page.locator('#export-zip').click();
  expect((await zipEvent).suggestedFilename()).toMatch(/\.zip$/);
  await page.locator('#dialog-close').click();
  await page.reload();
  await expect(page.locator('#version')).toContainText('v0.3.2');
  expect(await page.evaluate(()=>caches.has('unrelated-project-cache'))).toBe(true);
  expect(errors).toEqual([]);
});

test('landscape recording downloads landscape video and keeps the controls visible',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await expect(page.locator('#orientation-status')).toContainText('横向き');
  await page.locator('#mode-standard').click();
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await expect(page.locator('#orientation-status')).toContainText('横向きで録画中');
  const bounds=await page.locator('#stop-button').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y+bounds.height).toBeLessThanOrEqual(390);
  const view=await page.locator('#camera').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,fit:getComputedStyle(video).objectFit}));
  expect(view.width).toBeGreaterThan(view.height);
  expect(view.fit).toBe('contain');
  await expect(page.locator('#capture-boundary')).toBeVisible();
  const framing=await page.evaluate(()=>{
    const video=document.querySelector('#camera'),stage=video.getBoundingClientRect(),frame=document.querySelector('#capture-boundary').getBoundingClientRect();
    const facts=document.querySelector('.preview-top').getBoundingClientRect(),footer=document.querySelector('.preview-bottom').getBoundingClientRect();
    return {aspect:frame.width/frame.height,expected:video.videoWidth/video.videoHeight,inside:frame.left>=stage.left-1&&frame.right<=stage.right+1&&frame.top>=stage.top-1&&frame.bottom<=stage.bottom+1,overlaysOutside:facts.bottom<=stage.top+1&&footer.top>=stage.bottom-1};
  });
  expect(framing.aspect).toBeCloseTo(framing.expected,2);
  expect(framing.inside).toBe(true);expect(framing.overlaysOutside).toBe(true);
  await page.screenshot({path:test.info().outputPath('landscape.png')});
  await page.waitForTimeout(1300);
  await page.locator('#stop-button').click();
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toContainText('横向き');
  await page.locator('.open-clip').click();
  const event=page.waitForEvent('download');
  await page.locator('#export-all').click();
  await expect(page.locator('#download-result')).toBeVisible();
  if(await page.locator('#share-video').isVisible())await page.locator('#download-result').click();
  const download=await event;
  const input=new Input({source:new BlobSource(new Blob([await readFile(await download.path())])),formats:[MP4,WEBM]});
  try{
    const video=await input.getPrimaryVideoTrack();
    expect(video).toBeTruthy();
    expect(await video.getDisplayWidth()).toBeGreaterThan(await video.getDisplayHeight());
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(0.5);
  }finally{input.dispose();}
});

test('turning the device during replay saves the current buffer and ends recording',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await page.waitForTimeout(1200);
  // Viewport orientation changes exercise the same matchMedia event used by
  // mobile browsers when the page rotates. No physical camera is accessed.
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await expect(page.locator('#toast')).toContainText('向きが変わった');
});

test('turning the device during standard recording saves a playable video',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await page.locator('#mode-standard').click();
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await page.waitForTimeout(1200);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await page.locator('.open-clip').click();
  const event=page.waitForEvent('download');
  await page.locator('#export-all').click();
  await expect(page.locator('#download-result')).toBeVisible();
  if(await page.locator('#share-video').isVisible())await page.locator('#download-result').click();
  const input=new Input({source:new BlobSource(new Blob([await readFile(await (await event).path())])),formats:[MP4,WEBM]});
  try{expect(await input.computeDuration()).toBeGreaterThan(0.5);expect(await input.getPrimaryVideoTrack()).toBeTruthy();}
  finally{input.dispose();}
});

test('unreadable saved segments show an error without automatically exporting ZIP',async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const {addPart,putSaved}=await import('./storage.js');
    const partIds=[];
    for(let i=0;i<2;i++)partIds.push(await addPart({blob:new Blob(['invalid']),mime:'video/mp4',bytes:7}));
    await putSaved({id:'broken-fixture',name:'Broken',kind:'replay',created:Date.now(),partIds,seconds:1,bytes:14,mime:'video/mp4'});
  });
  await page.locator('#refresh-library').click();
  await page.locator('.open-clip').click();
  const downloads=[];page.on('download',item=>downloads.push(item));
  await page.locator('#export-all').click();
  await expect(page.locator('#export-progress')).toContainText('1本の動画を出力できませんでした');
  expect(downloads).toHaveLength(0);
  const event=page.waitForEvent('download');
  await page.locator('#export-zip').click();
  expect((await event).suggestedFilename()).toBe('Broken.zip');
  await page.locator('#dialog-close').click();
  await expect(page.locator('.clip-row')).toHaveCount(1);
});


test('all segments form one video and sharing uses a fresh tap with the full file',async({page})=>{
  await page.addInitScript(()=>{
    window.shareCalls=[];
    Object.defineProperty(navigator,'canShare',{value:({files})=>files?.length===1&&files[0].type==='video/mp4'});
    Object.defineProperty(navigator,'share',{value:async({files})=>{window.shareCalls.push({file:files[0],active:navigator.userActivation.isActive});}});
  });
  await page.goto('/');
  await page.evaluate(async()=>{
    const blob=await(await fetch('./tests/fixtures/av.mp4')).blob();
    const {addPart,putSaved}=await import('./storage.js');
    const partIds=[];for(let i=0;i<3;i++)partIds.push(await addPart({blob,mime:'video/mp4',bytes:blob.size}));
    await putSaved({id:'three',name:'ThreeParts',kind:'replay',created:Date.now(),partIds,seconds:1.8,bytes:blob.size*3,mime:'video/mp4'});
  });
  await page.locator('#refresh-library').click();
  await page.locator('.open-clip').click();
  await page.locator('#export-all').click();
  await expect(page.locator('#share-video')).toBeVisible();
  expect(await page.evaluate(()=>shareCalls.length)).toBe(0);
  await page.locator('#share-video').click();
  const result=await page.evaluate(async()=>{
    const {Input,MP4,BlobSource,EncodedPacketSink}=await import('./vendor/mediabunny.js');
    const {file,active}=shareCalls[0];
    const input=new Input({formats:[MP4],source:new BlobSource(file)});
    try{
      const video=await input.getPrimaryVideoTrack();let frames=0;
      for await(const packet of new EncodedPacketSink(video).packets())frames++;
      return {name:file.name,type:file.type,active,frames,duration:await input.computeDuration(),audio:!!await input.getPrimaryAudioTrack()};
    }finally{input.dispose();}
  });
  expect(result.name).toBe('ThreeParts.mp4');expect(result.type).toBe('video/mp4');expect(result.active).toBe(true);
  expect(result.frames).toBe(18);expect(result.duration).toBeGreaterThan(1.7);expect(result.audio).toBe(true);
});

test('private-file streaming merges inputs over the previous 256MB limit',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const original=await(await fetch('./tests/fixtures/av.mp4')).blob();
    const padding=new Blob([new Uint8Array(1024*1024)]);
    const large=new Blob([original,...Array(257).fill(padding)],{type:'video/mp4'});
    const {mergeReplayLocally}=await import('./merge-client.js');
    const {EXPORT_DIRECTORY}=await import('./merge-destination.js');
    const result=await mergeReplayLocally([large,original]);
    const {Input,MP4,BlobSource,EncodedPacketSink}=await import('./vendor/mediabunny.js');
    const input=new Input({formats:[MP4],source:new BlobSource(result.blob)});
    let frames=0,duration;
    try{for await(const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets())frames++;duration=await input.computeDuration();}
    finally{input.dispose();}
    const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY);
    const before=[];for await(const name of directory.keys())before.push(name);
    await result.release();
    const after=[];for await(const name of directory.keys())after.push(name);
    return {inputSize:large.size,frames,duration,tempFilesBefore:before.length,tempFilesAfter:after.length};
  });
  expect(result.inputSize).toBeGreaterThan(256*1024*1024);
  expect(result.frames).toBe(12);expect(result.duration).toBeGreaterThan(1.1);
  expect(result.tempFilesBefore).toBe(1);expect(result.tempFilesAfter).toBe(0);
});

test('60fps is requested first and lower camera fps is labeled accurately',async({page})=>{
  await page.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.cameraRequests=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{
      cameraRequests.push(constraints.video.frameRate);
      if(constraints.video.frameRate.exact===60)throw new DOMException('60fps unavailable','OverconstrainedError');
      return original(constraints);
    };
  });
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  const requests=await page.evaluate(()=>cameraRequests);
  expect(requests[0]).toEqual({exact:60});expect(requests[1]).toEqual({ideal:60,max:60});
  await expect(page.locator('#capture-fps')).toContainText('希望 60fps / カメラ設定');
  await expect(page.locator('#capture-fps')).toContainText('保存動画の実際のfps');
  await page.locator('#stop-button').click();
  await expect(page.locator('#start-button')).toBeEnabled();
});

test('replay restarts capture before a slow segment write completes',async({page})=>{
  await page.addInitScript(()=>{
    window.captureEvents=[];
    const start=MediaRecorder.prototype.start;
    MediaRecorder.prototype.start=function(...args){captureEvents.push('capture');return start.apply(this,args);};
    const complete=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{
      configurable:true,get:complete.get,
      set(handler){
        if(typeof handler!=='function'||this.mode!=='readwrite'||!this.objectStoreNames.contains('parts')){complete.set.call(this,handler);return;}
        complete.set.call(this,event=>setTimeout(()=>{captureEvents.push('stored');handler.call(this,event);},700));
      }
    });
  });
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#save-button')).toBeEnabled();
  await page.waitForTimeout(1200);
  await page.locator('#save-button').click();
  await expect.poll(()=>page.evaluate(()=>captureEvents.filter(item=>item==='capture').length)).toBe(2);
  await page.waitForTimeout(150);
  // Rotate while the old segment is still being persisted. The final saved
  // snapshot must also include the newly active segment, not only the old one.
  await page.setViewportSize({width:844,height:390});
  await expect(page.locator('.clip-row')).toHaveCount(1);
  const events=await page.evaluate(()=>captureEvents);
  expect(events.slice(0,3)).toEqual(['capture','capture','stored']);
  await expect(page.locator('#start-button')).toBeEnabled();
  const snapshot=await page.evaluate(async()=>{
    const {listSaved,getPart}=await import('./storage.js');
    const [saved]=await listSaved();
    const parts=await Promise.all(saved.partIds.map(getPart));
    return {count:parts.length,bytes:parts.reduce((sum,part)=>sum+part.blob.size,0)};
  });
  expect(snapshot.count).toBe(2);expect(snapshot.bytes).toBeGreaterThan(1000);
});
