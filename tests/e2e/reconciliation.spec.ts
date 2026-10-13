import { openTestnetWorkspace, reloadTestnetWorkspace } from './harness';
// Synthetic browser acceptance only: public fixture wallet, Arc-shaped RPC, no real chain writes.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { MAINNET, TESTNET } from '../../src/config';
import { requestLink, verifyRequest } from '../../src/protocol';
import type { Receivable } from '../../src/receivables';
import { signed, txHash, unsigned } from '../fixtures';
import { connectWallet, harness, importRequests, origin, saved } from './harness';

async function businessRecords(page: Page): Promise<Receivable[]> {
  return page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('arc-payref:receivables:v1:')).map(([, value]) => JSON.parse(value)));
}
async function uploadBusiness(page: Page, contents: string, name = 'synthetic-business.json', valid = 1, rejected = 0) {
  await page.getByLabel('Import business records', { exact: true }).setInputFiles({ name, mimeType: name.endsWith('.csv') ? 'text/csv' : 'application/json', buffer: Buffer.from(contents) });
  await expect(page.getByRole('region', { name: 'Business import preview' }).getByRole('heading')).toHaveText(`${valid} valid · ${rejected} rejected`);
}
async function commitBusiness(page: Page, count = 1) {
  await page.getByRole('button', { name: 'Import validated business records', exact: true }).click();
  await expect(page.locator('.reconciliation-workspace').getByRole('status')).toContainText(`Saved ${count} business records`);
}
async function importBusiness(page: Page, rows: unknown[]) {
  await openTestnetWorkspace(page,'/receivables');
  await uploadBusiness(page, JSON.stringify(rows), 'synthetic-business.json', rows.length);
  await commitBusiness(page, rows.length);
}
async function diagnose(page: Page, hash = txHash) {
  await page.getByLabel('Business transaction hash', { exact: true }).fill(hash);
  await page.getByRole('button', { name: 'Diagnose transaction', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Read-only payment diagnosis' })).toBeVisible();
}
async function downloadText(page: Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile(await (await pending).path(), 'utf8');
}
async function requestFor(amount = '80000000', reference = 'SYNTHETIC-BUSINESS-80') {
  const input = unsigned();
  return signed({ ...input, message: { ...input.message, amount, reference } });
}

test('synthetic: mixed CSV preview rejects invalid rows without rounding and persists only validated declarations', async ({ page, context }) => {
  const state = await harness(context);
  await openTestnetWorkspace(page,'/receivables');
  const csv = 'reference,amount,customer,note,chain_id\r\n' +
    'PRECISE-001,12.345678,"Customer, one","Line one\nLine two",\r\n' +
    'OVER-PRECISION,1.0000001,Rejected,,\r\n' +
    'NEGATIVE,-1,Rejected,,\r\n' +
    'WRONG-NETWORK,2,Rejected,,1\r\n' +
    '=SUM(1+1),0.000001,@untrusted,<script>window.injected=1</script>,\r\n';
  await uploadBusiness(page, csv, 'synthetic-mixed.csv', 2, 3);
  expect(await businessRecords(page)).toEqual([]);
  // Source positions are physical CSV lines, including the quoted note's newline.
  await expect(page.locator('.import-errors')).toContainText('Row 4');
  await expect(page.locator('.import-errors')).toContainText('Row 5');
  await expect(page.locator('.import-errors')).toContainText('Row 6');
  await commitBusiness(page, 2);
  const records = await businessRecords(page);
  expect(records.map(row => row.amount).sort()).toEqual(['1', '12345678']);
  expect(records.every(row => row.chainId === TESTNET && !row.requestId && row.hashes.length === 0 && row.review.state === 'open')).toBe(true);
  expect(records.find(row => row.reference === 'PRECISE-001')?.note).toBe('Line one\nLine two');
  await page.getByRole('button', { name: 'Review =SUM(1+1)', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Business record details' })).toContainText('<script>window.injected=1</script>');
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await expect(page.locator('.business-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.business-table')).not.toContainText('Payment verified');
  await reloadTestnetWorkspace(page);
  expect(await businessRecords(page)).toEqual(records);
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: equal references and amounts are suggestions only, and one request cannot be double-linked', async ({ page, context }) => {
  const state = await harness(context);
  await importRequests(page, [state.request]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '0.01' }, { reference: state.request.message.reference, amount: '0.01' }]);
  await expect(page.locator('.business-table tbody tr')).toHaveCount(2);
  expect((await businessRecords(page)).every(row => row.requestId === undefined)).toBe(true);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).nth(0).click();
  await expect(page.getByRole('region', { name: 'Business record details' })).toContainText('1 similar saved request(s)');
  await expect(page.getByLabel('Link signed request')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Diagnose transaction', exact: true })).toBeDisabled();
  await page.getByLabel('Link signed request').selectOption(state.request.requestId);
  await page.getByRole('button', { name: 'Link selected request', exact: true }).click();
  await expect(page.locator('.business-table tbody tr').nth(0)).toContainText('Business matches request');
  expect((await businessRecords(page)).filter(row => row.requestId === state.request.requestId)).toHaveLength(1);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).nth(1).click();
  await page.getByLabel('Link signed request').selectOption(state.request.requestId);
  await page.getByRole('button', { name: 'Link selected request', exact: true }).click();
  await expect(page.locator('.reconciliation-workspace').getByRole('alert')).toContainText('RECEIVABLE_LINK_CONFLICT');
  expect((await businessRecords(page)).filter(row => row.requestId === state.request.requestId)).toHaveLength(1);
  await expect(page.locator('.business-table tbody tr').nth(1)).toContainText('Not linked');
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: business 100, signed 80 and verified 80 stay independent through full lookup', async ({ page, context }, testInfo) => {
  const state = await harness(context); state.request = await requestFor(); state.mined = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await importRequests(page, [state.request]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '100', customer: 'Synthetic customer', note: 'Business declaration: balance requires review.', request_id: state.request.requestId }]);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  const detail = page.getByRole('region', { name: 'Business record details' });
  await expect(detail.locator('.three-way article').nth(0)).toContainText('100.00');
  await expect(detail.locator('.three-way article').nth(1)).toContainText('80.00');
  await expect(detail.locator('.three-way article').nth(2)).toContainText('Not verified');
  await diagnose(page);
  await expect(page.getByRole('region', { name: 'Read-only payment diagnosis' }).getByRole('heading')).toHaveText('Payment verified');
  await expect(detail.locator('.three-way article').nth(2)).toContainText('80.00');
  await expect(page.locator('.business-table')).toContainText('Business differs');
  await expect(page.locator('.business-table')).toContainText('Payment verified');
  await expect(page.locator('.business-table')).toContainText('Duplicate check incomplete');
  await page.getByRole('button', { name: 'Check full payment range', exact: true }).click();
  await expect(page.locator('.business-table')).toContainText('Checked to 101');
  await expect(page.locator('.business-table')).toContainText('Business differs');
  await page.screenshot({ path: testInfo.outputPath('business-three-way-desktop.png'), fullPage: true });
  await page.locator('.work-tabs').getByRole('link', { name: 'Exception review', exact: true }).click();
  await expect(page.locator('.business-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.business-table')).toContainText('Payment verified');
  expect((await businessRecords(page))[0].amount).toBe('100000000');
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

for (const scenario of [{ name: 'wrong amount', actualAmount: '79000000', direct: false, title: 'Amount does not match' }, { name: 'direct USDC transfer without Memo', actualAmount: undefined, direct: true, title: 'Request binding is missing' }]) {
  test(`synthetic: ${scenario.name} remains a diagnostic exception, never a matching payment`, async ({ page, context }) => {
    const state = await harness(context); state.request = await requestFor(); state.mined = true; state.actualAmount = scenario.actualAmount; state.directTransfer = scenario.direct;
    await importRequests(page, [state.request]);
    await importBusiness(page, [{ reference: state.request.message.reference, amount: '80', request_id: state.request.requestId }]);
    await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
    await diagnose(page);
    const result = page.getByRole('region', { name: 'Read-only payment diagnosis' });
    await expect(result.getByRole('heading')).toHaveText(scenario.title);
    await expect(result).toContainText('does not confirm payment');
    await expect(page.locator('.business-table')).toContainText('Not verified');
    await expect(page.locator('.business-table')).not.toContainText('Payment verified');
    expect((await businessRecords(page))[0].hashes).toEqual([txHash]);
    expect((await saved(page)).find(item => item.request)?.hashes).toEqual([]);
    await page.getByRole('button', { name: 'Check full payment range', exact: true }).click();
    await expect(page.locator('.business-table')).toContainText('Checked to 101');
    await expect(page.locator('.business-table')).toContainText('Not verified');
    if (!scenario.direct) await expect(page.getByRole('region', { name: 'Business record details' })).toContainText('Unmatched Memo record');
    expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
  });
}

test('synthetic: review notes survive refresh without changing a business discrepancy or claiming payment', async ({ page, context }) => {
  const state = await harness(context); state.request = await requestFor();
  await importRequests(page, [state.request]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '100', request_id: state.request.requestId }]);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  const initial = (await businessRecords(page))[0];
  await page.getByLabel('Business review note').fill('Synthetic review: payer contacted; discrepancy still unresolved.');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.locator('.reconciliation-workspace').getByRole('status')).toContainText('Payment evidence and business differences were not changed');
  const reviewed = (await businessRecords(page))[0];
  expect(reviewed).toEqual({ ...initial, review: { state: 'reviewed', note: 'Synthetic review: payer contacted; discrepancy still unresolved.', updatedAt: reviewed.review.updatedAt } });
  await expect(page.locator('.business-table')).toContainText('Business differs');
  await expect(page.locator('.business-table')).toContainText('Not verified');
  await reloadTestnetWorkspace(page);
  expect(await businessRecords(page)).toEqual([reviewed]);
  await page.locator('.work-tabs').getByRole('link', { name: 'Exception review', exact: true }).click();
  await page.getByLabel('Review state', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.business-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  await expect(page.getByLabel('Business review note')).toHaveValue(reviewed.review.note);
  await expect(page.locator('.business-table')).toContainText('Not verified');
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: concurrent review drafts preserve the first saved note and explicitly reject a stale overwrite', async ({ page, context }) => {
  const state = await harness(context);
  const reference = 'SYNTHETIC-CONCURRENT-NOTES';
  await importBusiness(page, [{ reference, amount: '100', customer: 'Synthetic review customer' }]);
  await page.getByRole('button', { name: `Review ${reference}`, exact: true }).click();
  const original = (await businessRecords(page))[0];
  const other = await context.newPage();
  try {
    await openTestnetWorkspace(other,origin + '/receivables');
    await other.getByRole('button', { name: `Review ${reference}`, exact: true }).click();
    // A pristine editor follows a newer saved note in the other window.
    await other.getByLabel('Business review note').fill('Shared starting note from window B.');
    await other.getByRole('button', { name: 'Save note · keep open', exact: true }).click();
    await expect(other.locator('.reconciliation-workspace').getByRole('status')).toContainText('Review note saved');
    await expect(page.getByLabel('Business review note')).toHaveValue('Shared starting note from window B.');

    // Both users now edit that same version. B saves first; A's local draft is
    // kept visible, but it cannot overwrite B's newer persisted note or state.
    await page.getByLabel('Business review note').fill('Unsaved draft A: awaiting another reply.');
    await other.getByLabel('Business review note').fill('Saved note B: payer contacted and follow-up recorded.');
    await other.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(other.locator('.business-table')).toContainText('Reviewed · open');
    await expect(page.getByRole('region', { name: 'Business record details' })).toContainText('Reviewed by you');
    await expect(page.getByLabel('Business review note')).toHaveValue('Unsaved draft A: awaiting another reply.');
    const savedByB = (await businessRecords(other))[0];
    expect(savedByB).toEqual({ ...original, review: { state: 'reviewed', note: 'Saved note B: payer contacted and follow-up recorded.', updatedAt: savedByB.review.updatedAt } });
    await page.getByRole('button', { name: 'Save note · keep open', exact: true }).click();
    await expect(page.locator('.reconciliation-workspace').getByRole('alert')).toContainText('RECEIVABLE_REVIEW_CONFLICT');
    await expect(page.locator('.reconciliation-workspace').getByRole('alert')).toContainText('saved note was retained');
    expect(await businessRecords(page)).toEqual([savedByB]);
    expect(await businessRecords(other)).toEqual([savedByB]);
    await expect(page.getByLabel('Business review note')).toHaveValue('Unsaved draft A: awaiting another reply.');
    await page.getByRole('button', { name: 'Close business details', exact: true }).click();
    await page.getByRole('button', { name: `Review ${reference}`, exact: true }).click();
    await expect(page.getByLabel('Business review note')).toHaveValue(savedByB.review.note);
    await expect(page.locator('.business-table')).toContainText('Not verified');
    expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
  } finally { await other.close(); }
});

