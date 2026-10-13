import { openTestnetWorkspace, reloadTestnetWorkspace } from './harness';
// Synthetic browser acceptance only. The harness blocks external traffic and never uses a real wallet or chain.
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { verifyRequest } from '../../src/protocol';
import type { Attempt } from '../../src/storage';
import { payer, signed, txHash, unsigned } from '../fixtures';
import { harness, key, loadPay, origin, saved } from './harness';

test('synthetic: save a payment link before connecting a wallet, reopen the inbox and retain it after refresh',async({page,context})=>{
  const state=await harness(context);
  await loadPay(page,state.request);
  expect(await saved(page)).toEqual([]);
  await expect(page.locator('.wallet-menu > summary')).toContainText('Connect wallet');
  await page.getByRole('button',{name:'Save to payment inbox',exact:true}).click();
  await expect(page.getByRole('button',{name:'Saved in payment inbox',exact:true})).toBeDisabled();
  await expect(page.locator('.save-to-inbox').getByRole('status')).toContainText('No payment was made');
  const records=await saved(page);
  expect(records).toHaveLength(1);
  expect(await verifyRequest(records[0].request)).toEqual(state.request);
  expect(records[0].hashes).toEqual([]);

  await page.getByRole('link',{name:'Open payment inbox',exact:true}).click();
  await expect(page).toHaveURL(`${origin}/inbox`);
  const inbox=page.getByRole('region',{name:'Payment inbox',exact:true});
  await expect(inbox.getByRole('heading',{name:state.request.message.reference,exact:true})).toBeVisible();
  await expect(inbox.locator('.badge')).toHaveText('Not checked');
  await expect(inbox).toContainText('not cloud sync');
  await expect(inbox).toContainText('wallet’s complete payment history');
  await reloadTestnetWorkspace(page);
  await expect(inbox.getByRole('heading',{name:state.request.message.reference,exact:true})).toBeVisible();
  await expect(inbox.locator('.badge')).toHaveText('Not checked');
  await inbox.getByRole('link',{name:'Review payment request',exact:true}).click();
  await expect(page.locator('.request-title')).toHaveText(state.request.message.reference);
  await expect(page.getByRole('button',{name:'Saved in payment inbox',exact:true})).toBeDisabled();
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: removing an inbox bookmark preserves the signed request, known hashes and unresolved attempt',async({page,context})=>{
  const state=await harness(context);
  await openTestnetWorkspace(page,'/inbox');
  const bookmarkKey=`arc-payref:v1:inbox:${state.request.domain.chainId}:${state.request.requestId}`;
  const attempt:Attempt={version:1,id:'synthetic-inbox-unresolved',requestId:state.request.requestId,chainId:state.request.domain.chainId,payer,status:'UNKNOWN',hash:txHash,nonce:3,updatedAt:'2026-09-21T00:00:00.000Z',errorCode:'BROADCAST_UNKNOWN'};
  const attemptKey=`arc-payref:v1:attempt:${attempt.id}`;
  // Seed existing evidence explicitly as test data; the UI must never delete it to remove a bookmark.
  await page.evaluate(({requestKey,request,bookmarkKey,attemptKey,attempt,hash})=>{
    localStorage.setItem(requestKey,JSON.stringify({version:1,request,hashes:[hash]}));
    localStorage.setItem(bookmarkKey,JSON.stringify({version:1,chainId:request.domain.chainId,requestId:request.requestId,savedAt:'2026-09-21T00:00:00.000Z'}));
    localStorage.setItem(attemptKey,JSON.stringify(attempt));
  },{requestKey:key(state.request),request:state.request,bookmarkKey,attemptKey,attempt,hash:txHash});
  const before=await page.evaluate(({requestKey,attemptKey})=>({request:localStorage.getItem(requestKey),attempt:localStorage.getItem(attemptKey)}),{requestKey:key(state.request),attemptKey});
  await reloadTestnetWorkspace(page);
  const inbox=page.getByRole('region',{name:'Payment inbox',exact:true});
  await expect(inbox.locator('.badge')).toHaveText('Wallet unresolved');
  await inbox.getByRole('button',{name:'Remove bookmark',exact:true}).click();
  await expect(inbox.getByRole('heading',{name:'No saved payment requests',exact:true})).toBeVisible();
  await expect(inbox.getByRole('status')).toContainText('transaction hashes and payment attempts remain saved');
  expect(await page.evaluate(bookmarkKey=>localStorage.getItem(bookmarkKey),bookmarkKey)).toBeNull();
  expect(await page.evaluate(({requestKey,attemptKey})=>({request:localStorage.getItem(requestKey),attempt:localStorage.getItem(attemptKey)}),{requestKey:key(state.request),attemptKey})).toEqual(before);
  await reloadTestnetWorkspace(page);
  await expect(inbox.getByRole('heading',{name:'No saved payment requests',exact:true})).toBeVisible();
  expect((await saved(page)).find(record=>record.request)?.hashes).toEqual([txHash]);
  expect((await saved(page)).find(record=>record.status)).toMatchObject({...attempt});
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: QR expands locally into a nonblank canvas and downloads a matching PNG without remote QR requests',async({page,context},testInfo)=>{
  const state=await harness(context);
  await loadPay(page,state.request);
  const requests:string[]=[];
  page.on('request',request=>requests.push(request.url()));
  const qr=page.locator('.payment-qr');
  await expect(qr.getByRole('img',{name:'QR code for the signed payment request'})).toHaveCount(0);
  await qr.locator('summary').click();
  const image=qr.getByRole('img',{name:'QR code for the signed payment request'});
  await expect(image).toBeVisible();
  await expect(qr).toContainText('A different device cannot reach this website');
  const rendered=await image.evaluate((element:HTMLCanvasElement)=>{
    const rgba=element.getContext('2d')!.getImageData(0,0,element.width,element.height).data;
    let dark=0,light=0;
    for(let index=0;index<rgba.length;index+=4) {if(rgba[index]<100&&rgba[index+3]===255)dark++;if(rgba[index]===255&&rgba[index+3]===255)light++;}
    const bounds=element.getBoundingClientRect();
    return {width:element.width,height:element.height,dark,light,displayWidth:bounds.width,displayHeight:bounds.height};
  });
  expect(rendered.width).toBeGreaterThan(100);expect(rendered.height).toBe(rendered.width);
  expect(rendered.dark).toBeGreaterThan(100);expect(rendered.light).toBeGreaterThan(100);
  expect(Math.abs(rendered.displayWidth-rendered.displayHeight)).toBeLessThanOrEqual(1);
  const pending=page.waitForEvent('download');
  await qr.getByRole('button',{name:'Download QR image',exact:true}).click();
  const download=await pending;
  expect(download.suggestedFilename()).toBe('payref-payment-link.png');expect(download.url()).toMatch(/^blob:/);
  const path=await download.path();expect(path).not.toBeNull();
  const png=await readFile(path!);
  expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  expect(png.readUInt32BE(16)).toBe(rendered.width);expect(png.readUInt32BE(20)).toBe(rendered.height);
  expect(requests.filter(url=>/^https?:/.test(url)&&new URL(url).origin!==origin)).toEqual([]);
  await qr.screenshot({path:testInfo.outputPath('local-payment-qr.png')});
  await qr.locator('summary').click();
  await expect(image).toHaveCount(0);
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: mobile payment QR and inbox remain within the viewport with long request details',async({page,context},testInfo)=>{
  const state=await harness(context);
  state.request=await signed({...unsigned(),message:{...unsigned().message,reference:`MOBILE-${'X'.repeat(64)}`,description:'Synthetic long project description for mobile layout verification. '.repeat(4).trim()}});
  await page.setViewportSize({width:390,height:844});
  await loadPay(page,state.request);
  await page.locator('.payment-qr > summary').click();
  await expect(page.getByRole('img',{name:'QR code for the signed payment request'})).toBeVisible();
  const bounds=await page.getByRole('img',{name:'QR code for the signed payment request'}).boundingBox();
  expect(bounds).not.toBeNull();expect(Math.abs(bounds!.width-bounds!.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.request-detail').screenshot({path:testInfo.outputPath('mobile-payment-qr.png')});
  await page.getByRole('button',{name:'Save to payment inbox',exact:true}).click();
  await page.getByRole('link',{name:'Open payment inbox',exact:true}).click();
  const inbox=page.getByRole('region',{name:'Payment inbox',exact:true});
  await expect(inbox.getByRole('heading',{name:state.request.message.reference,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await inbox.screenshot({path:testInfo.outputPath('mobile-payment-inbox.png')});
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});
