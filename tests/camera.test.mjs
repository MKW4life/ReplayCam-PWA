import test from 'node:test';
import assert from 'node:assert/strict';
import {requestCamera} from '../camera.js';
import {chooseMimeType} from '../lib.js';

test('requests exact 60fps before allowing lower capture rates',async()=>{
  const requests=[];
  const mediaDevices={async getUserMedia(request){
    requests.push(request);
    if(request.video.frameRate.exact===60)throw Object.assign(Error('fps unavailable'),{name:'OverconstrainedError'});
    return 'stream';
  }};
  assert.equal(await requestCamera(mediaDevices,{width:{ideal:1920},frameRate:{ideal:60,max:60}},true),'stream');
  assert.deepEqual(requests[0].video.frameRate,{exact:60});
  assert.deepEqual(requests[1].video.frameRate,{ideal:60,max:60});
  assert.equal(requests[1].audio,true);
});
test('does not retry a denied permission as a lower-fps request',async()=>{
  let calls=0;
  const mediaDevices={async getUserMedia(){calls++;throw Object.assign(Error('denied'),{name:'NotAllowedError'});}};
  await assert.rejects(requestCamera(mediaDevices,{frameRate:{ideal:60,max:60}},false),/denied/);
  assert.equal(calls,1);
});
test('lets the browser choose an MP4 profile suitable for the requested resolution and fps',()=>{
  const previous=globalThis.MediaRecorder;
  globalThis.MediaRecorder={isTypeSupported:type=>type.startsWith('video/mp4')};
  try{assert.equal(chooseMimeType(),'video/mp4;codecs=avc1,mp4a.40.2');}
  finally{if(previous===undefined)delete globalThis.MediaRecorder;else globalThis.MediaRecorder=previous;}
});
