// Real mainnet reads against the builder's published historical receipt. Never sends funds.
import { test, expect } from '@playwright/test';

test('LIVE MAINNET READ ONLY: default workspace exposes evidence without importing or paying',async({page})=>{
  test.setTimeout(60000);
  const rpcCalls:string[]=[];
  await page.route('https://rpc.*.arc.io/**',async route=>{
    expect(new URL(route.request().url()).hostname).toBe('rpc.mainnet.arc.io');
    const body=route.request().postDataJSON();
    for(const call of Array.isArray(body)?body:[body]){
      expect(['eth_chainId','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode']).toContain(call.method);
      rpcCalls.push(call.method);
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('.network-chip')).toHaveText('Arc Mainnet');
  await expect(page.getByRole('heading',{level:1})).toHaveText('Know what each USDC payment settles.');
  await expect(page.getByRole('region',{name:'Request overview'})).toContainText('0 signed requests');
  expect(rpcCalls).toEqual([]);
  await page.getByRole('link',{name:'Recheck mainnet payment',exact:true}).click();
  await expect(page.locator('.request-title')).toHaveText('PAYREF-MAINNET-001');
  await expect(page.getByLabel('Transaction hash',{exact:true})).toHaveValue('0x4632b21af3fdbaad5c3f89599fcf6bc2e2a82bc93b24ba346c354badf0086e00');
  await expect(page.locator('.verified-receipt')).toHaveCount(0);
  await page.getByRole('button',{name:'Verify receipt',exact:true}).click();
  await expect(page.locator('.verified-receipt')).toContainText('Payment verified',{timeout:45000});
  await expect(page.locator('.verified-receipt')).toContainText('0.01 USDC');
  await expect(page.locator('.verified-receipt')).toContainText('0.001352240077889024 USDC');
  await expect(page.locator('.verified-receipt')).toContainText('25703820');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(rpcCalls).toContain('eth_getTransactionReceipt');
  const attempts=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('arc-payref:v1:attempt:')));
  expect(attempts).toEqual([]);
  await page.reload();
  await expect(page.locator('.request-title')).toHaveText('PAYREF-MAINNET-001');
  await expect(page.locator('.verified-receipt')).toHaveCount(0);
});
