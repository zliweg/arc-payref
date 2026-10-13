import { openTestnetWorkspace, reloadTestnetWorkspace } from './harness';
// Isolated synthetic browser scenarios. These never use a real wallet or broadcast to Arc.
import { test, expect } from '@playwright/test';
import { requestLink, verifyRequest } from '../../src/protocol';
import { MAINNET, TESTNET } from '../../src/config';
import { toHex } from 'viem';
import { payer, signed, unsigned, txHash, otherHash } from '../fixtures';
import { connectWallet, emitWalletEvent, harness, loadPay, navigateTo, origin, preparePayment, saved } from './harness';

test('synthetic: exact payment review is explicit and higher fees require a new review',async({page,context},testInfo)=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);
  await expect(page.getByRole('button',{name:'Confirm & pay',exact:false})).toHaveCount(0);
  await preparePayment(page);
  const review=page.getByRole('region',{name:'Payment confirmation'});
  await expect(review).toContainText(state.request.message.payee);
  await expect(review).toContainText(payer);
  await expect(review.locator('dd').nth(3)).toHaveText('0.01 USDC');
  await expect(review.locator('dd').nth(4)).toHaveText('0.001584 USDC');
  await expect(review.locator('dd').nth(5)).toHaveText('0.011584 USDC');
  await expect(review.locator('dd').nth(6)).toHaveText('20 USDC');
  expect(state.sent).toHaveLength(0);
  await page.screenshot({path:testInfo.outputPath('payment-review-desktop.png'),fullPage:true});
  state.baseFee=40_000_000_000n;
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('REVIEW_FEES_CHANGED');
  expect(state.sent).toHaveLength(0);
  await expect(review).toHaveCount(0);
  await preparePayment(page);
  await expect(review.locator('dd').nth(5)).toHaveText('0.013168 USDC');
  expect(state.unexpected).toEqual([]);
});

test('synthetic: review expires and wallet changes cannot reuse an earlier approval',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await page.clock.install();
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  await page.clock.fastForward(121_000);
  await expect(page.getByRole('region',{name:'Payment confirmation'})).toContainText('estimate has expired');
  await expect(page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Refresh payment checks',exact:true}).click();
  await expect(page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true})).toBeEnabled();
  state.account=state.request.message.payee;
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('WALLET_CHANGED');
  expect(state.sent).toHaveLength(0);
});

test('synthetic: stopped checks preserve pending, navigation and reload resume without resending',async({page,context},testInfo)=>{
  const state=await harness(context);state.account=payer;
  await page.setViewportSize({width:390,height:844});
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('payment-review-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect.poll(()=>state.receiptReads).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Stop automatic checks'}).click();
  await expect(page.getByRole('region',{name:'Payment progress'})).toContainText('Automatic checking stopped');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await saved(page)).find(r=>r.status).status).toBe('SUBMITTED');
  const reads=state.receiptReads;
  await navigateTo(page,'Payment requests');
  await page.getByRole('button',{name:'Open TEST-001',exact:true}).click();
  await page.getByRole('link',{name:'Open payment page',exact:false}).click();
  await expect.poll(()=>state.receiptReads).toBeGreaterThan(reads);
  await reloadTestnetWorkspace(page);
  await expect(page.getByRole('region',{name:'Payment progress'})).toContainText('Checking');
  state.mined=true;
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified');
  await expect(page.getByRole('region',{name:'Payment evidence'}).locator('.evidence-step.verified')).toHaveCount(4);
  await expect(page.locator('.evidence-coverage')).toContainText('Not run');
  await expect.poll(async()=>(await saved(page)).find(r=>r.status).status).toBe('CONFIRMED');
  expect(state.sent).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('payment-evidence-mobile.png'),fullPage:true});
});

test('synthetic: failed evidence names its layer and retains a previously verified payment',async({page,context},testInfo)=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  state.mined=true;state.receiptMismatch=true;
  await expect(page.getByRole('alert')).toContainText('EVIDENCE_MISMATCH');
  await expect(page.locator('.evidence-failure')).toContainText('Memo binding');
  await expect(page.locator('.verified-receipt')).toHaveCount(0);
  expect((await saved(page)).find(r=>r.status).status).toBe('SUBMITTED');
  state.receiptMismatch=false;
  await page.getByRole('button',{name:'Check again',exact:true}).click();
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified');
  state.receiptMismatch=true;
  await page.getByLabel('Transaction hash',{exact:true}).fill(otherHash);
  await page.getByRole('button',{name:'Verify receipt',exact:true}).click();
  await expect(page.locator('.evidence-failure')).toContainText('Previously verified payment evidence remains visible');
  await expect(page.locator('.verified-receipt')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('evidence-desktop.png'),fullPage:true});
  expect(state.sent).toHaveLength(1);
});

