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
  await expect(page.locator('#version')).toContainText('v0.2.0');
  expect(await page.evaluate(()=>caches.has('unrelated-project-cache'))).toBe(true);
  expect(errors).toEqual([]);
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
