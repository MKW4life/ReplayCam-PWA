import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Mp4FragmentCollector,joinContinuousFragments} from '../mp4-fragments.js';
import {Input,MP4,BlobSource,EncodedPacketSink} from '../vendor/mediabunny.js';

const fixture=()=>readFile(new URL('./fixtures/continuous.mp4',import.meta.url));
async function packets(blob){
  const input=new Input({source:new BlobSource(blob),formats:[MP4]});
  try{const video=await input.getPrimaryVideoTrack(),result=[];for await(const p of new EncodedPacketSink(video).packets())result.push({timestamp:p.timestamp,data:p.data});return result;}
  finally{input.dispose();}
}
test('arbitrary native chunk boundaries form fragments without losing or retiming video packets',async()=>{
  const bytes=await fixture(),collector=new Mp4FragmentCollector(),fragments=[];
  for(let start=0;start<bytes.length;start+=137)fragments.push(...await collector.push(new Blob([bytes.subarray(start,start+137)])));
  fragments.push(...await collector.finish());
  assert.ok(fragments.length>=5);
  const combined=await joinContinuousFragments(fragments);
  const before=await packets(new Blob([bytes])),after=await packets(combined);
  assert.equal(after.length,before.length);
  after.forEach((p,i)=>{assert.equal(p.timestamp,before[i].timestamp);assert.deepEqual(p.data,before[i].data);});
});
test('a rolling window can omit old fragments but retain the original native timeline',async()=>{
  const collector=new Mp4FragmentCollector();
  const fragments=await collector.push(new Blob([await fixture()]));await collector.finish();
  const all=await packets(await joinContinuousFragments(fragments));
  const tail=await packets(await joinContinuousFragments(fragments.slice(3)));
  assert.ok(tail[0].timestamp>2.5);
  assert.deepEqual(tail,all.slice(-tail.length));
});
test('truncated fragmented output is rejected rather than saved as a complete recording',async()=>{
  const bytes=await fixture(),collector=new Mp4FragmentCollector();
  await collector.push(new Blob([bytes.subarray(0,bytes.length-1000)]));
  await assert.rejects(collector.finish(),/途中|不完全/);
});
test('absolute fragment offsets are rebased correctly when old data is omitted',async()=>{
  const bytes=await readFile(new URL('./fixtures/continuous-absolute.mp4',import.meta.url));
  const collector=new Mp4FragmentCollector(),fragments=await collector.push(new Blob([bytes]));await collector.finish();
  const before=await packets(new Blob([bytes]));
  const tail=await packets(await joinContinuousFragments(fragments.slice(3)));
  assert.ok(tail[0].timestamp>2.5);
  assert.deepEqual(tail,before.slice(-tail.length));
});
test('non-fragmented open-ended output fails promptly instead of buffering forever',async()=>{
  const collector=new Mp4FragmentCollector();
  const header=new Uint8Array([0,0,0,0,109,100,97,116]);
  await assert.rejects(collector.push(new Blob([header])),/連続リプレイに未対応/);
});