test('synthetic: late empty scan cannot erase a payment verified concurrently',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect.poll(()=>state.receiptReads).toBeGreaterThan(0);
  state.logDelay=4500;
  const before=state.logReads;
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect.poll(()=>state.logReads).toBeGreaterThan(before);
  state.mined=true;
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified');
  await expect(page.getByRole('status')).toContainText('Checked through block');
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified');
  await expect(page.locator('.request-status')).toContainText('Payment verified');
  expect(state.sent).toHaveLength(1);
});

test('synthetic: a delayed wallet response after hash navigation preserves the original hash without changing the new request',async({page,context})=>{
  const state=await harness(context);state.account=payer;state.sendDelay=1500;
  const original=state.request;
  const next=await signed({...unsigned(),message:{...unsigned().message,reference:'NEXT-REQUEST',amount:'20000'}});
  await loadPay(page,original);await connectWallet(page);await preparePayment(page);
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect.poll(()=>state.sent.length).toBe(1);
  await page.evaluate(url=>{location.hash=new URL(url).hash;},requestLink(next,origin));
  await expect(page.locator('.request-title')).toHaveText('NEXT-REQUEST');
  await expect.poll(async()=>(await saved(page)).find(r=>r.status)?.status).toBe('SUBMITTED');
  await expect(page.getByLabel('Transaction hash',{exact:true})).toHaveValue('');
  await expect(page.getByRole('region',{name:'Payment progress'})).toHaveCount(0);
  expect((await saved(page)).find(r=>r.status).hash).toBe(txHash);
  expect((await saved(page)).find(r=>r.status).requestId).toBe(original.requestId);
  expect(state.receiptReads).toBe(0);
  expect(state.sent).toHaveLength(1);
});

