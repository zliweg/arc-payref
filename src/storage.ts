import { keccak256, stringToHex, type Hex, type Address } from 'viem';
import { address, record, verifyRequest } from './protocol';
import { network } from './config';
import type { SignedRequest } from './protocol';
import type { VerifiedPayment } from './verification';
import { PayRefError } from './errors';

const PREFIX = 'arc-payref:v1:';
const EXPORT_KEY = PREFIX+'exports';
const MAX_EXPORT_RECORDS = 1000;
const INBOX_PREFIX = PREFIX+'inbox:';
const MAX_INBOX_RECORDS = 1000;
export interface StoredRequest { version: 1; request: SignedRequest; hashes: Hex[] }
export interface InboxBookmark { version: 1; chainId: number; requestId: Hex; savedAt: string }
export interface ExportStatus { neverExported: number; changed: number; lastExportedAt?: string; error?: string }
interface ExportRecord { chainId: number; requestId: Hex; fingerprint: Hex; exportedAt: string }
function exportIdentity(chainId: number, requestId: Hex) { return `${chainId}:${requestId.toLowerCase()}`; }
function exportFingerprint(entry: StoredRequest): Hex {
  network(entry.request.domain.chainId);
  const requestId=transactionHash(entry.request.requestId).toLowerCase();
  const hashes=[...new Set(entry.hashes.map(hash=>transactionHash(hash).toLowerCase()))].sort();
  return keccak256(stringToHex(JSON.stringify([entry.request.domain.chainId,requestId,hashes])));
}
export type AttemptStatus = 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'REJECTED' | 'REVERTED' | 'REPLACED' | 'UNKNOWN';
export interface Attempt { version: 1; id: string; requestId: Hex; chainId: number; payer: Address; status: AttemptStatus; hash?: Hex; replacementHash?: Hex; nonce: number; updatedAt: string; errorCode?: string }
export const unresolved = (status: AttemptStatus) => ['AWAITING_SIGNATURE','SUBMITTED','UNKNOWN'].includes(status);
export function transactionHash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new PayRefError('INVALID_HASH','receipt','Expected a 32-byte transaction hash.');
  return value as Hex;
}
export class Repository {
  constructor(private storage: Storage) {}
  private read(key: string): unknown {
    try { const value = this.storage.getItem(key); return value === null ? null : JSON.parse(value); }
    catch (cause) { throw new PayRefError('STORAGE_READ','storage','Local storage is unavailable or contains damaged data. Existing data was not removed.',{}, { cause }); }
  }
  private write(key: string, value: unknown) {
    try { const encoded = JSON.stringify(value); this.storage.setItem(key,encoded);
      if (this.storage.getItem(key) !== encoded) throw new Error('Read-back mismatch'); }
    catch (cause) { throw new PayRefError('STORAGE_WRITE','storage','Local data could not be saved. Keep your request or transaction hash separately.',{}, { cause }); }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('payref-storage'));
  }
  private all(prefix: string): unknown[] {
    try { const results: unknown[]=[]; for(let i=0; i<this.storage.length; i++) { const key=this.storage.key(i); if(key?.startsWith(prefix)) results.push(this.read(key)); } return results; }
    catch(cause) { if(cause instanceof PayRefError) throw cause; throw new PayRefError('STORAGE_READ','storage','Cannot enumerate local records.',{}, {cause}); }
  }
  async requests(): Promise<StoredRequest[]> {
    return Promise.all(this.all(PREFIX+'request:').map(async value => {
      const obj=record(value);
      if(obj.version !== 1 || !Array.isArray(obj.hashes)) throw new PayRefError('STORAGE_FORMAT','storage','Unsupported local request record.');
      return {version:1 as const, request: await verifyRequest(obj.request), hashes: obj.hashes.map(transactionHash)};
    }));
  }
  async saveRequest(req: SignedRequest, hashes: Hex[] = []) {
    const verified = await verifyRequest(req);
    const key = `${PREFIX}request:${verified.domain.chainId}:${verified.requestId}`;
    const previous=this.read(key);
    let known: Hex[]=[];
    if(previous !== null) {
      const old=record(previous);
      if(old.version !== 1 || !Array.isArray(old.hashes)) throw new PayRefError('STORAGE_FORMAT','storage','Existing record is damaged.');
      const oldReq=await verifyRequest(old.request);
      if (JSON.stringify(oldReq.message)!==JSON.stringify(verified.message) || oldReq.domain.chainId!==verified.domain.chainId) throw new PayRefError('IMPORT_CONFLICT','storage','Request content conflicts with the stored record.');
      known=old.hashes.map(transactionHash);
    }
    this.write(key,{version:1,request:verified,hashes:[...new Set([...known,...hashes.map(transactionHash)])]});
  }
  // Bookmark metadata is intentionally separate from signed requests and payment facts.
  inbox(): InboxBookmark[] {
    try {
      const keys:string[]=[];
      for(let i=0;i<this.storage.length;i++) {
        const key=this.storage.key(i);
        if(key?.startsWith(INBOX_PREFIX)) keys.push(key);
        if(keys.length>MAX_INBOX_RECORDS) throw new Error('Inbox record limit exceeded.');
      }
      const seen=new Set<string>();
      return keys.map(key=>{
        const item=record(this.read(key));
        if(Object.keys(item).sort().join(',')!=='chainId,requestId,savedAt,version' || item.version!==1 || typeof item.chainId!=='number' || typeof item.savedAt!=='string' || !Number.isFinite(Date.parse(item.savedAt)) || new Date(item.savedAt).toISOString()!==item.savedAt) throw new Error('Malformed inbox bookmark.');
        network(item.chainId);
        const requestId=transactionHash(item.requestId).toLowerCase() as Hex;
        const identity=exportIdentity(item.chainId,requestId);
        if(key!==`${INBOX_PREFIX}${identity}` || seen.has(identity)) throw new Error('Mismatched or duplicate inbox bookmark identity.');
        seen.add(identity);
        return {version:1 as const,chainId:item.chainId,requestId,savedAt:item.savedAt};
      }).sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
    } catch(cause) {
      throw new PayRefError('INBOX_READ','inbox','Payment inbox metadata is unavailable or damaged. Saved requests, transaction hashes and payment attempts are unaffected.',{}, {cause});
    }
  }
  async saveToInbox(req: SignedRequest): Promise<void> {
    const verified=await verifyRequest(req);
    await this.saveRequest(verified);
    try {
      await locked('inbox',async()=>{
        const entries=this.inbox();
        if(entries.some(entry=>entry.chainId===verified.domain.chainId && entry.requestId===verified.requestId)) return;
        if(entries.length>=MAX_INBOX_RECORDS) throw new PayRefError('INBOX_LIMIT','inbox','The payment inbox supports at most 1,000 bookmarks. Remove a bookmark before adding another.');
        this.write(`${INBOX_PREFIX}${verified.domain.chainId}:${verified.requestId}`,{version:1,chainId:verified.domain.chainId,requestId:verified.requestId,savedAt:new Date().toISOString()});
      });
    } catch(cause) {
      throw new PayRefError('INBOX_SAVE_FAILED','inbox',`The signed request was saved locally, but its inbox bookmark could not be saved. ${cause instanceof PayRefError?cause.message:'Try saving the bookmark again.'}`,{requestId:verified.requestId}, {cause});
    }
  }
  async removeFromInbox(chainId: number, inputId: Hex): Promise<void> {
    network(chainId);
    const requestId=transactionHash(inputId).toLowerCase() as Hex;
    await locked('inbox',async()=>{
      const entries=this.inbox();
      if(!entries.some(entry=>entry.chainId===chainId && entry.requestId===requestId)) return;
      const key=`${INBOX_PREFIX}${chainId}:${requestId}`;
      try {
        this.storage.removeItem(key);
        if(this.storage.getItem(key)!==null) throw new Error('Bookmark removal read-back mismatch.');
      } catch(cause) {
        throw new PayRefError('INBOX_REMOVE_FAILED','inbox','The inbox bookmark could not be removed. Its signed request and payment records were not deleted.',{requestId}, {cause});
      }
      if(typeof window!=='undefined') window.dispatchEvent(new Event('payref-storage'));
    });
  }
  private exports(): ExportRecord[] {
    const value=this.read(EXPORT_KEY);
    if(value===null) return [];
    const root=record(value);
    if(root.version!==1 || !Array.isArray(root.entries) || root.entries.length>MAX_EXPORT_RECORDS) throw new PayRefError('EXPORT_HISTORY_FORMAT','backup','Download history is damaged or unsupported. Saved requests are unaffected.');
    const identities=new Set<string>();
    return root.entries.map(value=>{
      const item=record(value);
      if(typeof item.chainId!=='number' || typeof item.exportedAt!=='string' || !Number.isFinite(Date.parse(item.exportedAt))) throw new PayRefError('EXPORT_HISTORY_FORMAT','backup','Download history is damaged. Saved requests are unaffected.');
      network(item.chainId);
      const requestId=transactionHash(item.requestId),fingerprint=transactionHash(item.fingerprint);
      const identity=exportIdentity(item.chainId,requestId);
      if(identities.has(identity)) throw new PayRefError('EXPORT_HISTORY_FORMAT','backup','Download history contains duplicate records. Saved requests are unaffected.');
      identities.add(identity);
      return {chainId:item.chainId,requestId,fingerprint,exportedAt:item.exportedAt};
    });
  }
  exportStatus(records: StoredRequest[]): ExportStatus {
    try {
      const entries=new Map(this.exports().map(entry=>[exportIdentity(entry.chainId,entry.requestId),entry]));
      const status: ExportStatus={neverExported:0,changed:0};
      const seen=new Set<string>();
      for(const record of records) {
        const identity=exportIdentity(record.request.domain.chainId,record.request.requestId);
        if(seen.has(identity)) continue;
        seen.add(identity);
        const entry=entries.get(identity);
        if(!entry) status.neverExported++;
        else {
          if(entry.fingerprint.toLowerCase()!==exportFingerprint(record)) status.changed++;
          if(!status.lastExportedAt || Date.parse(entry.exportedAt)>Date.parse(status.lastExportedAt)) status.lastExportedAt=entry.exportedAt;
        }
      }
      return status;
    } catch {
      return {neverExported:0,changed:0,error:'Download history is unavailable. Saved requests are unaffected; download a JSON backup and keep it safely.'};
    }
  }
  // Call only after initiating a JSON download, with that exact snapshot. This
  // records the browser action, never proof that a file was saved or retained.
  recordExport(records: StoredRequest[]): void {
    if(records.length===0) return;
    if(records.length>MAX_EXPORT_RECORDS) throw new PayRefError('EXPORT_HISTORY_LIMIT','backup','Download history supports at most 1,000 requests. Existing history was not changed.');
    const entries=new Map(this.exports().map(entry=>[exportIdentity(entry.chainId,entry.requestId),entry]));
    const exportedAt=new Date().toISOString();
    const snapshot=new Map<string,ExportRecord>();
    for(const record of records) {
      const {chainId}=record.request.domain;
      const requestId=transactionHash(record.request.requestId);
      const identity=exportIdentity(chainId,requestId),fingerprint=exportFingerprint(record);
      const duplicate=snapshot.get(identity);
      if(duplicate && duplicate.fingerprint!==fingerprint) throw new PayRefError('EXPORT_SNAPSHOT_CONFLICT','backup','The downloaded snapshot contains conflicting copies of one request.',{requestId});
      snapshot.set(identity,{chainId,requestId,fingerprint,exportedAt});
    }
    for(const [identity,entry] of snapshot) entries.set(identity,entry);
    if(entries.size>MAX_EXPORT_RECORDS) throw new PayRefError('EXPORT_HISTORY_LIMIT','backup','Download history supports at most 1,000 requests. Existing history was not changed.');
    try { this.write(EXPORT_KEY,{version:1,entries:[...entries.values()]}); }
    catch(cause) { throw new PayRefError('EXPORT_HISTORY_WRITE','backup','The JSON download was initiated, but its local history could not be saved. Check the downloaded file and keep it safely.',{}, {cause}); }
  }
  attempts(): Attempt[] {
    return this.all(PREFIX+'attempt:').map(value=> {
      const a=record(value);
      if(a.version!==1 || typeof a.id!=='string' || !a.id || typeof a.chainId!=='number' || typeof a.updatedAt!=='string' || !Number.isFinite(Date.parse(a.updatedAt)) || !Number.isSafeInteger(a.nonce) || Number(a.nonce)<0 || !['AWAITING_SIGNATURE','SUBMITTED','CONFIRMED','REJECTED','REVERTED','REPLACED','UNKNOWN'].includes(String(a.status))) throw new PayRefError('STORAGE_FORMAT','storage','Damaged payment attempt. Payment remains blocked.');
      network(a.chainId);address(a.payer);transactionHash(a.requestId); if(a.hash!==undefined) transactionHash(a.hash);if(a.replacementHash!==undefined)transactionHash(a.replacementHash);
      return a as unknown as Attempt;
    });
  }
  saveAttempt(attempt: Attempt) { this.write(PREFIX+'attempt:'+attempt.id,attempt); }
}
export function browserRepository() {
  try { return new Repository(window.localStorage); }
  catch (cause) { throw new PayRefError('STORAGE_UNAVAILABLE','storage','Local storage is required before sending a payment.',{}, {cause}); }
}
export async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new PayRefError('LOCK_UNAVAILABLE','storage','This browser cannot safely coordinate payment tabs. Use a current desktop Chrome browser.');
  return navigator.locks.request(`arc-payref:${key}`, { ifAvailable:true }, async lock => {
    if (!lock) throw new PayRefError('BUSY_OTHER_TAB','storage','Another tab is working on this request.');
    return operation();
  });
}
export interface ImportPreview { entries: StoredRequest[]; errors: string[] }
export async function inspectBackup(raw: string): Promise<ImportPreview> {
  if (new TextEncoder().encode(raw).length > 2*1024*1024) throw new PayRefError('FILE_TOO_LARGE','import','Backup limit is 2 MiB.');
  let root: Record<string,unknown>;
  try { root=record(JSON.parse(raw)); } catch { throw new PayRefError('INVALID_BACKUP','import','Backup is not valid JSON.'); }
  if(root.version!==1 || !Array.isArray(root.requests) || root.requests.length>1000) throw new PayRefError('INVALID_BACKUP','import','Expected backup version 1 with at most 1,000 requests.');
  const entries: StoredRequest[]=[], errors: string[]=[];
  for(let i=0;i<root.requests.length;i++) {
    try { const entry=record(root.requests[i]); if (!Array.isArray(entry.hashes)) throw new Error('Missing hashes');
      entries.push({version:1,request:await verifyRequest(entry.request),hashes:entry.hashes.map(transactionHash)}); }
    catch { errors.push(`Record ${i+1}: invalid request, signature or transaction hashes. Not imported.`); }
  }
  return {entries,errors};
}
export const backup = (requests: StoredRequest[]) => JSON.stringify({version:1,requests:requests.map(({request,hashes})=>({request,hashes}))},null,2);
function csvCell(value: string) { const safe=/^[\s]*[=+@-]/.test(value) ? `'${value}` : value; return '"'+safe.replaceAll('"','""')+'"'; }
export function exportCsv(requests: StoredRequest[], payments: Record<string,VerifiedPayment[]>) {
  const rows = [['network','request_id','reference','payee','amount_atomic_6','verification','transaction_hash','payer','gas_atomic_18']];
  for (const {request:r} of requests) {
    const found=payments[r.requestId] ?? [];
    if(!found.length) rows.push([String(r.domain.chainId),r.requestId,r.message.reference,r.message.payee,r.message.amount,'NOT_VERIFIED_IN_THIS_SESSION','','','']);
    for(const p of found) rows.push([String(r.domain.chainId),r.requestId,r.message.reference,r.message.payee,r.message.amount,'VERIFIED_PAYMENT',p.hash,p.payer,p.gasCostNative]);
  }
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
export function download(name: string, content: string, type='application/json') {
  const url=URL.createObjectURL(new Blob([content],{type})); const link=document.createElement('a'); link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
