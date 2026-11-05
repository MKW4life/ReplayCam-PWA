import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSettings, resolutionDimensions, targetVideoBitrate, estimateRecordingBytes, cameraLabel} from '../lib.js';

test('high resolution settings survive reload and map to capture dimensions',()=>{
  assert.equal(safeSettings({resolution:2160}).resolution,2160);
  assert.equal(safeSettings({resolution:1440}).resolution,1440);
  assert.deepEqual(resolutionDimensions(2160),{width:3840,height:2160});
  assert.deepEqual(resolutionDimensions(1440),{width:2560,height:1440});
  assert.equal(safeSettings({resolution:9999}).resolution,1080);
});
test('estimate includes audio and rises with resolution and frame rate',()=>{
  assert.equal(estimateRecordingBytes({resolution:1080,fps:60,audio:true},180),182880000);
  assert.equal(estimateRecordingBytes({resolution:1080,fps:60,audio:false},180),180000000);
  assert.ok(targetVideoBitrate({resolution:2160,fps:60})>targetVideoBitrate({resolution:1440,fps:60}));
  assert.ok(targetVideoBitrate({resolution:2160,fps:60})>targetVideoBitrate({resolution:2160,fps:30}));
});
test('measured data replaces the bitrate estimate without NaN or stale zero rates',()=>{
  assert.equal(estimateRecordingBytes({resolution:1080,fps:60,audio:true},180,{bytes:1000000,seconds:10}),18000000);
  assert.equal(estimateRecordingBytes({resolution:1080,fps:60,audio:false},0),0);
  assert.equal(estimateRecordingBytes({resolution:1080,fps:60,audio:false},180,{bytes:0,seconds:0}),180000000);
});
test('camera labels distinguish actual unknown facing from rear camera',()=>{
  assert.equal(cameraLabel('environment'),'外カメラ（背面）');
  assert.equal(cameraLabel('user'),'内カメラ（前面）');
  assert.equal(cameraLabel(undefined),'カメラ種別未確認');
});
