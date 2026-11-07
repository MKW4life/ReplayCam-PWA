// Try the requested high frame rate first. Permission errors are never
// interpreted as a camera frame-rate limit.
export async function requestCamera(mediaDevices,video,audio){
  const fps=video.frameRate?.ideal;
  if(fps===60){
    try{return await mediaDevices.getUserMedia({video:{...video,frameRate:{exact:60}},audio});}
    catch(error){if(!['OverconstrainedError','NotSupportedError'].includes(error.name))throw error;}
  }
  return mediaDevices.getUserMedia({video,audio});
}
