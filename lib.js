export const REPLAY_OPTIONS = [3, 5, 10, 15];
export const SEGMENT_LENGTH_MS = 15000;
export const SETTINGS_DEFAULTS = Object.freeze({duration:3,resolution:1080,fps:60,audio:true,facing:'environment'});

export function safeSettings(raw = {}) {
  const valid = {...SETTINGS_DEFAULTS};
  if (REPLAY_OPTIONS.includes(Number(raw.duration))) valid.duration=Number(raw.duration);
  if ([720,1080].includes(Number(raw.resolution))) valid.resolution=Number(raw.resolution);
  if ([30,60].includes(Number(raw.fps))) valid.fps=Number(raw.fps);
  if (typeof raw.audio === 'boolean') valid.audio=raw.audio;
  if (['user','environment'].includes(raw.facing)) valid.facing=raw.facing;
  return valid;
}
export function formatDuration(seconds) {
  seconds=Math.max(0,Math.floor(seconds || 0));
  const mins=Math.floor(seconds/60),secs=seconds%60;
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes<0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
export function chooseMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm']) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return '';
}
export function extensionFor(mime = '') { return mime.startsWith('video/mp4') ? 'mp4' : 'webm'; }
export function selectReplayParts(parts, durationMs) {
  if (!parts.length) return [];
  const lastEnd=parts[parts.length-1].ended;
  // Keep complete, independently playable segments. The earliest retained
  // section may extend by up to one segment beyond the selected duration.
  const selected=parts.filter(part => part.ended > lastEnd-durationMs);
  return selected.length?selected:[parts.at(-1)];
}
export function fileStamp(date = new Date()) {
  const p=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
