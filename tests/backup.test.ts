import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { MAINNET, TESTNET } from '../src/config';
import { Repository, backup, inspectBackup, type StoredRequest } from '../src/storage';
import { MemoryStorage, otherHash, signed, txHash, unsigned } from './fixtures';

const exportKey='arc-payref:v1:exports';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('local JSON download history (not proof of a saved file)',()=>{
  it('distinguishes never downloaded requests from changed hash sets',async()=>{
    const repo=new Repository(new MemoryStorage()),req=await signed();
    await repo.saveRequest(req);
    expect(repo.exportStatus(await repo.requests())).toEqual({neverExported:1,changed:0});
    repo.recordExport(await repo.requests());
    expect(repo.exportStatus(await repo.requests())).toMatchObject({neverExported:0,changed:0,lastExportedAt:expect.any(String)});
    await repo.saveRequest(req,[txHash]);
    expect(repo.exportStatus(await repo.requests())).toMatchObject({neverExported:0,changed:1});
    repo.recordExport(await repo.requests());
    expect(repo.exportStatus(await repo.requests())).toMatchObject({neverExported:0,changed:0});
  });

  it('marks single downloads independently and full downloads together, scoped by network',async()=>{
    vi.useFakeTimers();
    const storage=new MemoryStorage(),repo=new Repository(storage);
    await repo.saveRequest(await signed());
    await repo.saveRequest(await signed(unsigned(MAINNET)));
    const all=await repo.requests(),testnet=all.filter(entry=>entry.request.domain.chainId===TESTNET),mainnet=all.filter(entry=>entry.request.domain.chainId===MAINNET);
    vi.setSystemTime(new Date('2026-09-21T01:00:00.000Z'));
    repo.recordExport(testnet);
    expect(repo.exportStatus(all)).toMatchObject({neverExported:1,changed:0});
    expect(repo.exportStatus(testnet)).toEqual({neverExported:0,changed:0,lastExportedAt:'2026-09-21T01:00:00.000Z'});
    expect(repo.exportStatus(mainnet)).toEqual({neverExported:1,changed:0});
    vi.setSystemTime(new Date('2026-09-21T02:00:00.000Z'));
    repo.recordExport(all);
    expect(new Repository(storage).exportStatus(all)).toEqual({neverExported:0,changed:0,lastExportedAt:'2026-09-21T02:00:00.000Z'});
    expect(repo.exportStatus([])).toEqual({neverExported:0,changed:0});
  });

  it('does not trust imported download claims, while identical reimports preserve local history',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),req=await signed();
    await repo.saveRequest(req,[txHash]);
    repo.recordExport(await repo.requests());
    const history=storage.getItem(exportKey),raw=JSON.parse(backup(await repo.requests()));
    expect(raw).not.toHaveProperty('exports');
    raw.exports=JSON.parse(history!);
    raw.requests[0].exportedAt='2026-09-21T12:00:00.000Z';
    const preview=await inspectBackup(JSON.stringify(raw));
    const clean=new Repository(new MemoryStorage());
    for(const entry of preview.entries) {
      await repo.saveRequest(entry.request,entry.hashes);
      await clean.saveRequest(entry.request,entry.hashes);
    }
    expect(storage.getItem(exportKey)).toBe(history);
    expect(repo.exportStatus(await repo.requests())).toMatchObject({neverExported:0,changed:0});
    expect(clean.exportStatus(await clean.requests())).toEqual({neverExported:1,changed:0});
  });

  it('marks the exact downloaded snapshot even if a new hash was saved before tracking it',async()=>{
    const repo=new Repository(new MemoryStorage()),req=await signed();
    await repo.saveRequest(req);
    const downloaded=await repo.requests();
    await repo.saveRequest(req,[txHash]);
    repo.recordExport(downloaded);
    expect(repo.exportStatus(await repo.requests())).toMatchObject({neverExported:0,changed:1});
    expect(repo.exportStatus(downloaded)).toMatchObject({neverExported:0,changed:0});
  });

  it('normalizes hash order, duplicates and case and stores no business text or signature',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),req=await signed();
    const downloaded: StoredRequest={version:1,request:req,hashes:[txHash,otherHash]};
    repo.recordExport([downloaded]);
    const mixedCase=`0x${txHash.slice(2).toUpperCase()}` as Hex;
    expect(repo.exportStatus([{...downloaded,hashes:[otherHash,mixedCase,txHash]}])).toMatchObject({neverExported:0,changed:0});
    const history=storage.getItem(exportKey)!;
    for(const privateContent of [req.message.reference,req.message.description,req.signature,txHash,otherHash]) expect(history).not.toContain(privateContent);
    expect(history).toContain(req.requestId);
  });

  it('keeps damaged history separate from valid requests and never silently rewrites it',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),req=await signed();
    await repo.saveRequest(req);
    storage.setItem(exportKey,'{');
    expect(repo.exportStatus(await repo.requests())).toMatchObject({error:expect.stringContaining('history is unavailable')});
    expect(await repo.requests()).toHaveLength(1);
    expect(()=>repo.recordExport([{version:1,request:req,hashes:[]}])).toThrow();
    expect(storage.getItem(exportKey)).toBe('{');
    expect(await repo.requests()).toHaveLength(1);
  });

  it('reports malformed or unreadable download history without claiming it is current',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),record: StoredRequest={version:1,request:await signed(),hashes:[]};
    repo.recordExport([record]);
    const valid=JSON.parse(storage.getItem(exportKey)!);
    for(const invalid of [{version:2,entries:[]},{version:1,entries:[{...valid.entries[0],fingerprint:'bad'}]},{version:1,entries:[{...valid.entries[0],exportedAt:'bad'}]},{version:1,entries:[valid.entries[0],valid.entries[0]]}]) {
      storage.setItem(exportKey,JSON.stringify(invalid));
      expect(repo.exportStatus([record]).error).toBeDefined();
      expect(()=>repo.recordExport([record])).toThrow();
    }
    vi.spyOn(storage,'getItem').mockImplementation(()=>{throw new DOMException('blocked','SecurityError');});
    expect(repo.exportStatus([record]).error).toBeDefined();
  });

  it('throws on history write failure while retaining previous history and requests',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),req=await signed();
    await repo.saveRequest(req);
    repo.recordExport(await repo.requests());
    await repo.saveRequest(req,[txHash]);
    const records=await repo.requests(),before=storage.getItem(exportKey);
    vi.spyOn(storage,'setItem').mockImplementationOnce(()=>{throw new DOMException('full','QuotaExceededError');});
    expect(()=>repo.recordExport(records)).toThrow(expect.objectContaining({code:'EXPORT_HISTORY_WRITE',cause:expect.objectContaining({code:'STORAGE_WRITE'})}));
    expect(storage.getItem(exportKey)).toBe(before);
    expect(await repo.requests()).toEqual(records);
    expect(repo.exportStatus(records)).toMatchObject({neverExported:0,changed:1});
  });

  it('bounds history at 1,000 records and rejects conflicting snapshot entries without changes',async()=>{
    const storage=new MemoryStorage(),repo=new Repository(storage),entry: StoredRequest={version:1,request:await signed(),hashes:[]};
    repo.recordExport([entry]);
    const before=storage.getItem(exportKey);
    expect(()=>repo.recordExport(Array(1001).fill(entry))).toThrow(expect.objectContaining({code:'EXPORT_HISTORY_LIMIT'}));
    expect(()=>repo.recordExport([entry,{...entry,hashes:[txHash]}])).toThrow(expect.objectContaining({code:'EXPORT_SNAPSHOT_CONFLICT'}));
    expect(storage.getItem(exportKey)).toBe(before);
    const example=JSON.parse(before!).entries[0];
    storage.setItem(exportKey,JSON.stringify({version:1,entries:Array.from({length:1000},(_,i)=>({...example,requestId:`0x${(i+1).toString(16).padStart(64,'0')}`}))}));
    const full=storage.getItem(exportKey);
    expect(()=>repo.recordExport([entry])).toThrow(expect.objectContaining({code:'EXPORT_HISTORY_LIMIT'}));
    expect(storage.getItem(exportKey)).toBe(full);
  });
});
