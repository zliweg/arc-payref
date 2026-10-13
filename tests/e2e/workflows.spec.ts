import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { paymentData, requestLink, verifyRequest } from '../../src/protocol';
import { MEMO } from '../../src/config';
import { payer, signed, txHash, unsigned } from '../fixtures';
import { connectWallet, harness, importRequests, key, loadPay, origin, saved, navigateTo, preparePayment } from './harness';

test('synthetic: create, validate exact amount, sign, share, download and reload',async({page,context})=>{
  const state=await harness(context);
  await page.goto('/requests/new');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  await connectWallet(page);
  await page.getByLabel('Request template').selectOption('Consulting session');
  await expect(page.locator('input[name=reference]')).toHaveValue('SESSION-001');
  await page.locator('input[name=amount]').fill('1.0000001');
  await expect(page.getByText('Enter a positive amount with up to 6 decimal places.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  await page.locator('input[name=amount]').fill('125.123456');
  await page.getByRole('button',{name:'Sign & create request'}).click();
  await expect(page.getByRole('status')).toContainText('Signed request saved');
  const records=await saved(page);
  expect(records).toHaveLength(1);
  expect((await verifyRequest(records[0].request)).message.amount).toBe('125123456');
  await expect(page.getByText('This reference is already used', {exact:false})).toBeVisible();
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  const link=await page.evaluate(()=>navigator.clipboard.readText());
  expect(link).toBe(requestLink(state.request,origin));
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download request JSON'}).click();
  const file=JSON.parse(await readFile(await (await pending).path(),'utf8'));
  expect(file.requests[0].request).toEqual(state.request);
  await navigateTo(page,'Payment requests');
  await expect(page.locator('.request-table')).toContainText('125.123456');
  await page.reload();
  await expect(page.locator('.request-table')).toContainText('SESSION-001');
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
  state.account=payer;
  const payerPage=await context.newPage();await payerPage.goto(link);await expect(payerPage.locator('.request-title')).toHaveText('SESSION-001');
  await connectWallet(payerPage);await payerPage.getByRole('button',{name:'Check payment & fees',exact:true}).click();
  // The amount exceeds the synthetic wallet balance: the signed amount cannot be silently reduced.
  await expect(payerPage.getByRole('alert')).toContainText('INSUFFICIENT_BALANCE');expect(state.sent).toHaveLength(0);
  state.balance=200n*10n**18n;
  await preparePayment(payerPage);await payerPage.getByRole('button',{name:'Confirm & pay 125.123456 USDC',exact:true}).click();await expect(payerPage.getByRole('status')).toContainText('Submitted');
  expect(state.attemptsBeforeSend).toEqual(['AWAITING_SIGNATURE']);
  state.mined=true;await expect(payerPage.locator('.verified-receipt')).toContainText('125.123456 USDC');
  await expect.poll(async()=>(await saved(payerPage)).find(r=>r.status)?.status).toBe('CONFIRMED');
});

test('synthetic: pay once, pending is not paid, verify, share receipt, print and reconcile',async({page,context,browser})=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);
  await preparePayment(page);await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Submitted');
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0]).toMatchObject({from:payer,to:MEMO,data:paymentData(state.request),value:'0x0',nonce:'0x3'});
  expect((await saved(page)).find(r=>r.status)?.status).toBe('SUBMITTED');
  await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Stop automatic checks'}).click();
  await expect(page.getByRole('region',{name:'Payment progress'})).toContainText('Automatic checking stopped');
  await page.getByRole('button',{name:'Verify receipt',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('RPC_READ_FAILED');
  await expect(page.locator('.verified-receipt')).toHaveCount(0);
  await page.reload();await expect(page.locator('.request-title')).toBeVisible();
  await connectWallet(page);await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  state.mined=true;
  // Reload resumes bounded read-only verification without another wallet send.
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified');
  expect((await saved(page)).find(r=>r.status)?.status).toBe('CONFIRMED');
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'Share receipt'}).click();
  const receiptLink=await page.evaluate(()=>navigator.clipboard.readText());
  expect(receiptLink).toContain('/receipt#');expect(receiptLink).toContain(txHash);
  let printed=false;await page.exposeFunction('__printed',()=>{printed=true;});
  await page.evaluate(()=>{window.print=()=>{void(window as unknown as {__printed:()=>Promise<void>}).__printed();};});
  await page.getByRole('button',{name:'Print receipt'}).click();expect(printed).toBe(true);
  await page.emulateMedia({media:'print'});
  await expect(page.locator('.verified-receipt')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.emulateMedia({media:'screen'});
  await navigateTo(page,'Payment requests');
  await expect(page.locator('.metric').nth(1)).toContainText('0.01');
  await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('1 of 1 requests fully checked');
  await expect(page.locator('.metric').nth(2).locator('strong')).toContainText('0');
  const clean=await browser.newContext();const cleanState=await harness(clean);cleanState.mined=true;
  try{
    const recipient=await clean.newPage();await recipient.goto(receiptLink);
    await expect(recipient.locator('.request-title')).toBeVisible();
    await expect(recipient.locator('.verified-receipt')).toHaveCount(0);
    await recipient.getByRole('button',{name:'Verify receipt',exact:true}).click();
    await expect(recipient.locator('.verified-receipt')).toContainText('0.01 USDC');
  }finally{await clean.close();}
  expect(state.unexpected).toEqual([]);
});

