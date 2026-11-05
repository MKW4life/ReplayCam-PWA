// Dependency-free ZIP32 (store/no compression) implementation.
// This preserves each self-contained MP4/WebM segment rather than incorrectly
// concatenating incompatible MP4 headers. Processes CRC in small blocks.
const encoder=new TextEncoder();
const table=new Uint32Array(256);
for(let n=0;n<256;n++) {let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
function crcUpdate(crc, bytes) {for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return crc>>>0;}
async function crcBlob(blob) {
  let crc=0xffffffff;
  for(let offset=0;offset<blob.size;offset+=1024*1024){
    const chunk=new Uint8Array(await blob.slice(offset,Math.min(offset+1024*1024,blob.size)).arrayBuffer());
    crc=crcUpdate(crc,chunk);
  }
  return (crc^0xffffffff)>>>0;
}
function header(size){return new DataView(new ArrayBuffer(size));}
function dosTime(date) {
  const year=Math.min(2107,Math.max(1980,date.getFullYear()));
  const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
  const day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  return {time,day};
}
export async function createZip(entries,onProgress=()=>{}) {
  if(entries.length>65535) throw Error('ZIPのファイル数上限を超えました');
  const contents=[], central=[];
  let offset=0;
  const date=dosTime(new Date());
  for(let index=0;index<entries.length;index++){
    const item=entries[index];
    const filename=encoder.encode(item.name.replaceAll('\\','/').replace(/^\/+/,''));
    if(filename.length>65535)throw Error('ファイル名が長すぎます');
    const blob=item.blob;
    const crc=await crcBlob(blob);
    if(blob.size>0xffffffff || offset>0xffffffff)throw Error('ZIP32の4GB上限を超えました');
    const local=header(30);
    local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x0800,true);
    local.setUint16(8,0,true);local.setUint16(10,date.time,true);local.setUint16(12,date.day,true);
    local.setUint32(14,crc,true);local.setUint32(18,blob.size,true);local.setUint32(22,blob.size,true);
    local.setUint16(26,filename.length,true);local.setUint16(28,0,true);
    contents.push(local.buffer,filename,blob);
    const cd=header(46);
    cd.setUint32(0,0x02014b50,true);cd.setUint16(4,20,true);cd.setUint16(6,20,true);
    cd.setUint16(8,0x0800,true);cd.setUint16(10,0,true);cd.setUint16(12,date.time,true);cd.setUint16(14,date.day,true);
    cd.setUint32(16,crc,true);cd.setUint32(20,blob.size,true);cd.setUint32(24,blob.size,true);
    cd.setUint16(28,filename.length,true);cd.setUint16(30,0,true);cd.setUint16(32,0,true);
    cd.setUint16(34,0,true);cd.setUint16(36,0,true);cd.setUint32(38,0,true);cd.setUint32(42,offset,true);
    central.push(cd.buffer,filename);
    offset+=30+filename.length+blob.size;
    onProgress(index+1,entries.length);
  }
  const cSize=central.reduce((n,x)=>n+x.byteLength,0);
  if(offset+cSize>0xffffffff)throw Error('ZIP32の4GB上限を超えました');
  const end=header(22);
  end.setUint32(0,0x06054b50,true);end.setUint16(4,0,true);end.setUint16(6,0,true);
  end.setUint16(8,entries.length,true);end.setUint16(10,entries.length,true);
  end.setUint32(12,cSize,true);end.setUint32(16,offset,true);end.setUint16(20,0,true);
  return new Blob([...contents,...central,end.buffer],{type:'application/zip'});
}
