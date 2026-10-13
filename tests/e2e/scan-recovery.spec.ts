// Synthetic transport only. Real testnet acceptance is reported separately.
import { test, expect } from '@playwright/test';
import { harness, importRequests, navigateTo, saved } from './harness';
import { txHash } from '../fixtures';

test('synthetic: JSON-RPC rate limiting recovers within bounds, exhaustion preserves receipts, refresh requires recheck',async({page,context})=>{
  const state=await harness(context);state.mined=true;state.logRateFailures=1;
  await importRequests(page,[state.request]);await navigateTo(page,'Payment requests');
  await expect(page.getByRole('note')).toContainText('Zero verified receipts does not mean unpaid');
  await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('RATE_LIMIT');
  await expect(page.getByRole('status')).toContainText('1 of 1 requests fully checked');
  expect(state.logReads).toBe(2);
  await expect(page.locator('.metric').nth(1)).toContainText('0.01');
  expect((await saved(page)).find(r=>r.request)?.hashes).toEqual([txHash]);

  state.logRateFailures=3;
  await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('1 incomplete or failed');
  expect(state.logReads).toBe(5);
  await expect(page.locator('.metric').nth(1)).toContainText('0.01');
  await page.getByRole('button',{name:'Open TEST-001',exact:true}).click();
  const evidence=page.getByRole('region',{name:'Payment evidence',exact:true});
  await expect(evidence).toContainText('Incomplete');
  await expect(evidence).toContainText('rpcCode=-32005');
  await expect(evidence).toContainText('attempts=3');
  await expect(evidence).toContainText('0.01 USDC received');

  await page.reload();
  await expect(page.getByRole('note')).toContainText('Zero verified receipts does not mean unpaid');
  expect((await saved(page)).find(r=>r.request)?.hashes).toEqual([txHash]);
  await page.getByRole('button',{name:'Check all',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('1 of 1 requests fully checked');
  await expect(page.locator('.metric').nth(1)).toContainText('0.01');
  expect(state.sent).toHaveLength(0);expect(state.unexpected).toEqual([]);
});