test('synthetic: JSON preview, partial rejection, merge, dedup, CSV and clean restoration',async({page,context,browser})=>{
  const state=await harness(context);
  const malicious=await signed({...unsigned(),message:{...unsigned().message,reference:'=1+1',description:'<img src=x onerror=alert(1)>'}});
  await importRequests(page,[state.request,malicious]);
  await importRequests(page,[state.request]);
  expect((await saved(page)).filter(r=>r.request)).toHaveLength(2);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download backup'}).click();
  const backup=await readFile(await (await download).path());
  const csvDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const csv=await readFile(await (await csvDownload).path(),'utf8');
  expect(csv).toContain('"\'=1+1"');expect(csv).toContain('NOT_VERIFIED_IN_THIS_SESSION');
  const clean=await browser.newContext();await harness(clean);
  try{
    const restored=await clean.newPage();await restored.goto(`${origin}/backups`);
    await restored.getByLabel('Import JSON backup').setInputFiles({name:'restored.json',mimeType:'application/json',buffer:backup});
    await expect(restored.getByRole('heading',{name:'2 valid · 0 rejected'})).toBeVisible();
    await expect(restored.getByRole('status')).toContainText('Validation finished: 2 valid, 0 rejected');
    await expect(restored.getByRole('status')).not.toContainText('Working');
    expect(await saved(restored)).toHaveLength(0);
    await restored.getByRole('button',{name:'Import validated requests'}).click();
    await restored.getByRole('navigation').getByRole('link',{name:'Payment requests'}).click();
    await expect(restored.locator('.request-table tbody tr')).toHaveCount(2);
    await expect(restored.locator('.request-table img')).toHaveCount(0);
    await expect(restored.locator('.metric').nth(1)).toContainText('0.00');
  }finally{await clean.close();}
  const tampered={...state.request,message:{...state.request.message,amount:'999'}};
  await page.getByLabel('Import JSON backup').setInputFiles({name:'mixed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,requests:[{request:state.request,hashes:[]},{request:tampered,hashes:[],status:'PAID'}]}))});
  await expect(page.getByRole('heading',{name:'1 valid · 1 rejected'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Validation finished: 1 valid, 1 rejected');
  await page.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(page.locator('.import-preview')).toHaveCount(0);
  await page.getByLabel('Import JSON backup').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{invalid')});
  await expect(page.getByRole('alert')).toContainText('INVALID_BACKUP');
  expect((await saved(page)).filter(r=>r.request)).toHaveLength(2);
});

test('synthetic: search, filters, sort, drawer, navigation and network separation',async({page,context})=>{
  const state=await harness(context);
  const second=await signed({...unsigned(),message:{...unsigned().message,reference:'ZZZ-002',amount:'123456789',expiresAt:'1'}});
  await importRequests(page,[state.request,second]);
  await navigateTo(page,'Payment requests');
  await expect(page.locator('.metric').first()).toContainText('123.466789');
  await page.getByLabel('Sort requests').selectOption('amount');
  await expect(page.locator('tbody tr').first()).toContainText('ZZZ-002');
  await page.getByLabel('Search requests').fill('missing');await expect(page.getByText('No matching requests', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear filters'}).click();
  await page.getByRole('group',{name:'Filter requests'}).getByRole('button',{name:'Deadline reached',exact:true}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:'Open ZZZ-002',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'All requests',exact:true}).click();
  await page.getByRole('button',{name:'Open TEST-001',exact:true}).click();
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.locator('.wallet-menu > summary').click();await page.getByLabel('Network',{exact:true}).selectOption('5042');
  await expect(page.getByText('Make your next payment easier to trace.')).toBeVisible();
  await expect(page.locator('.metric').first()).toContainText('0.00');
  await page.getByLabel('Network',{exact:true}).selectOption('5042002');await page.locator('.wallet-menu > summary').click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('navigation').getByRole('link',{name:'Wallet activity'}).click();await expect(page.getByText('No wallet attempts recorded',{exact:true})).toBeVisible();
  await page.goBack();await expect(page.locator('tbody tr')).toHaveCount(2);
});

for(const failure of ['rejected','unknown'] as const)test(`synthetic: ${failure} send persists honestly across reload`,async({page,context})=>{
  const state=await harness(context);state.account=payer;state.sendError=failure==='rejected'?4001:-32603;
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(failure==='rejected'?'rejected':'BROADCAST_UNKNOWN');
  expect((await saved(page)).find(r=>r.status)?.status).toBe(failure==='rejected'?'REJECTED':'UNKNOWN');
  await page.reload();await expect(page.locator('.request-title')).toBeVisible();await connectWallet(page);
  const pay=page.getByRole('button',{name:'Check payment & fees',exact:true});
  if(failure==='unknown'){
    await expect(pay).toBeDisabled();state.mined=true;
    await page.getByLabel('Recovery transaction hash').fill(txHash);await page.getByRole('button',{name:'Check transaction',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('matching payment is verified');
    expect((await saved(page)).find(r=>r.status)?.status).toBe('CONFIRMED');
  }else await expect(pay).toBeEnabled();
  expect(state.sent).toHaveLength(1);
});

test('synthetic: duplicate receipts counted once per transaction and incomplete scans retain evidence',async({page,context})=>{
  const state=await harness(context);state.mined=true;state.duplicate=true;
  await importRequests(page,[state.request]);await navigateTo(page,'Payment requests');
  await page.getByRole('button',{name:'Check all',exact:true}).click();await expect(page.getByRole('status')).toContainText('fully checked');
  await expect(page.locator('.metric').nth(1)).toContainText('0.02');await expect(page.locator('tbody')).toContainText('Duplicate');
  await expect.poll(async()=>(await saved(page)).find(r=>r.request)?.hashes.length).toBe(2);
  state.logError=true;await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('1 incomplete or failed');
  await expect(page.locator('.metric').nth(1)).toContainText('0.02');await expect(page.locator('.metric').nth(2).locator('strong')).toContainText('1');
  await page.getByRole('button',{name:'Open TEST-001',exact:true}).click();
  await expect(page.locator('.verified-receipt')).toHaveCount(2);
});

test('synthetic: two tabs coordinate one payment and receive saved updates',async({page,context})=>{
  const state=await harness(context);state.account=payer;state.sendDelay=1000;state.logDelay=400;
  // Finish the first page's cold startup before opening another tab. The original
  // trace exhausted the test budget during background navigation, before either
  // Confirm click ran; the payment operations below must still race concurrently.
  await page.bringToFront();
  await loadPay(page,state.request);await connectWallet(page);
  const other=await context.newPage();
  await loadPay(other,state.request);await connectWallet(other);
  await Promise.all([preparePayment(page),preparePayment(other)]);
  await Promise.all([page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click(),other.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click()]);
  await expect.poll(()=>state.sent.length).toBe(1);
  await expect.poll(async()=>(await saved(page)).find(r=>r.status)?.status).toBe('SUBMITTED');
  expect(state.attemptsBeforeSend).toEqual(['AWAITING_SIGNATURE']);
  await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  await expect(other.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  const alerts=await page.getByRole('alert').allTextContents();const otherAlerts=await other.getByRole('alert').allTextContents();
  expect([...alerts,...otherAlerts].join(' ')).toContain('BUSY_OTHER_TAB');
  const attempts=(await saved(page)).filter(record=>record.status);
  expect(attempts).toHaveLength(1);
  expect((await saved(other)).filter(record=>record.status)).toEqual(attempts);
  expect(state.sent).toHaveLength(1);
});

test('synthetic: restore receipt link, saved hash, filtered CSV and oversized input rejection',async({page,context})=>{
  const state=await harness(context);await page.goto('/backups');
  await page.getByLabel('Restore from a PayRef link').fill(requestLink(state.request,origin,txHash));
  await page.getByRole('button',{name:'Review request',exact:false}).click();await expect(page.getByRole('heading',{name:'1 valid · 0 rejected'})).toBeVisible();
  expect(await saved(page)).toHaveLength(0);await page.getByRole('button',{name:'Import validated requests'}).click();
  await navigateTo(page,'Payment requests');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export view',exact:false}).click();
  expect(await readFile(await (await download).path(),'utf8')).toContain('NOT_VERIFIED_IN_THIS_SESSION');
  await page.getByRole('button',{name:'Open TEST-001',exact:true}).click();await page.getByLabel('Transaction hash',{exact:true}).fill('');
  await page.getByLabel('Saved transaction hashes').selectOption(txHash);await expect(page.getByLabel('Transaction hash',{exact:true})).toHaveValue(txHash);
  await page.getByRole('link',{name:'Open payment page',exact:false}).click();await expect(page).toHaveURL(/\/pay#/);
  await expect(page.locator('.request-title')).toHaveText('TEST-001');
  await navigateTo(page,'Backups & exports');
  await page.getByLabel('Import JSON backup').setInputFiles({name:'oversized.json',mimeType:'application/json',buffer:Buffer.alloc(2*1024*1024+1,' ')});
  await expect(page.getByRole('alert')).toContainText('TOO_LARGE');expect((await saved(page)).filter(r=>r.request)).toHaveLength(1);
});

test('synthetic: expired requests allow historical verification but cannot initiate payment',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  state.request=await signed({...unsigned(),message:{...unsigned().message,expiresAt:'1'}});
  await loadPay(page,state.request);await connectWallet(page);
  await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  state.mined=true;await page.getByLabel('Transaction hash',{exact:true}).fill(txHash);await page.getByRole('button',{name:'Verify receipt',exact:true}).click();
  await expect(page.locator('.verified-receipt')).toContainText('Received after the deadline');expect(state.sent).toHaveLength(0);
});

test('synthetic: cancellation during final RPC cannot declare full coverage',async({page,context})=>{
  const state=await harness(context);state.logDelay=1200;
  await loadPay(page,state.request);await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Scanning blocks');
  await page.getByRole('button',{name:'Cancel scan'}).click();
  await expect(page.getByRole('status')).toContainText('Scan cancelled');
  await expect(page.locator('.request-status')).not.toContainText('No payment found');
});

test('synthetic: invalid link/hash, wrong receipt, insufficient gas balance and self-payment block',async({page,context})=>{
  const state=await harness(context);await loadPay(page,state.request);await connectWallet(page);
  await page.getByRole('button',{name:'Check payment & fees',exact:true}).click();await expect(page.getByRole('alert')).toContainText('SELF_PAYMENT');
  state.account=payer;state.balance=10_000n*10n**12n;await page.reload();await expect(page.locator('.request-title')).toBeVisible();await connectWallet(page);
  await page.getByRole('button',{name:'Check payment & fees',exact:true}).click();await expect(page.getByRole('alert')).toContainText('INSUFFICIENT_BALANCE');expect(state.sent).toHaveLength(0);
  await page.getByLabel('Transaction hash',{exact:true}).fill('0x123');await page.getByRole('button',{name:'Verify receipt',exact:true}).click();await expect(page.getByRole('alert')).toContainText('INVALID_HASH');
  state.mined=true;state.receiptMismatch=true;await page.getByLabel('Transaction hash',{exact:true}).fill(txHash);await page.getByRole('button',{name:'Verify receipt',exact:true}).click();await expect(page.getByRole('alert')).toContainText('EVIDENCE_MISMATCH');await expect(page.locator('.verified-receipt')).toHaveCount(0);
  await page.getByRole('button',{name:'Load another request'}).click();await page.getByLabel('Signed request link').fill('bad request');await page.getByRole('button',{name:'Load & verify',exact:false}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.request-title')).toHaveCount(0);
});

test('synthetic: signing rejection and quota failure never say saved',async({page,context})=>{
  const state=await harness(context);state.signError=4001;
  await page.goto('/requests/new');await connectWallet(page);await page.locator('input[name=reference]').fill('TEST-REJECTION');await page.locator('input[name=amount]').fill('1');
  await page.getByRole('button',{name:'Sign & create request'}).click();await expect(page.getByRole('alert')).toContainText('rejected');expect(await saved(page)).toHaveLength(0);await expect(page.locator('.request-title')).toHaveCount(0);
  state.signError=0;
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota failure','QuotaExceededError');};});
  await page.getByRole('button',{name:'Sign & create request'}).click();await expect(page.getByRole('alert')).toContainText('STORAGE_WRITE');
  await expect(page.getByRole('button',{name:'Download request JSON'})).toBeEnabled();expect(await saved(page)).toHaveLength(0);await expect(page.getByRole('status')).toHaveCount(0);
});

test('synthetic: corrupted local records remain intact and unavailable',async({page,context})=>{
  const state=await harness(context);await page.goto('/requests');
  await page.evaluate(k=>localStorage.setItem(k,'broken JSON'),key(state.request));await page.reload();
  await expect(page.getByRole('alert')).toContainText('STORAGE_READ');await expect(page.getByText('Records could not be loaded',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Check all'})).toBeDisabled();expect(await page.evaluate(k=>localStorage.getItem(k),key(state.request))).toBe('broken JSON');
});

test('synthetic: scan persistence failure retains verified evidence and exposes the failed request',async({page,context})=>{
  const state=await harness(context);state.mined=true;
  await importRequests(page,[state.request]);await navigateTo(page,'Payment requests');
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota failure','QuotaExceededError');};});
  await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('STORAGE_WRITE');await expect(page.getByRole('alert')).toContainText(state.request.requestId);
  await expect(page.getByRole('status')).toContainText('1 incomplete or failed');
  await expect(page.locator('.metric').nth(1)).toContainText('0.01');
  expect((await saved(page)).find(r=>r.request)?.hashes).toEqual([]);
});

test('synthetic: mobile routes have usable controls without horizontal page overflow',async({page,context})=>{
  const state=await harness(context);await page.setViewportSize({width:390,height:844});await importRequests(page,[state.request]);
  for(const path of ['/','/requests','/requests/new','/activity','/backups','/receipt']){
    await page.goto(path);await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await loadPay(page,state.request);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect(page.getByRole('status')).toContainText('Checked through block');
});
