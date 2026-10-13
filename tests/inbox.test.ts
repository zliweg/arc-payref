// Local in-memory persistence and lock doubles only; no wallet or live chain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { MAINNET, TESTNET } from '../src/config';
import { backup, inspectBackup, Repository } from '../src/storage';
import type { Attempt } from '../src/storage';
import { MemoryStorage, otherHash, payer, signed, txHash, unsigned } from './fixtures';

const prefix='arc-payref:v1:inbox:';
const bookmarkKey=(chainId:number,id:string)=>`${prefix}${chainId}:${id.toLowerCase()}`;
beforeEach(()=>vi.stubGlobal('navigator',{locks:{request:vi.fn(async(_name:unknown,_options:unknown,callback:(lock:object)=>Promise<unknown>)=>callback({name:'test lock'}))}}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});

describe('explicit local payment inbox bookmarks',()=>{
  it('verifies and saves the full request before its bookmark, storing no claimed payment state',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    const writes=vi.spyOn(store,'setItem');
    await repo.saveToInbox(request);
    expect(await repo.requests()).toEqual([{version:1,request,hashes:[]}]);
    expect(writes.mock.calls.map(([key])=>key)).toEqual([`arc-payref:v1:request:${TESTNET}:${request.requestId}`,bookmarkKey(TESTNET,request.requestId)]);
    expect(repo.inbox()).toEqual([{version:1,chainId:TESTNET,requestId:request.requestId,savedAt:expect.any(String)}]);
    const raw=store.getItem(bookmarkKey(TESTNET,request.requestId))!;
    expect(JSON.parse(raw)).not.toHaveProperty('status');expect(raw).not.toContain('PAID');expect(raw).not.toContain(request.signature);expect(raw).not.toContain(request.message.reference);
  });
  it('ordinary request saves and imported requests do not create inbox bookmarks',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    await repo.saveRequest(request,[txHash]);
    expect(repo.inbox()).toEqual([]);
    const preview=await inspectBackup(backup(await repo.requests())),clean=new Repository(new MemoryStorage());
    for(const entry of preview.entries)await clean.saveRequest(entry.request,entry.hashes);
    expect(clean.inbox()).toEqual([]);
  });
  it('rejects altered requests before writing either the request or bookmark',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    await expect(repo.saveToInbox({...request,message:{...request.message,amount:'1'}})).rejects.toMatchObject({code:'HASH_MISMATCH'});
    expect(store.length).toBe(0);
  });
  it('does not write a bookmark or claim a saved request after request persistence fails',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    vi.spyOn(store,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
    await expect(repo.saveToInbox(request)).rejects.toMatchObject({code:'STORAGE_WRITE'});
    expect(repo.inbox()).toEqual([]);
  });
  it('reports partial success when bookmark persistence fails and preserves the saved request',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed(),write=store.setItem.bind(store);
    vi.spyOn(store,'setItem').mockImplementation((key,value)=>{if(key.startsWith(prefix))throw new DOMException('full','QuotaExceededError');write(key,value);});
    await expect(repo.saveToInbox(request)).rejects.toMatchObject({code:'INBOX_SAVE_FAILED',message:expect.stringContaining('signed request was saved locally'),cause:{code:'STORAGE_WRITE'}});
    expect(await repo.requests()).toHaveLength(1);expect(repo.inbox()).toEqual([]);
  });
  it('is idempotent for existing bookmarks and keeps all existing request hashes',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    await repo.saveRequest(request,[txHash,otherHash]);await repo.saveToInbox(request);
    const before=store.getItem(bookmarkKey(TESTNET,request.requestId));
    await repo.saveToInbox(request);
    expect(repo.inbox()).toHaveLength(1);expect(store.getItem(bookmarkKey(TESTNET,request.requestId))).toBe(before);
    expect((await repo.requests())[0].hashes).toEqual([txHash,otherHash]);
  });
  it('keeps bookmarks network-scoped and can re-add a removed bookmark without deleting request evidence',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed(),main=await signed(unsigned(MAINNET));
    await repo.saveRequest(request,[txHash]);await repo.saveToInbox(request);await repo.saveToInbox(main);
    const attempt:Attempt={version:1,id:'inbox-test',requestId:request.requestId,chainId:TESTNET,payer,status:'UNKNOWN',hash:txHash,nonce:1,updatedAt:new Date().toISOString()};
    repo.saveAttempt(attempt);
    const requests=await repo.requests(),attempts=repo.attempts();
    await repo.removeFromInbox(TESTNET,request.requestId);
    expect(repo.inbox().map(entry=>entry.chainId)).toEqual([MAINNET]);
    expect(await repo.requests()).toEqual(requests);expect(repo.attempts()).toEqual(attempts);
    await repo.saveToInbox(request);
    expect(repo.inbox()).toHaveLength(2);expect(await repo.requests()).toEqual(requests);expect(repo.attempts()).toEqual(attempts);
  });
  it('does not pretend a failed removal succeeded',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();await repo.saveToInbox(request);
    vi.spyOn(store,'removeItem').mockImplementation(()=>{throw new DOMException('blocked','SecurityError');});
    await expect(repo.removeFromInbox(TESTNET,request.requestId)).rejects.toMatchObject({code:'INBOX_REMOVE_FAILED'});
    expect(repo.inbox()).toHaveLength(1);expect(await repo.requests()).toHaveLength(1);
  });
  it.each(['broken JSON','claimed PAID','mismatched key','bad timestamp'] as const)('isolates %s metadata damage without clearing or hiding saved requests',async(kind)=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();await repo.saveToInbox(request);
    const key=bookmarkKey(TESTNET,request.requestId),raw=JSON.parse(store.getItem(key)!);
    if(kind==='broken JSON')store.setItem(key,'{');
    else if(kind==='claimed PAID')store.setItem(key,JSON.stringify({...raw,status:'PAID'}));
    else if(kind==='mismatched key')store.setItem(key,JSON.stringify({...raw,requestId:otherHash}));
    else store.setItem(key,JSON.stringify({...raw,savedAt:'not-a-date'}));
    const damaged=store.getItem(key);
    expect(()=>repo.inbox()).toThrow(expect.objectContaining({code:'INBOX_READ'}));
    await expect(repo.saveToInbox(request)).rejects.toMatchObject({code:'INBOX_SAVE_FAILED',cause:{code:'INBOX_READ'}});
    await expect(repo.removeFromInbox(TESTNET,request.requestId)).rejects.toMatchObject({code:'INBOX_READ'});
    expect(store.getItem(key)).toBe(damaged);expect(await repo.requests()).toHaveLength(1);
  });
  it('enforces 1,000 bookmarks before adding another without losing the saved request',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    for(let i=1;i<=1000;i++) {
      const requestId=`0x${i.toString(16).padStart(64,'0')}` as Hex;
      store.setItem(bookmarkKey(TESTNET,requestId),JSON.stringify({version:1,chainId:TESTNET,requestId,savedAt:'2026-09-21T00:00:00.000Z'}));
    }
    expect(repo.inbox()).toHaveLength(1000);
    await expect(repo.saveToInbox(request)).rejects.toMatchObject({code:'INBOX_SAVE_FAILED',cause:{code:'INBOX_LIMIT'}});
    expect(repo.inbox()).toHaveLength(1000);expect(await repo.requests()).toHaveLength(1);
  });
  it('blocks competing tabs instead of overwriting bookmark changes',async()=>{
    const store=new MemoryStorage(),repo=new Repository(store),request=await signed();
    vi.stubGlobal('navigator',{locks:{request:vi.fn(async(_name:unknown,_options:unknown,callback:(lock:null)=>Promise<unknown>)=>callback(null))}});
    await expect(repo.saveToInbox(request)).rejects.toMatchObject({code:'INBOX_SAVE_FAILED',cause:{code:'BUSY_OTHER_TAB'}});
    expect(repo.inbox()).toEqual([]);expect(await repo.requests()).toHaveLength(1);
  });
});
