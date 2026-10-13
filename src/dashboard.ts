import type { ScanResult } from './chain';
import type { SignedRequest } from './protocol';
import { expired } from './protocol';
import type { Attempt, StoredRequest } from './storage';
import { unresolved } from './storage';
import { mergePayments } from './verification';
import type { VerifiedPayment } from './verification';

export type RequestState = 'unchecked' | 'open' | 'paid' | 'duplicate' | 'expired' | 'incomplete' | 'pending';
export const stateLabels: Record<RequestState, string> = {
  unchecked: 'Not checked', open: 'No payment found', paid: 'Payment verified', duplicate: 'Duplicate payments',
  expired: 'Deadline reached', incomplete: 'Check incomplete', pending: 'Wallet unresolved',
};
export function needsAttention(request:SignedRequest, payments:VerifiedPayment[], scan:ScanResult|undefined, attempts:Attempt[], now:bigint) {
  return payments.length>1 || Boolean(scan && (!scan.complete || scan.anomalies.length)) || attempts.some(a=>a.requestId===request.requestId && a.chainId===request.domain.chainId && unresolved(a.status)) || (!payments.length && expired(request,now));
}
export function requestState(request: SignedRequest, payments: VerifiedPayment[], scan: ScanResult | undefined, attempts: Attempt[], now: bigint): RequestState {
  if(payments.length > 1) return 'duplicate';
  if(payments.length === 1) return 'paid';
  if(attempts.some(a=>a.requestId===request.requestId && a.chainId===request.domain.chainId && unresolved(a.status))) return 'pending';
  if(scan && !scan.complete) return 'incomplete';
  if(expired(request,now)) return 'expired';
  return scan?.complete ? 'open' : 'unchecked';
}
export function summarize(records: StoredRequest[], payments: Record<string,VerifiedPayment[]>, scans: Record<string,ScanResult>, attempts: Attempt[], now: bigint) {
  let requested=0n,received=0n,unchecked=0,attention=0,paid=0;
  for(const {request:r} of records) {
    const found=mergePayments(payments[r.requestId]??[]).filter(p=>p.chainId===r.domain.chainId && p.requestId===r.requestId);
    requested+=BigInt(r.message.amount);
    received+=found.reduce((sum,p)=>sum+BigInt(p.amount),0n);
    if(!scans[r.requestId]?.complete)unchecked++;
    if(needsAttention(r,found,scans[r.requestId],attempts,now))attention++;
    if(found.length)paid++;
  }
  return {requested,received,unchecked,attention,paid,total:records.length};
}
export function filterRequests(records: StoredRequest[], query:string, filter:RequestState|'all', sort:string, payments:Record<string,VerifiedPayment[]>, scans:Record<string,ScanResult>, attempts:Attempt[], now:bigint) {
  const term=query.trim().toLowerCase();
  return records.filter(({request:r})=>(!term || [r.message.reference,r.message.description,r.message.payee,r.requestId].some(s=>s.toLowerCase().includes(term))) && (filter==='all' || requestState(r,payments[r.requestId]??[],scans[r.requestId],attempts,now)===filter)).sort((a,b)=>{
    const am=a.request.message,bm=b.request.message;
    if(sort==='reference')return am.reference.localeCompare(bm.reference);
    if(sort==='amount')return BigInt(am.amount)===BigInt(bm.amount)?0:BigInt(am.amount)>BigInt(bm.amount)?-1:1;
    if(sort==='deadline') {const x=BigInt(am.expiresAt)||2n**256n,y=BigInt(bm.expiresAt)||2n**256n;return x===y?0:x<y?-1:1;}
    return BigInt(am.createdAtBlock)===BigInt(bm.createdAtBlock)?0:BigInt(am.createdAtBlock)>BigInt(bm.createdAtBlock)?-1:1;
  });
}
