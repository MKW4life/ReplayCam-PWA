import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOrientation} from '../lib.js';

test('capture orientation follows actual video dimensions rather than screen assumptions',()=>{
  assert.equal(captureOrientation(1920,1080),'landscape');
  assert.equal(captureOrientation(3840,2160),'landscape');
  assert.equal(captureOrientation(1080,1920),'portrait');
  assert.equal(captureOrientation(0,0),'unknown');
  assert.equal(captureOrientation(undefined,1080),'unknown');
  assert.equal(captureOrientation(720,720),'square');
});
