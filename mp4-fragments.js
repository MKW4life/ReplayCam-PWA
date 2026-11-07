async function boxHeader(blob,final=false){
  if(blob.size<8)return null;
  const bytes=new Uint8Array(await blob.slice(0,16).arrayBuffer()),view=new DataView(bytes.buffer);
  let size=view.getUint32(0),header=8;
  const type=String.fromCharCode(...bytes.slice(4,8));
  if(size===1){if(blob.size<16)return null;size=Number(view.getBigUint64(8));header=16;}
  if(size===0){if(!final)return {type,header,open:true};size=blob.size;}
  if(!Number.isSafeInteger(size)||size<header)throw Error('動画の区間情報が不正です');
  return {size,header,type};
}

// Move absolute MP4 fragment offsets when preceding fragments are evicted.
// Relative/default-base-is-moof offsets remain unchanged.
async function relocateMoof(blob,delta){
  if(!delta)return blob;
  const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);
  const children=(start,end)=>{
    const result=[];
    for(let at=start;at+8<=end;){
      let size=view.getUint32(at),header=8;
      if(size===1){size=Number(view.getBigUint64(at+8));header=16;}
      if(size===0)size=end-at;
      if(size<header||at+size>end)throw Error('動画のフラグメントが不完全です');
      result.push({at,size,header,type:String.fromCharCode(...bytes.slice(at+4,at+8))});at+=size;
    }
    return result;
  };
  const root=children(0,bytes.length)[0];
  for(const traf of children(root.header,root.size).filter(box=>box.type==='traf')){
    const boxes=children(traf.at+traf.header,traf.at+traf.size),tfhd=boxes.find(box=>box.type==='tfhd');
    if(!tfhd)continue;
    const flags=view.getUint32(tfhd.at+tfhd.header)&0xffffff;
    if(flags&1){
      const field=tfhd.at+tfhd.header+8,base=view.getBigUint64(field)+BigInt(delta);
      view.setBigUint64(field,base>=0n?base:0n);
      if(base<0n){
        for(const trun of boxes.filter(box=>box.type==='trun')){
          if(view.getUint32(trun.at+trun.header)&1){
            const offset=trun.at+trun.header+8,value=BigInt(view.getInt32(offset))+base;
            if(value<-(2n**31n)||value>=2n**31n)throw Error('動画のデータ位置を再構成できません');
            view.setInt32(offset,Number(value));
          }
        }
      }
    }
  }
  return new Blob([bytes]);
}

export class Mp4FragmentCollector{
  pending=new Blob([]);offset=0;initParts=[];init=null;media=[];mediaOffset=0;fragmented=false;
  async push(blob,final=false){
    this.pending=new Blob([this.pending,blob]);const result=[];
    while(true){
      const header=await boxHeader(this.pending,final);
      if(header?.open)throw Error('このブラウザーの動画形式は連続リプレイに未対応です。通常録画モードをご利用ください。');
      if(!header||header.size>this.pending.size)break;
      const box=this.pending.slice(0,header.size),position=this.offset;
      this.pending=this.pending.slice(header.size);this.offset+=header.size;
      if(header.type==='ftyp'||header.type==='moov'){
        if(this.media.length||this.fragmented)throw Error('録画中に動画の形式が変わりました');
        this.initParts.push(box);
        if(header.type==='moov')this.init=new Blob(this.initParts);
      }else if(header.type==='moof'){
        if(!this.init||this.media.length)throw Error('連続録画の区間情報が不完全です');
        this.fragmented=true;this.mediaOffset=position;this.media=[box];
      }else if(header.type==='mdat'){
        if(!this.media.length)throw Error('このブラウザーのMP4は連続リプレイ保存に対応していません');
        const moof=await relocateMoof(this.media[0],this.init.size-this.mediaOffset);
        result.push(new Blob([this.init,moof,...this.media.slice(1),box],{type:'video/mp4'}));
        this.media=[];
      }else if(this.media.length)this.media.push(box);
    }
    return result;
  }
  async finish(){
    const result=await this.push(new Blob([]),true);
    if(this.pending.size||this.media.length)throw Error('動画データが途中で終了しています');
    return result;
  }
}

export async function joinContinuousFragments(blobs){
  if(!blobs.length)throw Error('保存可能な動画区間がありません');
  const output=[];let outputOffset=0,initialized=false;
  for(const [index,blob] of blobs.entries()){
    let at=0,inFragment=false;const init=[];
    while(at<blob.size){
      const box=await boxHeader(blob.slice(at),true);
      if(!box||at+box.size>blob.size)throw Error(`保存された動画区間が不完全です（区間${index+1}・位置${at}・宣言サイズ${box?.size??'不明'}・残り${blob.size-at}バイト）`);
      const data=blob.slice(at,at+box.size);
      if(box.type==='ftyp'||box.type==='moov')init.push(data);
      else if(box.type==='moof'){
        if(!initialized){const header=new Blob(init);output.push(header);outputOffset=header.size;initialized=true;}
        output.push(await relocateMoof(data,outputOffset-at));outputOffset+=data.size;
        inFragment=true;
      }else if(inFragment){output.push(data);outputOffset+=data.size;if(box.type==='mdat')inFragment=false;}
      at+=box.size;
    }
  }
  if(!initialized)throw Error('動画フラグメントを読み取れません');
  return new Blob(output,{type:'video/mp4'});
}