test('synthetic: leaving during final preflight prevents the old request from opening a payment',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  const next=await signed({...unsigned(),message:{...unsigned().message,reference:'NEXT-BEFORE-SEND',amount:'20000'}});
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  state.logDelay=1500;const before=state.logReads;
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect.poll(()=>state.logReads).toBeGreaterThan(before);
  await page.evaluate(url=>{location.hash=new URL(url).hash;},requestLink(next,origin));
  await expect(page.locator('.request-title')).toHaveText('NEXT-BEFORE-SEND');
  // The new page becomes usable after the previous operation exits its read-only phase.
  await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeEnabled();
  expect(state.sent).toHaveLength(0);
  expect((await saved(page)).filter(r=>r.status)).toHaveLength(0);
  await expect(page.getByLabel('Transaction hash',{exact:true})).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('synthetic: manual recovery success ends the original pending watcher',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  await page.getByRole('button',{name:'Confirm & pay 0.01 USDC',exact:true}).click();
  await expect.poll(()=>state.receiptReads).toBeGreaterThan(0);
  state.mined=true;
  await page.getByLabel('Recovery transaction hash').fill(txHash);
  await page.getByRole('button',{name:'Check transaction',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('matching payment is verified');
  await expect(page.getByRole('region',{name:'Payment progress'})).toHaveCount(0);
  expect((await saved(page)).find(r=>r.status).status).toBe('CONFIRMED');
  expect(state.sent).toHaveLength(1);
});

test('synthetic: reconnect preserves site permission and explicit account selection connects the unshared account',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await openTestnetWorkspace(page,'/requests/new');await connectWallet(page);
  await page.locator('input[name=reference]').fill('SWITCH-ACCOUNT-DRAFT');
  await page.locator('input[name=amount]').fill('0.01');
  await page.locator('textarea[name=description]').fill('Unsigned account-switch regression only.');
  // This is the wallet-internal selection. It has not been shared with this site.
  state.permissionAccount=state.request.message.payee;
  await page.locator('.wallet-menu > summary').click();
  await page.getByRole('button',{name:'Reconnect wallet',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Wallet connected');
  await expect(page.getByRole('region',{name:'Wallet connection'}).locator('.address')).toHaveText(payer);
  expect(state.permissionRequests).toHaveLength(0);
  await page.getByRole('button',{name:'Switch account',exact:true}).click();
  await expect(page.getByRole('region',{name:'Wallet connection'}).locator('.address')).toHaveText(state.request.message.payee);
  expect(state.permissionRequests).toEqual([[{eth_accounts:{}}]]);
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText(`${state.request.message.payee.slice(0,6)}…${state.request.message.payee.slice(-4)}`);
  await expect(page.locator('input[name=reference]')).toHaveValue('SWITCH-ACCOUNT-DRAFT');
  await expect(page.locator('input[name=amount]')).toHaveValue('0.01');
  await expect(page.locator('textarea[name=description]')).toHaveValue('Unsigned account-switch regression only.');
  expect(await saved(page)).toEqual([]);
  expect(state.signRequests).toBe(0);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: a non-first authorized account can be explicitly selected to sign the preserved request draft',async({page,context})=>{
  const state=await harness(context);const receivingAccount=state.request.message.payee;
  state.account=payer;state.accounts=[payer,receivingAccount];
  await openTestnetWorkspace(page,'/requests/new');await connectWallet(page);
  await expect(page.locator('.wallet-menu small.address')).toHaveText(payer);
  await page.locator('input[name=reference]').fill('MULTI-ACCOUNT-DRAFT');
  await page.locator('input[name=amount]').fill('0.01');
  await page.locator('textarea[name=description]').fill('Synthetic authorized-account selection.');
  await page.locator('.wallet-menu > summary').click();
  await page.getByLabel('Connected account',{exact:true}).selectOption(receivingAccount);
  await expect(page.getByRole('region',{name:'Wallet connection'}).locator('.address')).toHaveText(receivingAccount);
  await expect(page.getByLabel('Connected account',{exact:true})).toHaveValue(receivingAccount);
  await page.locator('.wallet-menu > summary').click();
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText(`${receivingAccount.slice(0,6)}…${receivingAccount.slice(-4)}`);
  await expect(page.locator('input[name=reference]')).toHaveValue('MULTI-ACCOUNT-DRAFT');
  await expect(page.locator('input[name=amount]')).toHaveValue('0.01');
  await expect(page.locator('textarea[name=description]')).toHaveValue('Synthetic authorized-account selection.');
  await page.getByRole('button',{name:'Sign & create request'}).click();
  await expect(page.getByRole('status')).toContainText('Signed request saved');
  const records=await saved(page);
  expect(records).toHaveLength(1);
  const verified=await verifyRequest(records[0].request);
  expect(verified.message).toMatchObject({payee:receivingAccount,reference:'MULTI-ACCOUNT-DRAFT',amount:'10000',description:'Synthetic authorized-account selection.'});
  expect(state.signedBy.map(account=>account.toLowerCase())).toEqual([receivingAccount.toLowerCase()]);
  expect(state.accounts).toEqual([payer,receivingAccount]);
  expect(state.permissionRequests).toHaveLength(0);
  expect(state.signRequests).toBe(1);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: wallet account events update the unsigned preview and disconnection preserves the draft',async({page,context})=>{
  const state=await harness(context);
  await openTestnetWorkspace(page,'/requests/new');await connectWallet(page);
  await page.locator('input[name=reference]').fill('EVENT-ACCOUNT-DRAFT');
  await page.locator('input[name=amount]').fill('12.345678');
  state.account=payer;
  await emitWalletEvent(page,'accountsChanged',[payer]);
  await expect(page.locator('.wallet-menu small.address')).toHaveText(payer);
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText('0x2222…2222');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeEnabled();
  state.accounts=[];
  await emitWalletEvent(page,'accountsChanged',[]);
  await expect(page.locator('.wallet-menu > summary')).toContainText('Connect wallet');
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText('Your connected wallet');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  await expect(page.locator('input[name=reference]')).toHaveValue('EVENT-ACCOUNT-DRAFT');
  await expect(page.locator('input[name=amount]')).toHaveValue('12.345678');
  expect(await saved(page)).toEqual([]);
  expect(state.signRequests).toBe(0);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: account selection reconciles its final account after an earlier permission event read fails',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await openTestnetWorkspace(page,'/requests/new');await connectWallet(page);
  await page.locator('input[name=reference]').fill('PERMISSION-EVENT-DRAFT');
  await page.locator('input[name=amount]').fill('0.01');
  state.permissionAccount=state.request.message.payee;
  state.permissionEmitAccountChange=true;state.chainReadErrors=1;
  await page.locator('.wallet-menu > summary').click();
  await page.getByRole('button',{name:'Switch account',exact:true}).click();
  await expect(page.getByRole('region',{name:'Wallet connection'}).locator('.address')).toHaveText(state.request.message.payee);
  await expect(page.getByRole('status')).toContainText('Wallet account selected');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeEnabled();
  await expect(page.locator('input[name=reference]')).toHaveValue('PERMISSION-EVENT-DRAFT');
  expect(state.chainReadErrors).toBe(0);
  expect(state.permissionRequests).toEqual([[{eth_accounts:{}}]]);
  expect(state.signRequests).toBe(0);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: failed account event synchronization blocks signing and reconnect restores verified account context',async({page,context})=>{
  const state=await harness(context);
  await openTestnetWorkspace(page,'/requests/new');await connectWallet(page);
  await page.locator('input[name=reference]').fill('ACCOUNT-SYNC-FAILURE');
  await page.locator('input[name=amount]').fill('0.01');
  state.account=payer;state.chainReadErrors=1;
  await emitWalletEvent(page,'accountsChanged',[payer]);
  await expect(page.getByRole('alert')).toContainText('ACCOUNT_SYNC_FAILED');
  await expect(page.locator('.wallet-menu > summary')).toContainText('Connect wallet');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeDisabled();
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText('Your connected wallet');
  await expect(page.getByRole('status')).toHaveCount(0);
  await connectWallet(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.invoice-preview dl dd').first()).toHaveText('0x2222…2222');
  await expect(page.getByRole('button',{name:'Sign & create request'})).toBeEnabled();
  await expect(page.locator('input[name=reference]')).toHaveValue('ACCOUNT-SYNC-FAILURE');
  expect(state.signRequests).toBe(0);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});

test('synthetic: account and network events discard payment approval without following the wallet onto mainnet',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
  const nextPayer='0x3333333333333333333333333333333333333333';
  state.account=nextPayer;
  await emitWalletEvent(page,'accountsChanged',[nextPayer]);
  await expect(page.locator('.wallet-menu small.address')).toHaveText(nextPayer);
  await expect(page.getByRole('region',{name:'Payment confirmation'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Confirm & pay',exact:false})).toHaveCount(0);
  await preparePayment(page);
  await expect(page.getByRole('region',{name:'Payment confirmation'})).toContainText(nextPayer);
  state.chain=MAINNET;
  await emitWalletEvent(page,'chainChanged',toHex(MAINNET));
  await expect(page.getByRole('region',{name:'Payment confirmation'})).toHaveCount(0);
  await expect(page.locator('.wallet-menu > summary')).toContainText('Connect wallet');
  await expect(page.locator('.network-chip')).toHaveText('Arc Testnet');
  await expect(page.getByLabel('Network',{exact:true})).toHaveValue(String(TESTNET));
  await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeDisabled();
  expect(state.sent).toHaveLength(0);
  expect((await saved(page)).filter(record=>record.status)).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test('synthetic: a delayed payment check cannot restore approval after the wallet changes',async({page,context})=>{
  const state=await harness(context);state.account=payer;
  await loadPay(page,state.request);await connectWallet(page);
  let releaseLogs!:()=>void;
  state.logGate=new Promise<void>(resolve=>{releaseLogs=resolve;});
  const before=state.logReads;
  try{
    await page.getByRole('button',{name:'Check payment & fees',exact:true}).click();
    await expect.poll(()=>state.logReads).toBeGreaterThan(before);
    const nextPayer='0x3333333333333333333333333333333333333333';
    state.account=nextPayer;
    await emitWalletEvent(page,'accountsChanged',[nextPayer]);
    await expect(page.locator('.wallet-menu small.address')).toHaveText(nextPayer);
    state.logGate=undefined;releaseLogs();
    await expect(page.getByRole('button',{name:'Check payment & fees',exact:true})).toBeEnabled();
    await expect(page.getByRole('region',{name:'Payment confirmation'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Confirm & pay',exact:false})).toHaveCount(0);
    expect(state.sent).toHaveLength(0);
    expect((await saved(page)).filter(record=>record.status)).toHaveLength(0);
    await preparePayment(page);
    await expect(page.getByRole('region',{name:'Payment confirmation'})).toContainText(nextPayer);
    expect(state.unexpected).toEqual([]);
  }finally{state.logGate=undefined;releaseLogs();}
});

for(const failure of [{code:4001,error:'Wallet request rejected'},{code:4200,error:'ACCOUNT_SELECTION_UNSUPPORTED'}]){
  test(`synthetic: account selection ${failure.code} is explicit and retains the actual connected account`,async({page,context})=>{
    const state=await harness(context);state.account=payer;
    await loadPay(page,state.request);await connectWallet(page);await preparePayment(page);
    state.permissionAccount=state.request.message.payee;state.permissionError=failure.code;
    await page.locator('.wallet-menu > summary').click();
    await page.getByRole('button',{name:'Switch account',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(failure.error);
    await expect(page.getByRole('region',{name:'Wallet connection'}).locator('.address')).toHaveText(payer);
    await expect(page.getByRole('status')).toHaveCount(0);
    expect(state.permissionRequests).toEqual([[{eth_accounts:{}}]]);
    expect(state.account).toBe(payer);
    expect(state.signRequests).toBe(0);expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
  });
}
