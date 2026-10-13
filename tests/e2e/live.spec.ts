// Real Arc testnet browser reads. The request is signed locally with a public test key.
// This does not test MetaMask signatures, broadcasting or a real payment receipt.
import { test, expect } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { TESTNET, network } from '../../src/config';
import { requestLink } from '../../src/protocol';
import { signed, unsigned } from '../fixtures';
import { origin } from './harness';
import { buildHandoff } from '../../src/handoff';
import { createReceivable } from '../../src/receivables';
import { readFile } from 'node:fs/promises';
import { previewHandoff } from '../../src/handoff';

test('LIVE TESTNET READ ONLY: browser verifies a synthetic request and queries actual Memo logs',async({page})=>{
  test.setTimeout(60000);
  const client=createPublicClient({chain:network(TESTNET),transport:http(undefined,{retryCount:0,timeout:15000})});
  expect(await client.getChainId()).toBe(TESTNET);
  const block=await client.getBlockNumber({cacheTime:0});
  const request=await signed({...unsigned(),message:{...unsigned().message,createdAtBlock:block.toString(),expiresAt:'0',reference:'LIVE-READONLY-TEST',description:'Synthetic request; real RPC reads only. No payment or funds.'}});
  const methods:string[]=[];
  await page.route('https://rpc.testnet.arc.io/**',async route=>{
    const body=route.request().postDataJSON();
    for(const call of Array.isArray(body)?body:[body]){
      methods.push(call.method);
      expect(['eth_chainId','eth_blockNumber','eth_getLogs']).toContain(call.method);
    }
    await route.continue();
  });
  await page.goto(requestLink(request,origin));
  await expect(page.locator('.request-title')).toHaveText('LIVE-READONLY-TEST');
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Checked through block',{timeout:45000});
  await expect(page.locator('.request-status')).toContainText('No payment found');
  await page.locator('.technical-details summary').click();
  await expect(page.locator('.technical-details')).toContainText(`Lookup starts at block ${block}`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(methods).toContain('eth_getLogs');
});

test('LIVE TESTNET READ ONLY: a portable handoff rechecks signatures and actual recent Memo range without importing data',async({page})=>{
  test.setTimeout(60000);
  const client=createPublicClient({chain:network(TESTNET),transport:http(undefined,{retryCount:0,timeout:15000})});
  const block=await client.getBlockNumber({cacheTime:0});
  const request=await signed({...unsigned(),message:{...unsigned().message,createdAtBlock:block.toString(),expiresAt:'0',reference:'LIVE-HANDOFF-READONLY',description:'Public test credential. Business declaration only; no real payment.'}});
  const receivable={...createReceivable({chainId:TESTNET,reference:request.message.reference,amount:'0.01'}),requestId:request.requestId};
  const packet=await buildHandoff([{request,receivable,hashes:[]}]);
  const methods:string[]=[];
  await page.route('https://rpc.testnet.arc.io/**',async route=>{
    const body=route.request().postDataJSON();
    for(const call of Array.isArray(body)?body:[body]){
      methods.push(call.method);
      expect(['eth_chainId','eth_blockNumber','eth_getLogs']).toContain(call.method);
    }
    await route.continue();
  });
  await page.goto('/handoff');
  await page.getByLabel('Open handoff JSON').setInputFiles({name:'live-readonly-handoff.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(packet))});
  await expect(page.locator('.handoff-summary')).toContainText('Not verified in this session.');
  await page.getByRole('button',{name:'Run full-range lookup',exact:true}).click();
  await expect(page.locator('.handoff-record')).toContainText('Range lookup: complete through block',{timeout:45000});
  await expect(page.locator('.handoff-record')).toContainText('0 matching receipt(s)');
  await expect(page.locator('.handoff-errors')).toHaveCount(0);
  expect(methods).toContain('eth_getLogs');
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('arc-payref')))).toEqual([]);
});

// Opt-in acceptance with an existing, user-exported package. Never generates a
// payment or substitutes a synthetic receipt for the real RPC response.
test('LIVE TESTNET READ ONLY: exported payment handoff completes its actual historical range',async({page})=>{
  const path=process.env.PAYREF_ACCEPTANCE_HANDOFF;
  test.skip(!path,'Set PAYREF_ACCEPTANCE_HANDOFF to the testnet acceptance package.');
  test.setTimeout(180000);
  const content=await readFile(path!,'utf8');
  const packet=await previewHandoff(content);
  expect(packet.records).toHaveLength(1);
  const record=packet.records[0];
  expect(record.request?.domain.chainId).toBe(TESTNET);
  expect(record.hashes).toHaveLength(1);
  const methods=new Set<string>();
  await page.route('https://rpc.*.arc.io/**',async route=>{
    expect(new URL(route.request().url()).hostname).toBe('rpc.testnet.arc.io');
    const payload=route.request().postDataJSON();
    for(const call of Array.isArray(payload)?payload:[payload]){
      expect(['eth_chainId','eth_blockNumber','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode']).toContain(call.method);
      methods.add(call.method);
    }
    await route.continue();
  });
  await page.goto('/handoff');
  await page.getByLabel('Open handoff JSON').setInputFiles({name:'acceptance-handoff.json',mimeType:'application/json',buffer:Buffer.from(content)});
  await expect(page.locator('.handoff-summary')).toContainText('Not verified in this session.');
  const started=Date.now();
  await page.getByRole('button',{name:'Run full-range lookup',exact:true}).click();
  await expect(page.locator('.handoff-record')).toContainText('Range lookup: complete through block',{timeout:150000});
  await expect(page.locator('.handoff-record')).toContainText('1 matching receipt(s)');
  await expect(page.locator('.handoff-record')).toContainText(record.request!.requestId);
  await expect(page.locator('.handoff-record').getByRole('link')).toHaveAttribute('href',`${network(TESTNET).blockExplorers.default.url}/tx/${record.hashes[0]}`);
  await expect(page.locator('.handoff-errors')).toHaveCount(0);
  const coverage=(await page.locator('.handoff-record').innerText()).match(/Range lookup: complete through block[^\n]*/)?.[0];
  console.log(JSON.stringify({scope:'REAL_TESTNET_BROWSER_READ_ONLY',elapsedMs:Date.now()-started,requestId:record.request!.requestId,fromBlock:record.request!.message.createdAtBlock,coverage,matchingReceipts:1}));
  expect(methods.has('eth_getLogs')).toBe(true);expect(methods.has('eth_getTransactionReceipt')).toBe(true);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('arc-payref')))).toEqual([]);
});
