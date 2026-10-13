import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { MARKER, USDC } from '../src/config';
import { callHash } from '../src/protocol';
import { PayRefError } from '../src/errors';
import { mergePayments, verifyEvidence } from '../src/verification';
import type { PaymentEvidence } from '../src/verification';
import { evidence, otherHash, payer, signed } from './fixtures';

describe('receipt verification with synthetic Arc-shaped logs',()=>{
  it('counts the 6-decimal Transfer once despite a native 18-decimal log',async()=>{
    const r=await signed();const p=verifyEvidence(r,evidence(r));expect(p.amount).toBe('10000');expect(p.gasCostNative).toBe('1100000000000000');expect(p.late).toBe(false);
  });
  const changes:[string,(e:PaymentEvidence)=>void][]=[
    ['wrong network',e=>{e.chainId=1;}],['reverted',e=>{e.receipt.status='reverted';}],['receipt hash',e=>{e.receipt.transactionHash=otherHash;}],
    ['pending',e=>{e.transaction.blockNumber=null;}],['before request',e=>{e.transaction.blockNumber=99n;e.receipt.blockNumber=99n;}],
    ['wrong target',e=>{e.transaction.to=USDC;}],['native value',e=>{e.transaction.value=1n;}],['calldata',e=>{e.transaction.input='0x';}],
    ['delegated sender',e=>{e.senderCode='0xef010001';}],['fake emitter',e=>{e.receipt.logs[3].address=payer;}],
    ['transfer value',e=>{e.receipt.logs[1].data=encodeAbiParameters([{type:'uint256'}],[9999n]);}],
    ['missing transfer',e=>{e.receipt.logs.splice(1,1);}],['double ERC20 transfer',e=>{e.receipt.logs.push({...e.receipt.logs[1],logIndex:2});}],
    ['outside frame',e=>{e.receipt.logs[1].logIndex=4;}],['log hash',e=>{e.receipt.logs[1].transactionHash=otherHash;}],
    ['wrong recipient',e=>{e.receipt.logs[1].topics=[...e.receipt.logs[1].topics.slice(0,2),`0x${'0'.repeat(24)}${payer.slice(2)}`];}],
    ['memo hash',e=>{e.receipt.logs[3].topics=[...e.receipt.logs[3].topics.slice(0,3),otherHash];}],
    ['extra memo',e=>{e.receipt.logs.push({...e.receipt.logs[3],logIndex:4});}],
  ];
  it.each(changes)('rejects %s',async(_label,change)=>{const r=await signed(),e=evidence(r);change(e);expect(()=>verifyEvidence(r,e)).toThrow();});
  it('rejects incorrect calldata hash, marker and frame ID',async()=>{
    const r=await signed();for(const values of [[otherHash,MARKER,7n],[callHash(r),'0x1234',7n],[callHash(r),MARKER,8n]] as const){const e=evidence(r);e.receipt.logs[3].data=encodeAbiParameters([{type:'bytes32'},{type:'bytes'},{type:'uint256'}],values);expect(()=>verifyEvidence(r,e)).toThrow();}
  });
  it.each([
    ['network',(e:PaymentEvidence)=>{e.chainId=1;}],
    ['transaction',(e:PaymentEvidence)=>{e.receipt.status='reverted';}],
    ['memo',(e:PaymentEvidence)=>{e.receipt.logs[3].address=payer;}],
    ['transfer',(e:PaymentEvidence)=>{e.receipt.logs[1].data=encodeAbiParameters([{type:'uint256'}],[9999n]);}],
  ] as const)('identifies the failed %s evidence stage without losing receipt context',async(stage,change)=>{
    const request=await signed(),input=evidence(request);change(input);
    try{verifyEvidence(request,input);expect.fail('Expected an evidence mismatch.');}
    catch(error){expect(error).toBeInstanceOf(PayRefError);expect(error).toMatchObject({code:'EVIDENCE_MISMATCH',stage:'receipt',context:{requestId:request.requestId,txHash:input.transaction.hash,evidenceStage:stage}});}
  });
  it('deduplicates the same receipt but retains separate payments and networks',async()=>{
    const r=await signed(),a=verifyEvidence(r,evidence(r)),b=verifyEvidence(r,evidence(r,otherHash));expect(mergePayments([a],[a,b])).toHaveLength(2);expect(mergePayments([a],[{...a,chainId:5042}])).toHaveLength(2);
    const e=evidence(r);e.blockTimestamp=2000000000n;expect(verifyEvidence(r,e).late).toBe(true);
  });
});
