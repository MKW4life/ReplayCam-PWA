import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSettings,formatDuration,extensionFor,selectReplayParts} from '../lib.js';
import {createZip} from '../zip.js';
import {writeFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('default settings',()=>{
  assert.deepEqual(safeSettings(),{duration:3,resolution:1080,fps:60,audio:true,facing:'environment'});
  assert.equal(safeSettings({duration:15,resolution:720,fps:30}).duration,15);
  assert.equal(safeSettings({duration:99,resolution:100,fps:120}).fps,60);
});
test('formatting and extension',()=>{
  assert.equal(formatDuration(179.8),'02:59');
  assert.equal(formatDuration(900),'15:00');
  assert.equal(extensionFor('video/mp4;codecs=avc1'),'mp4');
  assert.equal(extensionFor('video/webm'),'webm');
});
test('buffer retains only last N seconds with at most one partial segment excess',()=>{
  const parts=Array.from({length:80},(_,i)=>({id:i,started:i*15000,ended:(i+1)*15000}));
  const selected=selectReplayParts(parts,3*60*1000);
  assert.equal(selected.length,12);
  assert.equal(selected[0].id,68);
  assert.equal(selectReplayParts([],1000).length,0);
});
test('ZIP exports separate playable entries without recompression',async()=>{
  const zip=await createZip([
    {name:'clip_01.mp4',blob:new Blob(['aaa'])},
    {name:'clip_02.mp4',blob:new Blob(['bbbb'])}
  ]);
  const tmp=mkdtempSync(path.join(os.tmpdir(),'replaycam-'));
  try{
    const filename=path.join(tmp,'test.zip');
    writeFileSync(filename,new Uint8Array(await zip.arrayBuffer()));
    const listing=execFileSync('python',['-c',`import zipfile,json; z=zipfile.ZipFile(${JSON.stringify(filename)}); print(json.dumps([[k,z.read(k).decode()] for k in z.namelist()]))`],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(listing),[['clip_01.mp4','aaa'],['clip_02.mp4','bbbb']]);
  }finally{rmSync(tmp,{recursive:true,force:true});}
});
