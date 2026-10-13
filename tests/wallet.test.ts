import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage, otherHash, payee, payer, signed, txHash, unsigned } from './fixtures';
import { Repository } from '../src/storage';
import { connect, connectedAccounts, currentAccount, preparePayment, sendPayment, switchAccount } from '../src/wallet';
import type { PaymentReview, Provider } from '../src/wallet';
import type { SignedRequest } from '../src/protocol';
import { preflight, scanRequest } from '../src/chain';
vi.mock('../src/chain',async importOriginal=>({...await importOriginal<object>(),scanRequest:vi.fn(),preflight:vi.fn()}));
const check = {gas:60000n,maxFeePerGas:20000000000n,maxPriorityFeePerGas:0n,balance:10n**18n,nonce:3};
let storage:MemoryStorage;
beforeEach(()=>{
  storage=new MemoryStorage();vi.stubGlobal('window',{localStorage:storage,dispatchEvent:vi.fn()});vi.stubGlobal('navigator',{locks:{request:vi.fn(async(_name,_options,cb)=>cb({name:_name}))}});
  vi.mocked(scanRequest).mockResolvedValue({complete:true,fromBlock:'100',checkedThroughBlock:'101',targetBlock:'101',payments:[],anomalies:[]});
  vi.mocked(preflight).mockResolvedValue({...check});
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();vi.useRealTimers();});
function review(req: SignedRequest, overrides: Partial<PaymentReview> = {}): PaymentReview {
  const preparedAt=Date.now();
  return {...check,requestId:req.requestId,chainId:req.domain.chainId,payer,checkedThroughBlock:'101',preparedAt,expiresAt:preparedAt+120_000,...overrides};
}
function provider(send:()=>Promise<unknown>){return {request:vi.fn(async({method}:{method:string})=>{if(method==='eth_accounts')return [payer];if(method==='eth_chainId')return '0x4cef52';if(method==='eth_sendTransaction')return send();throw new Error('Unexpected method');})} as unknown as Provider;}
const broadcastCalls = (p: Provider) => vi.mocked(p.request).mock.calls.filter(c=>(c[0] as {method:string}).method==='eth_sendTransaction');
describe('wallet account permission mock; never signs or broadcasts',()=>{
  it('normalizes and deduplicates permitted accounts without discarding their order',async()=>{
    const request=vi.fn().mockResolvedValue([payer,payee.address.toLowerCase(),payee.address,payer]);
    expect(await connectedAccounts({request} as unknown as Provider)).toEqual([payer,payee.address]);
    expect(request.mock.calls).toEqual([[{method:'eth_accounts'}]]);
  });
  it('exposes an empty permitted list without asking for new permissions',async()=>{
    const request=vi.fn().mockResolvedValue([]);
    expect(await connectedAccounts({request} as unknown as Provider)).toEqual([]);
    expect(request.mock.calls).toEqual([[{method:'eth_accounts'}]]);
  });
  it.each([null,{},payer])('rejects a malformed permitted account list %j',async(value)=>{
    const request=vi.fn().mockResolvedValue(value);
    await expect(connectedAccounts({request} as unknown as Provider)).rejects.toMatchObject({code:'INVALID_ACCOUNTS'});
  });
  it.each(['invalid',null,123,'0x7e5F4552091A69125d5DfCb7b8C2659029395Bdf'])('rejects an invalid later account %j instead of returning a partial list',async(value)=>{
    const request=vi.fn().mockResolvedValue([payer,value]);
    await expect(connectedAccounts({request} as unknown as Provider)).rejects.toMatchObject({code:'INVALID_ACCOUNT',context:{accountIndex:'1'}});
  });
  it('accepts an explicitly selected non-first permitted account on the correct chain',async()=>{
    const request=vi.fn(async({method}:{method:string})=>method==='eth_accounts'?[payee.address,payer]:'0x4cef52');
    await expect(currentAccount({request} as unknown as Provider,payer,5042002)).resolves.toBeUndefined();
  });
  it.each([{accounts:[payee.address]},{accounts:[]}])('rejects a selected account after its permission is removed ($accounts)',async({accounts})=>{
    const request=vi.fn(async({method}:{method:string})=>method==='eth_accounts'?accounts:'0x4cef52');
    await expect(currentAccount({request} as unknown as Provider,payer,5042002)).rejects.toMatchObject({code:'WALLET_CHANGED'});
  });
  it('still rejects the wrong chain even when the selected account is permitted',async()=>{
    const request=vi.fn(async({method}:{method:string})=>method==='eth_accounts'?[payee.address,payer]:'0x13b2');
    await expect(currentAccount({request} as unknown as Provider,payer,5042002)).rejects.toMatchObject({code:'WALLET_CHANGED'});
  });
  it('ordinary connect requests accounts without opening permission selection',async()=>{
    const request=vi.fn().mockResolvedValue([payee.address.toLowerCase(),payer]);
    expect(await connect({request} as unknown as Provider)).toBe(payee.address);
    expect(request.mock.calls).toEqual([[{method:'eth_requestAccounts'}]]);
  });
  it('explicit selection reads the current connected account after permission approval',async()=>{
    const request=vi.fn().mockResolvedValueOnce([{parentCapability:'eth_accounts'}]).mockResolvedValueOnce([payee.address.toLowerCase(),payer]);
    expect(await switchAccount({request} as unknown as Provider)).toBe(payee.address);
    expect(request.mock.calls).toEqual([[{method:'wallet_requestPermissions',params:[{eth_accounts:{}}]}],[{method:'eth_accounts'}]]);
  });
  it.each([
    [4001,'USER_REJECTED'],[4100,'ACCOUNT_PERMISSION_DENIED'],[-32601,'ACCOUNT_SELECTION_UNSUPPORTED'],[4200,'ACCOUNT_SELECTION_UNSUPPORTED'],[-32002,'ACCOUNT_SELECTION_PENDING'],[-32603,'ACCOUNT_SELECTION_FAILED'],
  ])('reports permission failure %s without reconnecting or revoking permissions',async(code,expected)=>{
    const cause={code,message:'provider error'},request=vi.fn().mockRejectedValue(cause);
    await expect(switchAccount({request} as unknown as Provider)).rejects.toMatchObject({code:expected,stage:'wallet',context:{rpcCode:String(code)},cause});
    expect(request.mock.calls).toEqual([[{method:'wallet_requestPermissions',params:[{eth_accounts:{}}]}]]);
  });
  it('does not report a selected account when no account was granted',async()=>{
    const request=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(switchAccount({request} as unknown as Provider)).rejects.toMatchObject({code:'NO_ACCOUNT'});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('preserves a read failure after permission approval without re-requesting permissions',async()=>{
    const cause=new Error('provider disconnected'),request=vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(cause);
    await expect(switchAccount({request} as unknown as Provider)).rejects.toMatchObject({code:'ACCOUNTS_READ_FAILED',cause});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects an invalid connected address rather than exposing it for signing',async()=>{
    const request=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(['invalid']);
    await expect(switchAccount({request} as unknown as Provider)).rejects.toMatchObject({code:'INVALID_ACCOUNT'});
  });
});
describe('wallet transport mock; never broadcasts',()=>{
  it('prepares and sends from the explicitly selected permitted account even when it is not first',async()=>{
    const r=await signed(),request=vi.fn(async({method}:{method:string})=>{
      if(method==='eth_accounts')return [payee.address,payer];
      if(method==='eth_chainId')return '0x4cef52';
      if(method==='eth_sendTransaction')return txHash;
      throw new Error('Unexpected method');
    }),p={request} as unknown as Provider;
    const prepared=await preparePayment(r,p,payer,()=>{});
    expect(prepared.payer).toBe(payer);
    await expect(sendPayment(r,p,payer,()=>{},prepared)).resolves.toBe(txHash);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({method:'eth_sendTransaction',params:[expect.objectContaining({from:payer})]}));
    expect(broadcastCalls(p)).toHaveLength(1);
  });
  it('blocks a reviewed payment if the selected non-first account is revoked during the fresh preflight',async()=>{
    const r=await signed();let accounts:string[]=[payee.address,payer];
    const request=vi.fn(async({method}:{method:string})=>{
      if(method==='eth_accounts')return accounts;
      if(method==='eth_chainId')return '0x4cef52';
      if(method==='eth_sendTransaction')return txHash;
      throw new Error('Unexpected method');
    }),p={request} as unknown as Provider;
    vi.mocked(preflight).mockImplementationOnce(async()=>{accounts=[payee.address];return {...check};});
    await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'WALLET_CHANGED'});
    expect(broadcastCalls(p)).toHaveLength(0);expect(new Repository(storage).attempts()).toEqual([]);
  });
  it('prepares a review with complete lookup and fees without signing, sending or saving an attempt',async()=>{
    const r=await signed(),p=provider(async()=>txHash),progress=vi.fn();
    const result=await preparePayment(r,p,payer,progress);
    expect(result).toMatchObject({...check,requestId:r.requestId,chainId:r.domain.chainId,payer,checkedThroughBlock:'101'});
    expect(result.expiresAt-result.preparedAt).toBe(120_000);
    expect(scanRequest).toHaveBeenCalledOnce();expect(preflight).toHaveBeenCalledOnce();
    expect(new Repository(storage).attempts()).toEqual([]);expect(await new Repository(storage).requests()).toEqual([]);
    expect(vi.mocked(p.request).mock.calls.every(c=>['eth_accounts','eth_chainId'].includes((c[0] as {method:string}).method))).toBe(true);
  });
  it('does not produce a review when a scan is cancelled',async()=>{
    const r=await signed(),controller=new AbortController(),p=provider(async()=>txHash);
    vi.mocked(scanRequest).mockImplementationOnce(async()=>{controller.abort();return {complete:false,fromBlock:'100',checkedThroughBlock:null,targetBlock:'101',payments:[],anomalies:[]};});
    await expect(preparePayment(r,p,payer,()=>{},controller.signal)).rejects.toMatchObject({code:'PAYMENT_CHECK_CANCELLED'});
    expect(preflight).not.toHaveBeenCalled();expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('rejects cancellation arriving during preflight instead of exposing a reusable review',async()=>{
    const r=await signed(),controller=new AbortController();
    vi.mocked(preflight).mockImplementationOnce(async()=>{controller.abort();return {...check};});
    await expect(preparePayment(r,provider(async()=>txHash),payer,()=>{},controller.signal)).rejects.toMatchObject({code:'PAYMENT_CHECK_CANCELLED'});
  });
  it('persists the signed request and attempt before invoking the wallet and performs a fresh check after review',async()=>{
    const r=await signed(),repo=new Repository(storage),p=provider(async()=>{expect(repo.attempts()[0].status).toBe('AWAITING_SIGNATURE');expect((await repo.requests())[0].request).toEqual(r);return txHash;});
    const prepared=await preparePayment(r,p,payer,()=>{});
    expect(await sendPayment(r,p,payer,()=>{},prepared)).toBe(txHash);expect(repo.attempts()[0]).toMatchObject({status:'SUBMITTED',hash:txHash,nonce:3});
    expect(scanRequest).toHaveBeenCalledTimes(2);expect(preflight).toHaveBeenCalledTimes(2);
    expect(p.request).toHaveBeenCalledWith(expect.objectContaining({method:'eth_sendTransaction',params:[expect.objectContaining({nonce:'0x3',value:'0x0',from:payer})]}));
  });
  it.each([[4001,'REJECTED'],[-32603,'UNKNOWN']] as const)('classifies wallet code %s without resending',async(code,status)=>{
    const r=await signed(),p=provider(async()=>{throw {code,message:'provider error'};});await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toThrow();
    expect(new Repository(storage).attempts()[0].status).toBe(status);expect(broadcastCalls(p)).toHaveLength(1);
    if(status==='UNKNOWN')await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'UNRESOLVED_ATTEMPT'});
  });
  it('blocks sending when persistence fails',async()=>{
    storage.setItem=()=>{throw new Error('quota');};const p=provider(async()=>txHash),r=await signed();await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'STORAGE_WRITE'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('keeps a sent hash in the error if post-broadcast storage fails',async()=>{
    const p=provider(async()=>{storage.setItem=()=>{throw new Error('quota');};return txHash;}),r=await signed();await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'SENT_NOT_SAVED',context:{txHash}});expect(new Repository(storage).attempts()[0].status).toBe('AWAITING_SIGNATURE');
  });
  it('blocks sending if the fresh scan is incomplete',async()=>{
    const p=provider(async()=>txHash),r=await signed();vi.mocked(scanRequest).mockResolvedValueOnce({complete:false,fromBlock:'100',checkedThroughBlock:null,targetBlock:'101',payments:[],anomalies:[]});await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'INCOMPLETE_SCAN'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('detects wallet account changes after preflight',async()=>{
    const p=provider(async()=>txHash),r=await signed();vi.mocked(preflight).mockImplementationOnce(async()=>{vi.mocked(p.request).mockResolvedValue([] as never);return {...check};});await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'WALLET_CHANGED'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it.each([
    ['gas',{gas:60001n}],['max fee',{maxFeePerGas:20000000001n}],['priority fee',{maxPriorityFeePerGas:1n}],
  ])('requires another review when %s increases even if the balance is sufficient',async(_label,changed)=>{
    const r=await signed(),p=provider(async()=>txHash);vi.mocked(preflight).mockResolvedValue({...check,...changed});
    await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'REVIEW_FEES_CHANGED'});
    expect(broadcastCalls(p)).toHaveLength(0);expect(new Repository(storage).attempts()).toEqual([]);
  });
  it('allows lower fresh fees, submitting only the freshly checked values',async()=>{
    const r=await signed(),p=provider(async()=>txHash);vi.mocked(preflight).mockResolvedValue({...check,gas:55000n,maxFeePerGas:19000000000n});
    await sendPayment(r,p,payer,()=>{},review(r));
    expect(p.request).toHaveBeenCalledWith(expect.objectContaining({method:'eth_sendTransaction',params:[expect.objectContaining({gas:'0xd6d8',maxFeePerGas:'0x46c7cfe00'})]}));
  });
  it('requires another review when the pending nonce changes',async()=>{
    const r=await signed(),p=provider(async()=>txHash);vi.mocked(preflight).mockResolvedValue({...check,nonce:4});
    await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'REVIEW_NONCE_CHANGED'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it.each([
    ['request',{requestId:otherHash}],['network',{chainId:5042}],['account',{payer:'0x3333333333333333333333333333333333333333' as const}],
  ])('rejects a review for another %s',async(_label,changed)=>{
    const r=await signed(),p=provider(async()=>txHash);
    await expect(sendPayment(r,p,payer,()=>{},review(r,changed))).rejects.toMatchObject({code:'REVIEW_CHANGED'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('rejects a changed signed request even when its claimed request ID still matches the review',async()=>{
    const r=await signed(),p=provider(async()=>txHash),altered={...r,message:{...r.message,amount:'999'}};
    await expect(sendPayment(altered,p,payer,()=>{},review(r))).rejects.toThrow();expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('expires the review at its two-minute boundary',async()=>{
    vi.useFakeTimers();const r=await signed(),p=provider(async()=>txHash),prepared=review(r);vi.advanceTimersByTime(120_000);
    await expect(sendPayment(r,p,payer,()=>{},prepared)).rejects.toMatchObject({code:'REVIEW_EXPIRED'});expect(preflight).not.toHaveBeenCalled();expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('rechecks expiry after a slow preflight before any wallet send',async()=>{
    vi.useFakeTimers();const r=await signed(),p=provider(async()=>txHash),prepared=review(r);
    vi.mocked(preflight).mockImplementationOnce(async()=>{vi.advanceTimersByTime(120_000);return {...check};});
    await expect(sendPayment(r,p,payer,()=>{},prepared)).rejects.toMatchObject({code:'REVIEW_EXPIRED'});expect(broadcastCalls(p)).toHaveLength(0);
  });
  it('will not prepare another payment while the previous broadcast remains unresolved',async()=>{
    const r=await signed(),p=provider(async()=>{throw {code:-32603};});
    await expect(sendPayment(r,p,payer,()=>{},review(r))).rejects.toMatchObject({code:'BROADCAST_UNKNOWN'});
    await expect(preparePayment(r,p,payer,()=>{})).rejects.toMatchObject({code:'UNRESOLVED_ATTEMPT'});expect(broadcastCalls(p)).toHaveLength(1);
  });
  it('a valid new request still cannot reuse an earlier request review',async()=>{
    const original=await signed(),next=await signed({...unsigned(),message:{...unsigned().message,nonce:otherHash}}),p=provider(async()=>txHash);
    await expect(sendPayment(next,p,payer,()=>{},review(original))).rejects.toMatchObject({code:'REVIEW_CHANGED'});
  });
  it('does not send or create an attempt when cancelled during the fresh preflight',async()=>{
    const r=await signed(),p=provider(async()=>txHash),controller=new AbortController();
    vi.mocked(preflight).mockImplementationOnce(async()=>{controller.abort();return {...check};});
    await expect(sendPayment(r,p,payer,()=>{},review(r),controller.signal)).rejects.toMatchObject({code:'PAYMENT_CHECK_CANCELLED'});
    expect(broadcastCalls(p)).toHaveLength(0);expect(new Repository(storage).attempts()).toEqual([]);
    expect(scanRequest).toHaveBeenCalledWith(r,expect.objectContaining({signal:controller.signal}));
  });
  it('does not send if cancellation occurs while saving the request before an attempt exists',async()=>{
    const r=await signed(),p=provider(async()=>txHash),controller=new AbortController(),save=Repository.prototype.saveRequest;
    const saving=vi.spyOn(Repository.prototype,'saveRequest').mockImplementationOnce(async function(this:Repository,request,hashes){await save.call(this,request,hashes);controller.abort();});
    try {
      await expect(sendPayment(r,p,payer,()=>{},review(r),controller.signal)).rejects.toMatchObject({code:'PAYMENT_CHECK_CANCELLED'});
      expect(broadcastCalls(p)).toHaveLength(0);expect(new Repository(storage).attempts()).toEqual([]);
      expect((await new Repository(storage).requests())[0].request.requestId).toBe(r.requestId);
    } finally { saving.mockRestore(); }
  });
  it('checks cancellation after the last progress callback before saving an attempt',async()=>{
    const r=await signed(),p=provider(async()=>txHash),controller=new AbortController();
    const progress=(message:string)=>{if(message.startsWith('Estimated maximum gas:'))controller.abort();};
    await expect(sendPayment(r,p,payer,progress,review(r),controller.signal)).rejects.toMatchObject({code:'PAYMENT_CHECK_CANCELLED'});
    expect(broadcastCalls(p)).toHaveLength(0);expect(new Repository(storage).attempts()).toEqual([]);
  });
  it('keeps the returned hash and submitted status if cancelled after the wallet call begins',async()=>{
    const r=await signed(),controller=new AbortController(),p=provider(async()=>{controller.abort();return txHash;});
    await expect(sendPayment(r,p,payer,()=>{},review(r),controller.signal)).resolves.toBe(txHash);
    expect(broadcastCalls(p)).toHaveLength(1);
    const repository=new Repository(storage);
    expect(repository.attempts()[0]).toMatchObject({status:'SUBMITTED',hash:txHash});
    expect((await repository.requests())[0].hashes).toEqual([txHash]);
  });
});
