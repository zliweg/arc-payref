import { describe, expect, it } from 'vitest';
import { filterRequests, requestState, summarize } from '../src/dashboard';
import type { ScanResult } from '../src/chain';
import type { Attempt, StoredRequest } from '../src/storage';
import { verifyEvidence } from '../src/verification';
import { evidence, otherHash, payer, signed, unsigned } from './fixtures';

const complete:ScanResult={complete:true,fromBlock:'100',checkedThroughBlock:'101',targetBlock:'101',payments:[],anomalies:[]};
describe('workspace totals and filters (synthetic data)',()=>{
  it('does not count unchecked requests as unpaid or verified receipts',async()=>{
    const r=await signed();const records:StoredRequest[]=[{version:1,request:r,hashes:[otherHash]}];
    expect(requestState(r,[],undefined,[],1900000000n)).toBe('unchecked');
    expect(summarize(records,{}, {},[],1900000000n)).toEqual({requested:10000n,received:0n,unchecked:1,attention:0,paid:0,total:1});
    expect(requestState(r,[],complete,[],1900000000n)).toBe('open');
  });
  it('retains verified receipt totals when a later scan fails and deduplicates evidence',async()=>{
    const r=await signed(),p=verifyEvidence(r,evidence(r)),scan={...complete,complete:false};
    const summary=summarize([{version:1,request:r,hashes:[]}],{[r.requestId]:[p,p]},{[r.requestId]:scan},[],1900000000n);
    expect(summary.received).toBe(10000n);expect(summary.unchecked).toBe(1);expect(summary.paid).toBe(1);expect(summary.attention).toBe(1);
    expect(requestState(r,[p],scan,[],1900000000n)).toBe('paid');
  });
  it('counts actual duplicate receipts but never multiplies requested value',async()=>{
    const r=await signed(),p=verifyEvidence(r,evidence(r)),p2=verifyEvidence(r,evidence(r,otherHash));
    expect(summarize([{version:1,request:r,hashes:[]}],{[r.requestId]:[p,p2]},{[r.requestId]:complete},[],1900000000n)).toMatchObject({requested:10000n,received:20000n,attention:1,paid:1});
  });
  it('keeps expiry separate from historical payment and unresolved attempts',async()=>{
    const r=await signed(),p=verifyEvidence(r,evidence(r));
    expect(requestState(r,[],undefined,[],2000000000n)).toBe('expired');expect(requestState(r,[p],undefined,[],2000000000n)).toBe('paid');
    const a:Attempt={version:1,id:'synthetic',requestId:r.requestId,chainId:r.domain.chainId,payer,nonce:0,updatedAt:new Date().toISOString(),status:'UNKNOWN'};
    expect(requestState(r,[],complete,[a],1900000000n)).toBe('pending');
  });
  it('searches, filters and sorts without losing bigint precision or mutating records',async()=>{
    const a=unsigned(),b=unsigned();a.message.reference='Design';a.message.amount='9007199254740993000001';a.message.expiresAt='0';b.message.reference='Development';b.message.amount='9007199254740993000002';
    const r1=await signed(a),r2=await signed(b),records:StoredRequest[]=[{version:1,request:r1,hashes:[]},{version:1,request:r2,hashes:[]}];
    const filtered=filterRequests(records,'develop','all','newest',{}, {},[],1900000000n);expect(filtered.map(r=>r.request.requestId)).toEqual([r2.requestId]);
    expect(filterRequests(records,'','all','amount',{}, {},[],1900000000n)[0].request.requestId).toBe(r2.requestId);
    expect(filterRequests(records,'','all','deadline',{}, {},[],1900000000n)[0].request.requestId).toBe(r2.requestId);
    expect(filterRequests(records,'','paid','amount',{}, {},[],1900000000n)).toHaveLength(0);expect(records[0].request.requestId).toBe(r1.requestId);
  });
});
