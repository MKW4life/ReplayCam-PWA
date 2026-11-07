import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOrientation,containedFrame} from '../lib.js';

test('capture orientation follows actual video dimensions rather than screen assumptions',()=>{
  assert.equal(captureOrientation(1920,1080),'landscape');
  assert.equal(captureOrientation(3840,2160),'landscape');
  assert.equal(captureOrientation(1080,1920),'portrait');
  assert.equal(captureOrientation(0,0),'unknown');
  assert.equal(captureOrientation(undefined,1080),'unknown');
  assert.equal(captureOrientation(720,720),'square');
});
test('recording boundary follows the full letterboxed image in either screen orientation',()=>{
  assert.deepEqual(containedFrame(800,300,1920,1080),{left:133.33333333333331,top:0,width:533.3333333333334,height:300});
  assert.deepEqual(containedFrame(360,400,1080,1920),{left:67.5,top:0,width:225,height:400});
  assert.equal(containedFrame(360,400,0,0),null);
});
