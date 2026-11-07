import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlobDestination} from '../merge-destination.js';

test('chunked output preserves appends, header patches and writes across chunk boundaries',async()=>{
  const destination=createBlobDestination(4);
  await destination.write({position:0,data:new TextEncoder().encode('abcdefghij')});
  await destination.write({position:2,data:new TextEncoder().encode('XYZ123')});
  await destination.write({position:10,data:new TextEncoder().encode('kl')});
  const blob=await destination.finish('video/mp4');
  assert.equal(await blob.text(),'abXYZ123ijkl');
  assert.equal(blob.type,'video/mp4');
});
test('sparse stream writes retain zero-filled gaps',async()=>{
  const destination=createBlobDestination(4);
  await destination.write({position:6,data:new Uint8Array([8,9])});
  assert.deepEqual([...new Uint8Array(await (await destination.finish('video/webm')).arrayBuffer())],[0,0,0,0,0,0,8,9]);
});
