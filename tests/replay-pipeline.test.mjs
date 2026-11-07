import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePipeline} from '../replay-pipeline.js';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('starts the next capture before slow persistence and drains the last capture when stopped',async()=>{
  const captures=[deferred(),deferred()];let starts=0,running=true;
  const pipeline=capturePipeline(()=>captures[starts++].promise,()=>running,()=>{});
  const first=pipeline.next();captures[0].resolve({id:1});
  assert.deepEqual(await first,{value:{id:1},done:false});
  assert.equal(starts,2,'second capture must already be recording while first is being stored');
  running=false;captures[1].resolve({id:2});
  assert.deepEqual(await pipeline.next(),{value:{id:2},done:false});
  assert.equal((await pipeline.next()).done,true);assert.equal(starts,2);
});
test('stops and settles a pending recorder if persistence aborts the loop',async()=>{
  const captures=[deferred(),deferred()];let starts=0,stops=0;
  const pipeline=capturePipeline(()=>captures[starts++].promise,()=>true,()=>{stops++;captures[1].resolve({id:2});});
  const first=pipeline.next();captures[0].resolve({id:1});await first;
  await pipeline.return();assert.equal(stops,1);
});
