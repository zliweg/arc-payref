import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflight, read, scanRequest } from '../src/chain';
import type { ArcClient } from '../src/chain';
import { recoverAttempt } from '../src/recovery';
import type { Attempt } from '../src/storage';
import { verifyEvidence } from '../src/verification';
import { rpcEvidence as evidence, otherHash, payer, signed, txHash } from './fixtures';
import type { SignedRequest } from '../src/protocol';
function clientFor(req:SignedRequest) {
  const e=evidence(req);
  return {getChainId:vi.fn(async()=>5042002),getBlockNumber:vi.fn(async()=>2100n),getLogs:vi.fn(async(_input?:unknown)=>[] as {transactionHash:typeof txHash}[]),getTransaction:vi.fn(async()=>({...e.transaction,nonce:3})),getTransactionReceipt:vi.fn(async()=>e.receipt),getBlock:vi.fn(async(input?:{blockNumber?:bigint})=>({number:input?.blockNumber??2100n,hash:e.receipt.blockHash,timestamp:e.blockTimestamp})),getCode:vi.fn(async()=> '0x'),readContract:vi.fn(async()=>6),getBalance:vi.fn(async()=>10n**18n),estimateFeesPerGas:vi.fn(async()=>({maxFeePerGas:20000000000n,maxPriorityFeePerGas:0n})),getTransactionCount:vi.fn(async()=>3),estimateGas:vi.fn(async()=>50000n)};
}
const asClient=(c:ReturnType<typeof clientFor>)=>c as unknown as ArcClient;
afterEach(()=>vi.useRealTimers());
describe('RPC and state with mocked transport (not chain integration)',()=>{
  it('fully scans segmented ranges before saying no match',async()=>{
    const r=await signed(),c=clientFor(r);const result=await scanRequest(r,{client:asClient(c)});expect(result.complete).toBe(true);expect(result.checkedThroughBlock).toBe('2100');expect(c.getLogs.mock.calls.map(c=>c[0])).toMatchObject([{fromBlock:100n,toBlock:1099n},{fromBlock:1100n,toBlock:2099n},{fromBlock:2100n,toBlock:2100n}]);
  });
  it('paces long historical queries without skipping any range',async()=>{
    vi.useFakeTimers();const r=await signed(),c=clientFor(r),started:number[]=[];
    c.getBlockNumber.mockResolvedValue(11100n);c.getLogs.mockImplementation(async()=>{started.push(performance.now());return [];});
    const pending=scanRequest(r,{client:asClient(c)});await vi.runAllTimersAsync();const result=await pending;
    expect(result.complete).toBe(true);expect(result.checkedThroughBlock).toBe('11100');expect(started).toHaveLength(12);
    for(let i=1;i<started.length;i++)expect(started[i]-started[i-1]).toBeGreaterThanOrEqual(1100);
    expect(c.getLogs.mock.calls.map(call=>(call[0] as {fromBlock:bigint}).fromBlock)).toEqual(Array.from({length:12},(_,i)=>100n+BigInt(i)*1000n));
  });
  it('cancels a pacing wait without another RPC or invented coverage',async()=>{
    vi.useFakeTimers();const r=await signed(),c=clientFor(r),controller=new AbortController();c.getBlockNumber.mockResolvedValue(11100n);
    const pending=scanRequest(r,{client:asClient(c),signal:controller.signal,progress:message=>{if(message.startsWith('Pacing'))setTimeout(()=>controller.abort(),100);}});
    await vi.runAllTimersAsync();const result=await pending;
    expect(c.getLogs).toHaveBeenCalledTimes(1);expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBe('1099');expect(result.error).toContain('cancelled');
  });
  it('retains earlier payments and cursor when a later range fails',async()=>{
    const r=await signed(),c=clientFor(r);c.getLogs.mockResolvedValueOnce([{transactionHash:txHash}]).mockRejectedValueOnce(new Error('permission denied'));
    const result=await scanRequest(r,{client:asClient(c)});expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBe('1099');expect(result.payments).toHaveLength(1);expect(result.error).toContain('1100–2099');
  });
  it('reports safe provider diagnostics and the failed range without exposing request payloads',async()=>{
    const r=await signed(),c=clientFor(r);
    const cause=Object.assign(new Error('invalid params https://secret.invalid/?key=SECRET calldata=SIGNED_PAYLOAD'),{code:-32602});
    c.getLogs.mockResolvedValueOnce([{transactionHash:txHash}]).mockRejectedValueOnce(cause);
    const result=await scanRequest(r,{client:asClient(c)});
    expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBe('1099');expect(result.payments).toHaveLength(1);
    expect(result.error).toContain('1100–2099');expect(result.error).toContain('rpcCode=-32602');expect(result.error).toContain('reason=INVALID_PARAMS');expect(result.error).toContain('attempts=1');expect(result.error).toContain(r.requestId);
    expect(result.error).not.toMatch(/SECRET|SIGNED_PAYLOAD|secret.invalid/);
    await expect(read(async()=>{throw cause;},'scan')).rejects.toMatchObject({cause,context:{rpcCode:'-32602',reason:'INVALID_PARAMS',attempts:'1'}});
  });
  it('identifies receipt-stage failures without incorrectly advancing the log range',async()=>{
    const r=await signed(),c=clientFor(r);c.getLogs.mockResolvedValueOnce([{transactionHash:txHash}]);
    c.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('permission denied'),{status:403}));
    const result=await scanRequest(r,{client:asClient(c)});
    expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBeNull();expect(result.error).toContain('receipt · RPC_READ_FAILED');expect(result.error).toContain('httpStatus=403');expect(result.error).toContain(`txHash=${txHash}`);
  });
  it('never treats a receipt failure as an oversized log query and skips its hash',async()=>{
    const r=await signed(),c=clientFor(r);c.getLogs.mockResolvedValue([{transactionHash:txHash}]);
    c.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('historical block range limit'),{code:-32005}));
    const result=await scanRequest(r,{client:asClient(c)});
    expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBeNull();expect(result.payments).toHaveLength(0);expect(c.getLogs).toHaveBeenCalledTimes(1);expect(result.error).toContain(`txHash=${txHash}`);
  });
  it('reports exhausted retries and respects a Retry-After beyond the bounded wait',async()=>{
    vi.useFakeTimers();const r=await signed(),c=clientFor(r);
    c.getLogs.mockRejectedValue(Object.assign(new Error('HTTP 503 sensitive body'),{status:503}));
    const pending=scanRequest(r,{client:asClient(c)});await vi.runAllTimersAsync();const result=await pending;
    expect(c.getLogs).toHaveBeenCalledTimes(3);expect(result.error).toContain('attempts=3');expect(result.error).toContain('HTTP_SERVER_ERROR');expect(result.error).not.toContain('sensitive body');expect(result.checkedThroughBlock).toBeNull();
    const limited=vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 429'),{status:429,headers:new Headers({'retry-after':'30'})}));
    await expect(read(limited,'scan')).rejects.toMatchObject({context:{httpStatus:'429',reason:'RATE_LIMIT',attempts:'1',retryAfterMs:'30000'}});expect(limited).toHaveBeenCalledTimes(1);
  });
  it('isolates invalid events from valid payments',async()=>{
    const r=await signed(),c=clientFor(r);c.getBlockNumber.mockResolvedValue(101n);c.getLogs.mockResolvedValue([{transactionHash:otherHash},{transactionHash:txHash}]);c.getTransaction.mockResolvedValueOnce({...evidence(r,otherHash).transaction,input:'0x',nonce:3});c.getTransactionReceipt.mockResolvedValueOnce(evidence(r,otherHash).receipt);
    const result=await scanRequest(r,{client:asClient(c)});expect(result.complete).toBe(true);expect(result.anomalies).toHaveLength(1);expect(result.payments).toHaveLength(1);
  });
  it('halves oversized ranges without advancing the cursor',async()=>{
    const r=await signed(),c=clientFor(r);c.getLogs.mockRejectedValueOnce(new Error('block range too large'));
    expect((await scanRequest(r,{client:asClient(c)})).complete).toBe(true);expect(c.getLogs.mock.calls[1][0]).toMatchObject({fromBlock:100n,toBlock:599n});
  });
  it('cancelled scans retain evidence and remain incomplete',async()=>{
    const r=await signed(),c=clientFor(r),signal=AbortSignal.abort();const p=verifyEvidence(r,evidence(r));const result=await scanRequest(r,{client:asClient(c),signal,previous:[p]});expect(result.complete).toBe(false);expect(result.payments).toEqual([p]);expect(result.checkedThroughBlock).toBeNull();expect(c.getLogs).not.toHaveBeenCalled();
  });
  it('does not advance the final range when cancelled while its RPC is in flight',async()=>{
    const r=await signed(),c=clientFor(r),controller=new AbortController();
    c.getBlockNumber.mockResolvedValue(101n);
    c.getLogs.mockImplementation(async()=>{controller.abort();return [];});
    const result=await scanRequest(r,{client:asClient(c),signal:controller.signal});
    expect(result.complete).toBe(false);expect(result.checkedThroughBlock).toBeNull();expect(result.error).toContain('cancelled');
  });
  it('retries transient reads at most twice and never retries deterministic errors',async()=>{
    vi.useFakeTimers();const op=vi.fn().mockRejectedValue(new Error('HTTP 503'));const result=read(op,'test').catch(e=>e);await vi.runAllTimersAsync();expect(await result).toMatchObject({code:'RPC_READ_FAILED'});expect(op).toHaveBeenCalledTimes(3);
    const other=vi.fn().mockRejectedValue(new Error('execution reverted'));await expect(read(other,'test')).rejects.toThrow();expect(other).toHaveBeenCalledTimes(1);
  });
  it('retries JSON-RPC rate limits over HTTP 200 but does not guess from -32005 alone',async()=>{
    vi.useFakeTimers();
    const progress=vi.fn(),limited=vi.fn().mockRejectedValueOnce(Object.assign(new Error('Rate limit exceeded'),{code:-32005})).mockResolvedValue('ok');
    const result=read(limited,'scan',progress);await vi.runAllTimersAsync();expect(await result).toBe('ok');expect(limited).toHaveBeenCalledTimes(2);expect(progress.mock.calls.flat().join(' ')).toContain('RATE_LIMIT');expect(progress.mock.calls.flat().join(' ')).toContain('succeeded after 1 retries');
    const ambiguous=vi.fn().mockRejectedValue(Object.assign(new Error('provider limit'),{code:-32005}));
    await expect(read(ambiguous,'scan')).rejects.toMatchObject({context:{rpcCode:'-32005',reason:'RPC_ERROR',attempts:'1'}});expect(ambiguous).toHaveBeenCalledTimes(1);
    const r=await signed(),c=clientFor(r);c.getLogs.mockRejectedValueOnce(Object.assign(new Error('block range too large'),{code:-32005}));
    expect((await scanRequest(r,{client:asClient(c)})).complete).toBe(true);expect(c.getLogs.mock.calls[1][0]).toMatchObject({fromBlock:100n,toBlock:599n});
  });
  it('checks the shared USDC balance including maximum gas; no floating amounts',async()=>{
    const r=await signed(),c=clientFor(r);c.getCode.mockResolvedValue('0x1234').mockResolvedValueOnce('0x');
    c.getBalance.mockResolvedValue(10000n*10n**12n+60000n*20000000000n);
    expect((await preflight(r,payer,undefined,asClient(c))).gas).toBe(60000n);
    c.getCode.mockResolvedValueOnce('0x');c.getBalance.mockResolvedValue(10000n*10n**12n+60000n*20000000000n-1n);
    await expect(preflight(r,payer,undefined,asClient(c))).rejects.toMatchObject({code:'INSUFFICIENT_BALANCE'});
  });
  it('rejects wrong chain, delegated accounts and future block boundaries',async()=>{
    const r=await signed(),c=clientFor(r);c.getChainId.mockResolvedValueOnce(1);await expect(scanRequest(r,{client:asClient(c)})).rejects.toMatchObject({code:'WRONG_RPC_CHAIN'});
    c.getCode.mockResolvedValue('0xef010001');await expect(preflight(r,payer,undefined,asClient(c))).rejects.toMatchObject({code:'UNSUPPORTED_ACCOUNT'});
    c.getBlockNumber.mockResolvedValueOnce(99n);await expect(scanRequest(r,{client:asClient(c)})).rejects.toMatchObject({code:'FUTURE_BLOCK'});
  });
  it('recovers an included replacement, preserves original hash, rejects unrelated nonce',async()=>{
    const r=await signed(),c=clientFor(r),a:Attempt={version:1,id:'test',requestId:r.requestId,chainId:5042002,payer,status:'SUBMITTED',hash:otherHash,nonce:3,updatedAt:new Date().toISOString()};
    c.getTransaction.mockResolvedValueOnce({...evidence(r).transaction,nonce:3}).mockResolvedValueOnce({...evidence(r,otherHash).transaction,nonce:3});
    const verified=await recoverAttempt(r,a,txHash,asClient(c));expect(verified.attempt).toMatchObject({status:'CONFIRMED',hash:otherHash,replacementHash:txHash});expect(verified.payment).toBeDefined();
    c.getTransaction.mockResolvedValue({...evidence(r).transaction,input:'0x',to:payer,nonce:3}).mockResolvedValueOnce({...evidence(r).transaction,input:'0x',to:payer,nonce:3}).mockResolvedValueOnce({...evidence(r,otherHash).transaction,nonce:3});expect((await recoverAttempt(r,a,txHash,asClient(c))).attempt.status).toBe('REPLACED');
    c.getTransaction.mockResolvedValue({...evidence(r).transaction,nonce:4});await expect(recoverAttempt(r,a,txHash,asClient(c))).rejects.toMatchObject({code:'WRONG_NONCE'});
  });
  it('does not turn a missing receipt into a rejected or unpaid attempt',async()=>{
    const r=await signed(),c=clientFor(r),a:Attempt={version:1,id:'test',requestId:r.requestId,chainId:5042002,payer,status:'UNKNOWN',nonce:3,updatedAt:new Date().toISOString()};c.getTransactionReceipt.mockRejectedValue(new Error('Transaction receipt not found'));
    await expect(recoverAttempt(r,a,txHash,asClient(c))).rejects.toMatchObject({code:'RPC_READ_FAILED'});expect(a.status).toBe('UNKNOWN');
  });
});
