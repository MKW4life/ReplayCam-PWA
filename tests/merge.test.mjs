import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Input,MP4,WEBM,BlobSource,EncodedPacketSink} from '../vendor/mediabunny.js';
import {mergeReplay} from '../merge.js';
import {Mp4FragmentCollector} from '../mp4-fragments.js';

const fixture=async name=>new Blob([await readFile(new URL(`./fixtures/${name}`,import.meta.url))]);
async function inspect(blob){
  const input=new Input({source:new BlobSource(blob),formats:[MP4,WEBM]});
  try{
    const tracks=await input.getTracks();
    const result=[];
    for(const track of tracks){
      const packets=[];
      for await(const packet of new EncodedPacketSink(track).packets())packets.push(packet);
      result.push({codec:track.codec,packets});
    }
    return {tracks:result,duration:await input.computeDuration()};
  }finally{input.dispose();}
}
for(const format of ['mp4','webm'])test(`joins ${format} segments with both audio and video and resets timestamps`,async()=>{
  const original=await fixture(`av.${format}`);
  const before=await inspect(original);
  const result=await mergeReplay([original,original]);
  const after=await inspect(result);
  assert.equal(after.tracks.length,2);
  for(let i=0;i<2;i++){
    assert.equal(after.tracks[i].codec,before.tracks[i].codec);
    assert.equal(after.tracks[i].packets.length,before.tracks[i].packets.length*2);
    // Encoded media must survive byte-for-byte, without re-encoding or silent loss.
    for(let j=0;j<before.tracks[i].packets.length;j++){
      assert.deepEqual(after.tracks[i].packets[j].data,before.tracks[i].packets[j].data);
      assert.deepEqual(after.tracks[i].packets[j+before.tracks[i].packets.length].data,before.tracks[i].packets[j].data);
    }
    const boundary=after.tracks[i].packets[before.tracks[i].packets.length];
    assert.ok(boundary.timestamp>=before.duration-0.08);
  }
  assert.ok(Math.abs(after.duration-2*before.duration)<0.08);
});
test('invalid, empty and incompatible input fail without silently dropping a segment',async()=>{
  await assert.rejects(mergeReplay([]),/録画/);
  await assert.rejects(mergeReplay([new Blob(['broken'])]),/動画|形式|format/i);
  await assert.rejects(mergeReplay([await fixture('av.mp4'),await fixture('av.webm')]),/形式|設定/);
  await assert.rejects(mergeReplay([await fixture('av.mp4'),await fixture('silent.mp4')]),/形式|設定/);
});
test('nonzero timestamps normalize and portrait rotation survives',async()=>{
  const offset=await fixture('offset.mp4');
  const shifted=await inspect(await mergeReplay([offset,offset]));
  assert.ok(shifted.duration>1&&shifted.duration<1.5);
  const rotated=await fixture('rotated.mp4');
  const blob=await mergeReplay([rotated,rotated]);
  const input=new Input({source:new BlobSource(blob),formats:[MP4,WEBM]});
  try{assert.equal(await (await input.getPrimaryVideoTrack()).getRotation(),90);}
  finally{input.dispose();}
  await assert.rejects(mergeReplay([await fixture('av.mp4'),rotated]),/形式|設定/);
});
test('silent recordings merge without inventing an audio track',async()=>{
  const silent=await fixture('silent.mp4');
  assert.equal((await inspect(await mergeReplay([silent,silent]))).tracks.length,1);
});
test('all distinct segments retain their full audio/video packet sequence in order',async()=>{
  const blobs=[await fixture('av.mp4'),await fixture('av2.mp4'),await fixture('av.mp4')];
  const sources=await Promise.all(blobs.map(inspect));
  const merged=await inspect(await mergeReplay(blobs));
  for(let track=0;track<2;track++){
    const expected=sources.flatMap(source=>source.tracks[track].packets);
    assert.equal(merged.tracks[track].packets.length,expected.length);
    expected.forEach((packet,i)=>assert.deepEqual(merged.tracks[track].packets[i].data,packet.data));
  }
});
test('continuous rolling replay keeps native frame spacing when fragments are joined and trimmed',async()=>{
  const original=await fixture('continuous.mp4'),collector=new Mp4FragmentCollector();
  const fragments=await collector.push(original);await collector.finish();
  const result=await mergeReplay(fragments.slice(2),()=>{},undefined,{continuous:true,startTime:3.2,endTime:5});
  const before=await inspect(original),after=await inspect(result);
  const video=after.tracks[0].packets;
  assert.equal(video.length,20);
  for(let i=1;i<video.length;i++)assert.ok(Math.abs(video[i].timestamp-video[i-1].timestamp-0.1)<0.0001);
  video.forEach((packet,i)=>assert.deepEqual(packet.data,before.tracks[0].packets[i+30].data));
  assert.equal(after.tracks.length,2);
  assert.ok(after.duration>=2&&after.duration<2.1);
});
