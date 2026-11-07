import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {Input,MP4,BlobSource,EncodedPacketSink} from '../vendor/mediabunny.js';

test('WebKit persists replay fragments across reload and exports every audio/video packet',async({page})=>{
  await page.goto('/');
  const before=await page.evaluate(async()=>{
    const {addPart,putSaved}=await import('./storage.js');
    const src=await(await fetch('./tests/fixtures/continuous.mp4')).blob();
    const worker=new Worker('./continuous-replay-worker.js',{type:'module'});
    const parts=await new Promise((resolve,reject)=>{
      const fragments=[];
      worker.onmessage=({data})=>{if(data.type==='fragment')fragments.push(data.blob);else if(data.type==='finished')resolve(fragments);else if(data.type==='error')reject(Error(data.message));};
      worker.onerror=event=>reject(Error(event.message));
      worker.postMessage({type:'append',blob:src});worker.postMessage({type:'finish'});
    }).finally(()=>worker.terminate());
    const ids=[];for(const blob of parts)ids.push(await addPart({blob,mime:'video/mp4',bytes:blob.size}));
    await putSaved({id:'webkit',name:'WebKit',kind:'replay',continuous:true,partIds:ids,rangeStart:0,rangeEnd:6,created:Date.now(),seconds:6,bytes:src.size,mime:'video/mp4'});
    return ids.length;
  });
  expect(before).toBeGreaterThan(4);
  await page.reload();
  const result=await page.evaluate(async()=>{
    const {getSaved,getPart}=await import('./storage.js');
    const {mergeReplay}=await import('./merge.js');
    const {Input,MP4,BlobSource,EncodedPacketSink}=await import('./vendor/mediabunny.js');
    const item=await getSaved('webkit'),blobs=[];for(const id of item.partIds)blobs.push((await getPart(id)).blob);
    const merged=await mergeReplay(blobs,()=>{},undefined,{continuous:true,startTime:0,endTime:6});
    const input=new Input({source:new BlobSource(merged),formats:[MP4]});
    try{
      let frames=0,audio=0;for await(const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets())frames++;
      for await(const packet of new EncodedPacketSink(await input.getPrimaryAudioTrack()).packets())audio++;
      return {frames,audio,duration:await input.computeDuration()};
    }finally{input.dispose();}
  });
  expect(result.frames).toBe(60);expect(result.audio).toBeGreaterThan(200);expect(result.duration).toBeGreaterThanOrEqual(6);
  await page.locator('#refresh-library').click();await page.locator('.open-clip').click();
  const downloadEvent=page.waitForEvent('download');await page.locator('#export-all').click();
  const download=await downloadEvent;
  const input=new Input({source:new BlobSource(new Blob([await readFile(await download.path())])),formats:[MP4]});
  try{let frames=0;for await(const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets())frames++;expect(frames).toBe(60);}finally{input.dispose();}
  await page.locator('#export-details summary').click();
  const zipEvent=page.waitForEvent('download');await page.locator('#export-zip').click();
  const zip=await readFile(await(await zipEvent).path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);expect(zip.readUInt32LE(zip.length-22)).toBe(0x06054b50);
  // Validate ZIP local records, lengths and CRCs, not merely its filename.
  let at=0,count=0;
  while(zip.readUInt32LE(at)===0x04034b50){
    const size=zip.readUInt32LE(at+18),name=zip.readUInt16LE(at+26),extra=zip.readUInt16LE(at+28),start=at+30+name+extra;
    let crc=0xffffffff;for(const byte of zip.subarray(start,start+size)){crc^=byte;for(let b=0;b<8;b++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
    expect((crc^0xffffffff)>>>0).toBe(zip.readUInt32LE(at+14));at=start+size;count++;
  }
  expect(count).toBe(before+1);expect(zip.readUInt32LE(at)).toBe(0x02014b50);
});


test('reclaim reads only keys and preserves saved and live recordings',async({page})=>{
  await page.route('**/storage-probe.html',route=>route.fulfill({contentType:'text/html',body:'<title>Storage probe</title>'}));
  await page.goto('/storage-probe.html');
  const result=await page.evaluate(async()=>{
    const {addPart,putSaved,reclaimParts,getPart}=await import('./storage.js');
    const ids=[];for(let i=0;i<3;i++)ids.push(await addPart({blob:new Blob([new Uint8Array(100)])}));
    await putSaved({id:'keep',partIds:[ids[0]]});
    const original=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='parts')throw Error('Reclaim must not load all video bytes');return original.apply(this,args);};
    let count;try{count=await reclaimParts([ids[1]]);}finally{IDBObjectStore.prototype.getAll=original;}
    return {count,saved:!!await getPart(ids[0]),live:!!await getPart(ids[1]),expired:!!await getPart(ids[2])};
  });
  expect(result).toEqual({count:1,saved:true,live:true,expired:false});
});


test('WebKit registers duplicate replay saves atomically and allows re-save after deletion',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    const {addPart,putReplaySnapshot,listSaved,deleteSaved}=await import('./storage.js');
    const id=await addPart({blob:new Blob(['replay fixture'])}),item={kind:'replay',continuous:true,partIds:[id],created:Date.now(),name:'Replay',seconds:1,bytes:14};
    const results=await Promise.all([putReplaySnapshot(item),putReplaySnapshot(item)]);
    const saved=await listSaved();await deleteSaved(saved[0].id);
    const restored=await putReplaySnapshot(item);
    return {count:saved.length,created:results.filter(result=>result.created).length,resaved:restored.created};
  });
  expect(result).toEqual({count:1,created:1,resaved:true});
});