test('synthetic: safe comparison CSV and business JSON downloads have explicit restore boundaries and retain conflicting originals', async ({ page, context, browser }) => {
  const state = await harness(context);
  await importBusiness(page, [{ reference: '=SUM(1+1)', amount: '12.345678', customer: '@synthetic', note: 'First line\n"Second", line' }]);
  const original = await businessRecords(page);
  const csv = await downloadText(page, 'Export comparison CSV');
  expect(csv).toContain('"\'=SUM(1+1)"'); expect(csv).toContain('"\'@synthetic"');
  expect(csv).toContain('"12.345678"'); expect(csv).toContain('"not-verified"');
  expect(csv).toContain('First line\n""Second"", line');
  const json = await downloadText(page, 'Export business JSON');
  expect(JSON.parse(json).records).toEqual(original);
  const clean = await browser.newContext();
  try {
    const cleanState = await harness(clean); const restored = await clean.newPage();
    await openTestnetWorkspace(restored,origin + '/receivables');
    // The comparison CSV deliberately cannot restore signatures or trust status columns.
    await restored.getByLabel('Import business records', { exact: true }).setInputFiles({ name: 'comparison.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(restored.locator('.reconciliation-workspace').getByRole('alert')).toContainText('CSV');
    expect(await businessRecords(restored)).toEqual([]);
    await uploadBusiness(restored, json, 'restore.json'); await commitBusiness(restored);
    expect(await businessRecords(restored)).toEqual(original);
    expect(await saved(restored)).toEqual([]);
    const tampered = JSON.parse(json); tampered.records[0].amount = '999000000';
    await uploadBusiness(restored, JSON.stringify(tampered), 'conflict.json');
    await restored.getByRole('button', { name: 'Import validated business records', exact: true }).click();
    await expect(restored.locator('.reconciliation-workspace').getByRole('alert')).toContainText('PARTIAL_BUSINESS_IMPORT');
    await expect(restored.locator('.reconciliation-workspace').getByRole('alert')).toContainText('Saved 0 of 1');
    await expect(restored.locator('.reconciliation-workspace').getByRole('alert')).toContainText('RECEIVABLE_CONFLICT');
    expect(await businessRecords(restored)).toEqual(original);
    expect(cleanState.sent).toHaveLength(0); expect(cleanState.unexpected).toEqual([]);
  } finally { await clean.close(); }
  expect(await businessRecords(page)).toEqual(original);
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: a cross-network business declaration keeps its original request in the handoff and never queries mainnet', async ({ page, context }) => {
  const state = await harness(context); state.request = await requestFor(); state.mined = true;
  const prohibitedMainnetReads: string[] = [];
  await context.route('https://rpc.mainnet.arc.io/**', route => { prohibitedMainnetReads.push(route.request().url()); return route.abort(); });
  await importRequests(page, [state.request]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '80', chain_id: MAINNET, request_id: state.request.requestId, tx_hash: txHash }]);
  await page.locator('.wallet-menu > summary').click();
  await page.getByLabel('Network', { exact: true }).selectOption(String(MAINNET));
  await page.locator('.wallet-menu > summary').click();
  await expect(page.locator('.business-table')).toContainText('Business differs');
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Business record details' }).locator('.difference-box')).toContainText('network');
  await page.locator('.work-tabs').getByRole('link', { name: 'Handoff & recheck', exact: false }).click();
  const packet = JSON.parse(await downloadText(page, 'Download workspace handoff (1)'));
  expect(packet.records[0].receivable.chainId).toBe(MAINNET);
  expect(packet.records[0].request).toEqual(state.request);
  expect(packet.records[0].hashes).toEqual([txHash]);
  const panel = page.getByRole('region', { name: 'Independent handoff verification' });
  await expect(panel.locator('.handoff-record')).toContainText('Business/request mismatch: Network');
  await panel.getByRole('button', { name: 'Verify known transactions', exact: true }).click();
  await expect(panel).toContainText('Known-transaction checks finished');
  const testnetTotals = page.getByRole('region', { name: 'Arc Testnet handoff totals' });
  const mainnetTotals = page.getByRole('region', { name: 'Arc Mainnet handoff totals' });
  await expect(testnetTotals.locator('dd').nth(2)).toHaveText('80.00 USDC');
  await expect(mainnetTotals.locator('dd').nth(0)).toHaveText('80.00 USDC');
  await expect(mainnetTotals.locator('dd').nth(2)).toHaveText('0.00 USDC');
  expect(prohibitedMainnetReads).toEqual([]);
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: another tab relinking a business record during diagnosis cannot attach old evidence to the new request', async ({ page, context }) => {
  const state = await harness(context); state.request = await requestFor(); state.mined = true;
  const nextRequest = await requestFor('90000000', 'SYNTHETIC-RELINKED-90');
  await importRequests(page, [state.request, nextRequest]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '80', request_id: state.request.requestId }]);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  let releaseRead!: () => void, readBlocked = false;
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  await page.route('https://rpc.testnet.arc.io/**', async route => {
    const payload = route.request().postDataJSON();
    const calls = Array.isArray(payload) ? payload : [payload];
    if (calls.some(call => call.method === 'eth_getTransactionByHash' || call.method === 'eth_getTransactionReceipt')) { readBlocked = true; await gate; }
    await route.fallback();
  });
  const other = await context.newPage();
  try {
    await page.getByLabel('Business transaction hash', { exact: true }).fill(txHash);
    await page.getByRole('button', { name: 'Diagnose transaction', exact: true }).click();
    await expect.poll(() => readBlocked).toBe(true);
    await openTestnetWorkspace(other,origin + '/receivables');
    await other.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
    await other.getByLabel('Link signed request').selectOption(nextRequest.requestId);
    await other.getByRole('button', { name: 'Link selected request', exact: true }).click();
    await expect(other.locator('.reconciliation-workspace').getByRole('status')).toContainText('Request explicitly linked');
    await expect(page.getByLabel('Link signed request')).toHaveValue(nextRequest.requestId);
    releaseRead();
    await expect(page.locator('.reconciliation-workspace').getByRole('status')).toContainText('business association changed');
    const detail = page.getByRole('region', { name: 'Business record details' });
    await expect(detail.locator('.three-way article').nth(1)).toContainText('90.00');
    await expect(detail.locator('.three-way article').nth(1)).toContainText(nextRequest.message.reference);
    await expect(detail.locator('.three-way article').nth(2)).toContainText('Not verified');
    await expect(page.getByRole('region', { name: 'Read-only payment diagnosis' })).toHaveCount(0);
    await expect(page.locator('.business-table')).not.toContainText('Payment verified');
    const business = (await businessRecords(page))[0];
    expect(business.requestId).toBe(nextRequest.requestId); expect(business.hashes).toEqual([txHash]);
    expect((await saved(page)).find(item => item.request?.requestId === nextRequest.requestId)?.hashes).toEqual([]);
    expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
  } finally { releaseRead(); await other.close(); }
});

