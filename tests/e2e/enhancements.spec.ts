import { openTestnetWorkspace } from './harness';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { verifyRequest } from '../../src/protocol';
import { otherHash, signed, txHash, unsigned } from '../fixtures';
import { connectWallet, harness, importRequests, key, saved } from './harness';

test.describe('English UI in a Chinese browser locale',()=>{
  test.use({locale:'zh-CN'});
  test('synthetic: the custom upload control stays English and supports mouse and keyboard imports',async({page,context},testInfo)=>{
    const state=await harness(context);
    await openTestnetWorkspace(page,'/backups');
    const upload=page.getByLabel('Import JSON backup');
    await expect(page.locator('.upload-zone')).toContainText('Choose a JSON backup');
    // Native file-input labels are outside textContent; their visual presentation must be hidden.
    await expect(upload).toHaveCSS('opacity','0');
    await expect(upload).toBeEnabled();
    await upload.focus();
    await expect(upload).toBeFocused();
    await expect(page.locator('.upload-zone')).toHaveCSS('outline-style','solid');
    await page.locator('.backup-grid').screenshot({path:testInfo.outputPath('english-upload-zh-locale.png')});

    const keyboardChooser=page.waitForEvent('filechooser');
    await upload.press('Enter');
    await (await keyboardChooser).setFiles([]);
    const mouseChooser=page.waitForEvent('filechooser');
    await page.locator('.upload-zone').click();
    await (await mouseChooser).setFiles({name:'english-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,requests:[{request:state.request,hashes:[]}]}))});
    await expect(page.getByRole('heading',{name:'1 valid · 0 rejected'})).toBeVisible();
    await page.getByRole('button',{name:'Import validated requests',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('Imported 1 requests');
    expect((await saved(page)).filter(record=>record.request)).toHaveLength(1);
    expect(await page.locator('body').innerText()).not.toMatch(/\p{Script=Han}/u);
    expect(state.sent).toHaveLength(0);
    await openTestnetWorkspace(page,'/requests/new');
    await expect(page.locator('input[name=deadline]')).toHaveAttribute('type','text');
    await expect(page.locator('input[name=deadline]')).toHaveAttribute('placeholder','YYYY-MM-DD HH:mm');
    await page.locator('.form-panel').screenshot({path:testInfo.outputPath('english-composer-empty-zh-locale.png')});
    await connectWallet(page);
    await page.locator('input[name=reference]').fill('ENGLISH-DEADLINE-001');
    await page.locator('input[name=amount]').fill('0.01');
    await page.locator('input[name=deadline]').fill('2030-02-30 12:30');
    await expect(page.locator('.field-error')).toHaveText('Enter a valid local date and time as YYYY-MM-DD HH:mm.');
    await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
    await page.locator('input[name=deadline]').fill('2030-12-31 12:30');
    await expect(page.locator('.invoice-preview')).toContainText('12/31/2030');
    await expect(page.getByRole('button',{name:'Sign & create request'})).toBeEnabled();
    await page.locator('.form-panel').screenshot({path:testInfo.outputPath('english-composer-zh-locale.png')});
    const deadlineSeconds=await page.evaluate(()=>String(new Date(2030,11,31,12,30).getTime()/1000));
    await page.getByRole('button',{name:'Sign & create request'}).click();
    await expect(page.getByRole('status')).toContainText('Signed request saved');
    expect(state.request.message.expiresAt).toBe(deadlineSeconds);
    expect(await page.locator('body').innerText()).not.toMatch(/\p{Script=Han}/u);
    expect(state.sent).toHaveLength(0);
  });
});

async function downloadJson(page:Page,buttonName:string) {
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:buttonName,exact:true}).click();
  const download=await pending;
  return JSON.parse(await readFile(await download.path(),'utf8'));
}

test('synthetic: backup reminders track individual downloads, complete exports and newly imported hashes',async({page,context})=>{
  const state=await harness(context);
  const second=await signed({...unsigned(),message:{...unsigned().message,reference:'BACKUP-SECOND',description:'Synthetic second backup record'}});
  await importRequests(page,[state.request,second]);
  await expect(page.getByLabel('Backup reminder')).toContainText('2 requests not yet exported · 0 updated since export');

  await page.getByRole('navigation').getByRole('link',{name:'Payment requests'}).click();
  await page.getByRole('button',{name:`Open ${state.request.message.reference}`,exact:true}).click();
  const single=await downloadJson(page,'Download request JSON');
  expect(single.requests).toEqual([{request:state.request,hashes:[]}]);
  expect(single).not.toHaveProperty('exports');
  await expect(page.getByLabel('Backup reminder')).toContainText('1 requests not yet exported · 0 updated since export');
  await expect(page.getByRole('status')).toContainText('JSON download initiated');
  await page.getByRole('button',{name:'Close details',exact:true}).click();

  const complete=await downloadJson(page,'Download backup');
  expect(complete.requests).toHaveLength(2);
  await expect(page.getByLabel('Backup reminder')).toContainText('0 requests not yet exported · 0 updated since export');
  await expect(page.getByLabel('Backup reminder')).toContainText('Last download initiated');
  expect((await saved(page)).filter(record=>record.request)).toHaveLength(2);

  // Importing identical data preserves local history; importing a new hash makes
  // the previous JSON snapshot incomplete without asserting payment success.
  await importRequests(page,[state.request]);
  await expect(page.getByLabel('Backup reminder')).toContainText('0 requests not yet exported · 0 updated since export');
  await page.getByLabel('Import JSON backup').setInputFiles({name:'synthetic-new-hash.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,requests:[{request:state.request,hashes:[txHash]}]}))});
  await expect(page.getByRole('heading',{name:'1 valid · 0 rejected'})).toBeVisible();
  await page.getByRole('button',{name:'Import validated requests',exact:true}).click();
  await expect(page.getByLabel('Backup reminder')).toContainText('0 requests not yet exported · 1 updated since export');
  const records=(await saved(page)).filter(record=>record.request);
  expect(records).toHaveLength(2);
  expect(records.find(record=>record.request.requestId===state.request.requestId).hashes).toEqual([txHash]);
  const updated=await downloadJson(page,'Download backup');
  expect(updated.requests.find((record:{request:{requestId:string}})=>record.request.requestId===state.request.requestId).hashes).toEqual([txHash]);
  await expect(page.getByLabel('Backup reminder')).toContainText('0 requests not yet exported · 0 updated since export');
  await page.getByRole('navigation').getByRole('link',{name:'Payment requests'}).click();
  await expect(page.locator('.metric').nth(1)).toContainText('0.00');
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: damaged export metadata leaves requests usable and reports download tracking failure separately',async({page,context})=>{
  const state=await harness(context);
  await importRequests(page,[state.request]);
  await downloadJson(page,'Download backup');
  await page.evaluate(()=>localStorage.setItem('arc-payref:v1:exports','{damaged synthetic history'));
  await openTestnetWorkspace(page,'/requests');
  await expect(page.locator('.request-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.request-table')).toContainText(state.request.message.reference);
  await expect(page.getByLabel('Backup reminder')).toContainText('Backup reminder unavailable');
  await expect(page.getByLabel('Backup reminder')).toContainText('Saved requests are unaffected');
  await expect(page.getByLabel('Backup reminder')).not.toContainText('0 requests not yet exported');
  await expect(page.getByText('Records could not be loaded',{exact:true})).toHaveCount(0);

  const file=await downloadJson(page,'Download backup');
  expect(file.requests).toEqual([{request:state.request,hashes:[]}]);
  await expect(page.getByRole('alert')).toContainText('EXPORT_TRACKING_FAILED');
  await expect(page.getByRole('alert')).toContainText('download was initiated');
  await expect(page.locator('.request-table tbody tr')).toHaveCount(1);
  expect(await page.evaluate(()=>localStorage.getItem('arc-payref:v1:exports'))).toBe('{damaged synthetic history');
  expect(JSON.parse((await page.evaluate(recordKey=>localStorage.getItem(recordKey),key(state.request)))!).request).toEqual(state.request);
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: reusing a historical request preserves exact fields but creates a fresh independently signed request',async({page,context})=>{
  const state=await harness(context);
  const original=await signed({...unsigned(),message:{...unsigned().message,reference:'REUSE-PRECISE-001',description:'Synthetic consulting — exact six-decimal amount',amount:'123456789',expiresAt:String(Math.floor(Date.now()/1000)+86_400)}});
  await importRequests(page,[original]);
  const originalStored=await page.evaluate(recordKey=>localStorage.getItem(recordKey),key(original));
  await page.getByRole('navigation').getByRole('link',{name:'Payment requests'}).click();
  await page.getByRole('button',{name:`Open ${original.message.reference}`,exact:true}).click();
  await page.getByRole('link',{name:'Reuse as new request',exact:false}).click();
  await expect(page).toHaveURL(new RegExp(`/requests/new#reuse=${original.requestId}$`));
  await expect(page.locator('input[name=reference]')).toHaveValue(original.message.reference);
  await expect(page.locator('textarea[name=description]')).toHaveValue(original.message.description);
  await expect(page.locator('input[name=amount]')).toHaveValue('123.456789');
  await expect(page.locator('input[name=deadline]')).toHaveValue('');
  await expect(page.getByRole('note')).toContainText('original request and its shared link remain unchanged');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  await connectWallet(page);
  await page.getByRole('button',{name:'Sign & create request'}).click();
  await expect(page.getByRole('status')).toContainText('Signed request saved');
  const records=(await saved(page)).filter(record=>record.request);
  expect(records).toHaveLength(2);
  const created=await verifyRequest(records.find(record=>record.request.requestId!==original.requestId).request);
  expect(created.message).toMatchObject({reference:original.message.reference,description:original.message.description,amount:original.message.amount,payee:original.message.payee,expiresAt:'0'});
  expect(created.domain).toEqual(original.domain);
  expect(created.message.nonce).not.toBe(original.message.nonce);
  expect(created.requestId).not.toBe(original.requestId);
  expect(created.signature).not.toBe(original.signature);
  expect(await page.evaluate(recordKey=>localStorage.getItem(recordKey),key(original))).toBe(originalStored);
  expect(state.request).toEqual(created);
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: changing a valid reuse link to a missing request never leaves its previous draft signable',async({page,context})=>{
  const state=await harness(context);
  await importRequests(page,[state.request]);
  await page.goto(`/requests/new#reuse=${state.request.requestId}`);
  await expect(page.locator('input[name=reference]')).toHaveValue(state.request.message.reference);
  await connectWallet(page);
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeEnabled();

  // Stay in the same React app so the old source state exists when hashchange runs.
  await page.evaluate(missingId=>{location.hash=`reuse=${missingId}`;},otherHash);
  await expect(page.getByRole('alert')).toContainText('MISSING_REQUEST');
  await expect(page.getByText('Original request unavailable',{exact:true})).toBeVisible();
  await expect(page.locator('input[name=reference]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Sign & create request'})).toHaveCount(0);
  await expect(page.getByRole('note')).toHaveCount(0);
  expect((await saved(page)).filter(record=>record.request)).toHaveLength(1);

  await page.getByRole('link',{name:'Start a blank request',exact:true}).click();
  await expect(page.locator('input[name=reference]')).toHaveValue('');
  await expect(page.locator('input[name=amount]')).toHaveValue('');
  await expect(page.locator('textarea[name=description]')).toHaveValue('');
  await expect(page.locator('input[name=deadline]')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});
