// All RPC results in this file are synthetic; no wallet or network is accessed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import type { ArcClient } from '../src/chain';
import { USDC } from '../src/config';
import type { SignedRequest } from '../src/protocol';
import { watchPayment } from '../src/payment-watch';
import { rpcEvidence as evidence, otherHash, payer, signed, txHash } from './fixtures';

function rpc(req: SignedRequest) {
  const fixture=evidence(req);
  const methods={
    getChainId:vi.fn(async()=>req.domain.chainId),
    getTransactionReceipt:vi.fn(async()=>fixture.receipt),
    getTransaction:vi.fn(async()=>fixture.transaction),
    getBlock:vi.fn(async()=>({number:101n,hash:fixture.receipt.blockHash,timestamp:fixture.blockTimestamp})),
    getCode:vi.fn(async()=>fixture.senderCode),
  };
  return {fixture,methods,client:methods as unknown as ArcClient};
}
const missing = () => new TransactionReceiptNotFoundError({hash:txHash});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('bounded automatic confirmation, synthetic RPC only',()=>{
  it('immediately confirms only through the shared full receipt verifier',async()=>{
    const req=await signed(),mock=rpc(req),progress=vi.fn();
    const result=await watchPayment(req,txHash,{payer,client:mock.client,progress});
    expect(result).toMatchObject({status:'verified',attempts:1,payment:{hash:txHash,payer,requestId:req.requestId,amount:req.message.amount,chainId:req.domain.chainId}});
    expect(mock.methods.getBlock).toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('Checking submitted payment (1/20)…');
  });
  it('waits three seconds after a missing receipt, without querying the pending transaction',async()=>{
    const req=await signed(),mock=rpc(req);vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockRejectedValueOnce(missing());
    const waiting=watchPayment(req,txHash,{payer,client:mock.client});
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);expect(mock.methods.getTransaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({status:'verified',attempts:2});
  });
  it('stops after twenty pending checks and preserves an unresolved result',async()=>{
    const req=await signed(),mock=rpc(req);vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockRejectedValue(missing());
    const waiting=watchPayment(req,txHash,{payer,client:mock.client});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toMatchObject({status:'pending',attempts:20,error:{code:'PAYMENT_PENDING',context:{txHash,requestId:req.requestId}}});
    expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(20);
    expect(mock.methods.getTransaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(20);
  });
  it('bounds a never-returning RPC by sixty seconds instead of leaving the page waiting',async()=>{
    const req=await signed(),mock=rpc(req);vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockReturnValue(new Promise(()=>{}));
    const waiting=watchPayment(req,txHash,{payer,client:mock.client});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toMatchObject({status:'pending',attempts:1});
    expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight RPC immediately and ignores its later result',async()=>{
    const req=await signed(),mock=rpc(req),controller=new AbortController(),progress=vi.fn();vi.useFakeTimers();
    let finish!: (value:typeof mock.fixture.receipt)=>void;
    mock.methods.getTransactionReceipt.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    const waiting=watchPayment(req,txHash,{payer,client:mock.client,signal:controller.signal,progress});
    await vi.advanceTimersByTimeAsync(0);controller.abort();
    expect(await waiting).toMatchObject({status:'cancelled',attempts:1});
    const count=progress.mock.calls.length;finish(mock.fixture.receipt);await vi.advanceTimersByTimeAsync(100_000);
    expect(mock.methods.getTransaction).not.toHaveBeenCalled();expect(progress).toHaveBeenCalledTimes(count);
  });
  it('does not resume RPC retries after cancellation during a transient-error backoff',async()=>{
    const req=await signed(),mock=rpc(req),controller=new AbortController();vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockRejectedValue(new Error('fetch failed'));
    const waiting=watchPayment(req,txHash,{payer,client:mock.client,signal:controller.signal});
    await vi.advanceTimersByTimeAsync(0);controller.abort();
    expect(await waiting).toMatchObject({status:'cancelled'});
    await vi.advanceTimersByTimeAsync(100_000);expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it('cancels during the polling interval without querying again',async()=>{
    const req=await signed(),mock=rpc(req),controller=new AbortController();vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockRejectedValue(missing());
    const waiting=watchPayment(req,txHash,{payer,client:mock.client,signal:controller.signal});
    await vi.advanceTimersByTimeAsync(500);controller.abort();
    expect(await waiting).toMatchObject({status:'cancelled',attempts:1});
    await vi.advanceTimersByTimeAsync(60_000);expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it('does not begin any reads when already cancelled',async()=>{
    const req=await signed(),mock=rpc(req),controller=new AbortController();controller.abort();
    expect(await watchPayment(req,txHash,{payer,client:mock.client,signal:controller.signal})).toMatchObject({status:'cancelled',attempts:0});
    expect(mock.methods.getChainId).not.toHaveBeenCalled();
  });
  it('reports a deterministic RPC failure distinctly without assuming a failed payment',async()=>{
    const req=await signed(),mock=rpc(req);mock.methods.getTransactionReceipt.mockRejectedValue(new Error('access forbidden'));
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'rpc-error',attempts:1,error:{code:'PAYMENT_WATCH_READ_FAILED',context:{requestId:req.requestId,txHash}}});
    expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it('reports the wrong RPC network as incompatible evidence',async()=>{
    const req=await signed(),mock=rpc(req);mock.methods.getChainId.mockResolvedValue(5042);
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'evidence-mismatch',attempts:0,error:{code:'WRONG_RPC_CHAIN',context:{evidenceStage:'network'}}});
    expect(mock.methods.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it('rejects altered request fields before any RPC check instead of misreporting a network failure',async()=>{
    const req=await signed(),mock=rpc(req),altered={...req,message:{...req.message,amount:'999999'}};
    expect(await watchPayment(altered,txHash,{payer,client:mock.client})).toMatchObject({status:'evidence-mismatch',attempts:0,error:{code:'INVALID_REQUEST'}});
    expect(mock.methods.getChainId).not.toHaveBeenCalled();expect(mock.methods.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it('reports a matched included reverted transaction separately from a successful receipt',async()=>{
    const req=await signed(),mock=rpc(req);mock.fixture.receipt.status='reverted';mock.fixture.receipt.logs=[];
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'reverted',attempts:1,error:{code:'TRANSACTION_REVERTED'}});
    expect(mock.methods.getCode).toHaveBeenCalledWith({address:payer,blockNumber:101n});
  });
  it.each(['transaction hash','receipt hash','payer','target','value','call','block','older block','sender code'] as const)('cannot attribute a reverted receipt when %s does not match',async(part)=>{
    const req=await signed(),mock=rpc(req);mock.fixture.receipt.status='reverted';mock.fixture.receipt.logs=[];
    switch(part){
      case 'transaction hash':mock.fixture.transaction.hash=otherHash;break;
      case 'receipt hash':mock.fixture.receipt.transactionHash=otherHash;break;
      case 'payer':mock.fixture.transaction.from='0x3333333333333333333333333333333333333333';break;
      case 'target':mock.fixture.transaction.to=payer;break;
      case 'value':mock.fixture.transaction.value=1n;break;
      case 'call':mock.fixture.transaction.input='0x';break;
      case 'block':mock.fixture.transaction.blockNumber=102n;break;
      case 'older block':mock.fixture.transaction.blockNumber=99n;mock.fixture.receipt.blockNumber=99n;break;
      case 'sender code':mock.methods.getCode.mockResolvedValue('0x01');break;
    }
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'evidence-mismatch',error:{code:'EVIDENCE_MISMATCH',context:{evidenceStage:'transaction'}}});
  });
  it.each(['memo','transfer'] as const)('preserves the verifier failure stage when %s evidence is missing',async(stage)=>{
    const req=await signed(),mock=rpc(req);
    mock.fixture.receipt.logs=stage==='memo'?[]:mock.fixture.receipt.logs.filter(log=>log.address!==USDC);
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'evidence-mismatch',error:{
      code:'EVIDENCE_MISMATCH',stage:'payment-watch',context:{requestId:req.requestId,txHash,evidenceStage:stage},
      cause:{code:'EVIDENCE_MISMATCH',stage:'receipt',context:{evidenceStage:stage}},
    }});
  });
  it('checks the requested hash again if the RPC changes evidence between reads',async()=>{
    const req=await signed(),mock=rpc(req),different=evidence(req,otherHash);
    mock.methods.getTransaction.mockResolvedValueOnce(mock.fixture.transaction).mockResolvedValue(different.transaction);
    mock.methods.getTransactionReceipt.mockResolvedValueOnce(mock.fixture.receipt).mockResolvedValue(different.receipt);
    expect(await watchPayment(req,txHash,{payer,client:mock.client})).toMatchObject({status:'evidence-mismatch',error:{code:'EVIDENCE_MISMATCH'}});
  });
});
