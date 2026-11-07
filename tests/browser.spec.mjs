import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {Input,MP4,WEBM,BlobSource,EncodedPacketSink} from '../vendor/mediabunny.js';

test('mobile controls persist high resolution and camera choice, estimates respond to settings',async({page})=>{
  await page.goto('/');
  await expect(page.locator('#capacity-estimate')).toContainText('174.4 MB');
  await page.locator('#resolution').selectOption('2160');
  await expect(page.locator('#capacity-estimate')).toContainText('689.4 MB');
  await page.locator('#facing').selectOption('user');
  await expect(page.locator('#camera-status')).toContainText('選択中：内カメラ');
  await page.reload();
  await expect(page.locator('#resolution')).toHaveValue('2160');
  await expect(page.locator('#facing')).toHaveValue('user');
  await expect(page.locator('#camera-status')).toContainText('内カメラ');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#mode-standard').click();
  await expect(page.locator('#capacity-estimate')).toContainText('通常録画1分あたり');
});

test('real browser recording exports a merged file with audio, explicit ZIP and offline export',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await expect(page.locator('#facing')).toBeDisabled();
  await page.waitForTimeout(1800);
  await page.locator('#save-button').click();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await expect(page.locator('#save-button')).toBeEnabled();
  await page.waitForTimeout(1500);
  await page.locator('#save-button').click();
  await expect(page.locator('.clip-row')).toHaveCount(2);
  await page.locator('#stop-button').click();
  await expect(page.locator('#start-button')).toBeEnabled();
  await page.locator('.open-clip').first().click();
  await expect(page.locator('#export-all')).toHaveText('結合して動画をDL');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.evaluate(()=>caches.open('unrelated-project-cache'));
  await context.setOffline(true);
  const downloadEvent=page.waitForEvent('download');
  await page.locator('#export-all').click();
  const download=await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  const input=new Input({source:new BlobSource(new Blob([await readFile(await download.path())])),formats:[MP4,WEBM]});
  try{
    expect(await input.getPrimaryVideoTrack()).toBeTruthy();
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(2);
    let count=0;for await(const p of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets())count++;
    expect(count).toBeGreaterThan(20);
  }finally{input.dispose();}
  const zipEvent=page.waitForEvent('download');
  await page.locator('#export-zip').click();
  expect((await zipEvent).suggestedFilename()).toMatch(/\.zip$/);
  await page.locator('#dialog-close').click();
  await page.reload();
  await expect(page.locator('#version')).toContainText('v0.2.1');
  expect(await page.evaluate(()=>caches.has('unrelated-project-cache'))).toBe(true);
  expect(errors).toEqual([]);
});

test('landscape recording downloads landscape video and keeps the controls visible',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await expect(page.locator('#orientation-status')).toContainText('横向き');
  await page.locator('#mode-standard').click();
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await expect(page.locator('#orientation-status')).toContainText('横向きで録画中');
  const bounds=await page.locator('#stop-button').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y+bounds.height).toBeLessThanOrEqual(390);
  const view=await page.locator('#camera').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,fit:getComputedStyle(video).objectFit}));
  expect(view.width).toBeGreaterThan(view.height);
  expect(view.fit).toBe('contain');
  await page.screenshot({path:test.info().outputPath('landscape.png')});
  await page.waitForTimeout(1300);
  await page.locator('#stop-button').click();
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toContainText('横向き');
  await page.locator('.open-clip').click();
  const event=page.waitForEvent('download');
  await page.locator('#export-all').click();
  const download=await event;
  const input=new Input({source:new BlobSource(new Blob([await readFile(await download.path())])),formats:[MP4,WEBM]});
  try{
    const video=await input.getPrimaryVideoTrack();
    expect(video).toBeTruthy();
    expect(await video.getDisplayWidth()).toBeGreaterThan(await video.getDisplayHeight());
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(0.5);
  }finally{input.dispose();}
});

test('turning the device during replay saves the current buffer and ends recording',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await page.waitForTimeout(1200);
  // Viewport orientation changes exercise the same matchMedia event used by
  // mobile browsers when the page rotates. No physical camera is accessed.
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await expect(page.locator('#toast')).toContainText('向きが変わった');
});

test('turning the device during standard recording saves a playable video',async({page})=>{
  await page.setViewportSize({width:844,height:390});
  await page.goto('/');
  await page.locator('#mode-standard').click();
  await page.locator('#resolution').selectOption('720');
  await page.locator('#fps').selectOption('30');
  await page.locator('#start-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await page.waitForTimeout(1200);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#start-button')).toBeEnabled();
  await expect(page.locator('.clip-row')).toHaveCount(1);
  await page.locator('.open-clip').click();
  const event=page.waitForEvent('download');
  await page.locator('#export-all').click();
  const input=new Input({source:new BlobSource(new Blob([await readFile(await (await event).path())])),formats:[MP4,WEBM]});
  try{expect(await input.computeDuration()).toBeGreaterThan(0.5);expect(await input.getPrimaryVideoTrack()).toBeTruthy();}
  finally{input.dispose();}
});

test('unreadable saved segments automatically download ZIP and remain saved',async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const {addPart,putSaved}=await import('./storage.js');
    const partIds=[];
    for(let i=0;i<2;i++)partIds.push(await addPart({blob:new Blob(['invalid']),mime:'video/mp4',bytes:7}));
    await putSaved({id:'broken-fixture',name:'Broken',kind:'replay',created:Date.now(),partIds,seconds:1,bytes:14,mime:'video/mp4'});
  });
  await page.locator('#refresh-library').click();
  await page.locator('.open-clip').click();
  const event=page.waitForEvent('download');
  await page.locator('#export-all').click();
  expect((await event).suggestedFilename()).toBe('Broken.zip');
  await page.locator('#dialog-close').click();
  await expect(page.locator('.clip-row')).toHaveCount(1);
});