test('synthetic: a manual business draft creates and links a fresh signature without disclosing private labels or notes', async ({ page, context }) => {
  const state = await harness(context);
  await openTestnetWorkspace(page,'/receivables');
  await page.locator('.manual-receivable > summary').click();
  const form = page.locator('.manual-receivable form');
  await form.locator('input[name=reference]').fill('PRIVATE-DRAFT-001');
  await form.locator('input[name=amount]').fill('1.234567');
  await form.locator('input[name=customer]').fill('PRIVATE_CUSTOMER_ONLY');
  await form.locator('textarea[name=note]').fill('PRIVATE_NOTE_DO_NOT_SHARE');
  await form.getByRole('button', { name: 'Add receivable', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Business record details' })).toBeVisible();
  const original = (await businessRecords(page))[0];
  await page.getByRole('link', { name: 'Create a signed request', exact: false }).click();
  await expect(page).toHaveURL(new RegExp(`/requests/new#receivable=${original.id}$`));
  await expect(page.locator('input[name=reference]')).toHaveValue(original.reference);
  await expect(page.locator('input[name=amount]')).toHaveValue('1.234567');
  await expect(page.locator('textarea[name=description]')).toHaveValue('');
  await expect(page.locator('input[name=deadline]')).toHaveValue('');
  await expect(page.locator('.composer-grid')).not.toContainText(original.customer);
  await expect(page.locator('.composer-grid')).not.toContainText(original.note);
  await connectWallet(page);
  await page.getByRole('button', { name: 'Sign & create request', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Signed request saved and linked');
  const result = await verifyRequest(state.request);
  expect(result.message.amount).toBe(original.amount); expect(result.message.reference).toBe(original.reference);
  expect(result.message.description).toBe(''); expect(result.message.payee).toBe(state.account);
  const linked = (await businessRecords(page))[0];
  expect(linked.requestId).toBe(result.requestId); expect(linked.note).toBe(original.note); expect(linked.customer).toBe(original.customer);
  const link = requestLink(result, origin);
  await page.goto(link);
  await expect(page.locator('.request-title')).toHaveText(original.reference);
  await expect(page.locator('body')).not.toContainText(original.customer);
  await expect(page.locator('body')).not.toContainText(original.note);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_CUSTOMER_ONLY'); expect(JSON.stringify(result)).not.toContain('PRIVATE_NOTE_DO_NOT_SHARE');
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});

test('synthetic: a clean mobile browser independently rechecks handoff evidence and rejects a tampered signature', async ({ page, context, browser }, testInfo) => {
  const state = await harness(context); state.request = await requestFor(); state.mined = true;
  await importRequests(page, [state.request]);
  await importBusiness(page, [{ reference: state.request.message.reference, amount: '100', customer: 'Synthetic handoff customer', note: 'Private handoff note, intentionally included in the package.', request_id: state.request.requestId }]);
  await page.getByRole('button', { name: `Review ${state.request.message.reference}`, exact: true }).click();
  await diagnose(page);
  await expect(page.locator('.business-table')).toContainText('Payment verified');
  await page.locator('.work-tabs').getByRole('link', { name: 'Handoff & recheck', exact: false }).click();
  const json = await downloadText(page, 'Download workspace handoff (1)');
  const packet = JSON.parse(json);
  expect(packet.records[0].request).toEqual(state.request);
  expect(packet.records[0].hashes).toEqual([txHash]);
  expect(packet.records[0].snapshot.payments).toHaveLength(1);
  const clean = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const cleanState = await harness(clean); cleanState.request = state.request; cleanState.mined = true;
    const verifier = await clean.newPage(); await openTestnetWorkspace(verifier,origin + '/handoff');
    await verifier.getByLabel('Open handoff JSON', { exact: true }).setInputFiles({ name: 'handoff.json', mimeType: 'application/json', buffer: Buffer.from(json) });
    const panel = verifier.getByRole('region', { name: 'Independent handoff verification' });
    await expect(panel).toContainText('File structure and request signatures checked');
    const totals = verifier.getByRole('region', { name: 'Arc Testnet handoff totals' });
    await expect(totals).toContainText('Verified receipts (0 unique payments)');
    await expect(totals.locator('dd').nth(0)).toHaveText('100.00 USDC');
    await expect(totals.locator('dd').nth(1)).toHaveText('80.00 USDC');
    await expect(totals.locator('dd').nth(2)).toHaveText('0.00 USDC');
    await panel.getByRole('button', { name: 'Verify known transactions', exact: true }).click();
    await expect(panel).toContainText('Known-transaction checks finished');
    await expect(totals).toContainText('Verified receipts (1 unique payments)');
    await expect(totals.locator('dd').nth(2)).toHaveText('80.00 USDC');
    await expect(panel.locator('.handoff-record')).toContainText('Business/request mismatch: Amount');
    await expect(panel.locator('.handoff-record')).toContainText('Range lookup: not run');
    await panel.getByRole('button', { name: 'Run full-range lookup', exact: true }).click();
    await expect(panel).toContainText('Read operations finished');
    await expect(panel.locator('.handoff-record')).toContainText('Range lookup: complete through block 101');
    expect(await businessRecords(verifier)).toEqual([]); expect(await saved(verifier)).toEqual([]);
    expect(await verifier.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await verifier.screenshot({ path: testInfo.outputPath('independent-handoff-mobile.png'), fullPage: true });
    packet.records[0].request.message.amount = '100000000';
    await verifier.getByLabel('Open handoff JSON', { exact: true }).setInputFiles({ name: 'tampered-handoff.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(packet)) });
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Verify known transactions', exact: true })).toHaveCount(0);
    await expect(panel.locator('.handoff-summary')).toHaveCount(0);
    expect(await businessRecords(verifier)).toEqual([]); expect(await saved(verifier)).toEqual([]);
    expect(cleanState.receiptReads).toBeGreaterThan(0); expect(cleanState.sent).toHaveLength(0); expect(cleanState.unexpected).toEqual([]);
  } finally { await clean.close(); }
  expect(state.sent).toHaveLength(0); expect(state.unexpected).toEqual([]);
});
