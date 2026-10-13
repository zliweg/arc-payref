import { describe, expect, it, vi, afterEach } from 'vitest';
import { Repository, backup, exportCsv, inspectBackup, locked } from '../src/storage';
import { MemoryStorage, otherHash, signed, txHash, unsigned } from './fixtures';
afterEach(()=>vi.unstubAllGlobals());
describe('local persistence and untrusted imports',()=>{
  it('restores full signed requests, merges hashes and ignores claimed PAID status',async()=>{
    const r=await signed(),storage=new MemoryStorage(),repo=new Repository(storage);
    await repo.saveRequest(r,[txHash]);await repo.saveRequest(r,[otherHash,txHash]);
    const all=await repo.requests();expect(all[0].hashes).toHaveLength(2);
    const json=JSON.parse(backup(all));json.requests[0].status='PAID';json.requests[0].cursor='99999999';
    const preview=await inspectBackup(JSON.stringify(json));expect(preview.errors).toEqual([]);expect(preview.entries).toEqual(all);
    const clean=new Repository(new MemoryStorage());for(const e of preview.entries)await clean.saveRequest(e.request,e.hashes);expect(await clean.requests()).toEqual(all);
  });
  it('reports invalid entries separately without importing them',async()=>{
    const r=await signed();const p=await inspectBackup(JSON.stringify({version:1,requests:[{request:r,hashes:[]},{request:{...r,requestId:otherHash},hashes:[]}]}));expect(p.entries).toHaveLength(1);expect(p.errors).toHaveLength(1);
  });
  it('preserves damaged data and reports read/quota failures',async()=>{
    const store=new MemoryStorage();store.setItem('arc-payref:v1:request:broken','{');const repo=new Repository(store);
    await expect(repo.requests()).rejects.toMatchObject({code:'STORAGE_READ'});expect(store.length).toBe(1);
    store.setItem=()=>{throw new DOMException('full','QuotaExceededError');};await expect(repo.saveRequest(await signed())).rejects.toMatchObject({code:'STORAGE_WRITE'});
  });
  it('rejects conflicting stored content rather than overwriting it',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),r=await signed(),other=unsigned();other.message.reference='other';const s=await signed(other);
    const key=`arc-payref:v1:request:${r.domain.chainId}:${r.requestId}`;store.setItem(key,JSON.stringify({version:1,request:s,hashes:[]}));const before=store.getItem(key);
    await expect(repo.saveRequest(r)).rejects.toMatchObject({code:'IMPORT_CONFLICT'});expect(store.getItem(key)).toBe(before);
  });
  it('rejects excessive backups and unsupported versions',async()=>{
    for(const raw of ['x'.repeat(2*1024*1024+1),JSON.stringify({version:2,requests:[]}),JSON.stringify({version:1,requests:Array(1001).fill(null)})])await expect(inspectBackup(raw)).rejects.toThrow();
  });
  it('prevents spreadsheet formula execution and labels unverified exports',async()=>{
    const u=unsigned();u.message.reference='=HYPERLINK("https://example.test")';const r=await signed(u);const csv=exportCsv([{version:1,request:r,hashes:[txHash]}],{});
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');expect(csv).toContain('NOT_VERIFIED_IN_THIS_SESSION');
  });
  it('blocks concurrent same-origin operations and unsupported browser locks',async()=>{
    vi.stubGlobal('navigator',{locks:{request:vi.fn(async(_n,_o,cb)=>cb(null))}});const op=vi.fn();await expect(locked('payment',op)).rejects.toMatchObject({code:'BUSY_OTHER_TAB'});expect(op).not.toHaveBeenCalled();
    vi.stubGlobal('navigator',{});await expect(locked('payment',op)).rejects.toMatchObject({code:'LOCK_UNAVAILABLE'});
  });
});
