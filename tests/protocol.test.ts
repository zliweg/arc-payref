import { describe, expect, it } from 'vitest';
import { decodeFunctionData, maxUint256 } from 'viem';
import { MEMO, USDC, memoAbi } from '../src/config';
import { createRequest, decodeRequest, encodeRequest, expired, parseAmount, parseUnsigned, paymentData, requestHash, requestLink, verifyRequest } from '../src/protocol';
import { mainnetUnsigned, payer, payee, signed, unsigned } from './fixtures';

describe('EIP-712 protocol (public test credentials; no network)',()=>{
  it('recovers the signer and round-trips UTF-8 through a fragment link',async()=>{
    const r=unsigned();r.message.reference='DEVELOPMENT-001';r.message.description='Project fee: €1';const s=await signed(r);
    expect(await decodeRequest(encodeRequest(s))).toEqual(s);
    const link=new URL(requestLink(s,'https://payref.example'));
    expect(link.search).toBe('');expect(link.pathname).toBe('/pay');expect(link.hash).toContain('request=');
  });
  it('fixes domain and field ordering in a stable vector',async()=>{
    const s=await signed();
    // Independently reproduced with Foundry cast wallet sign --data (public key 1).
    expect(s.requestId).toMatchInlineSnapshot(`"0x39e2732029beb632422af78e8c92a7c0d9e32396f68d3d5f6bd4ef46777434f4"`);
    expect(s.signature).toMatchInlineSnapshot(`"0x6ff4d9b6c531b87aa24b8bd5fa63d156ee438483d2dfd5d59f4b62aa64df6c63343990a44adccead474dd6a05f23d72c8ffdf7c9e03523bd2dc5ece9414a0a211b"`);
    expect(requestHash(mainnetUnsigned())).not.toBe(s.requestId);
  });
  it.each(['payee','token','memoContract','amount','reference','description','expiresAt','nonce','createdAtBlock'] as const)('rejects tampered %s even with a recomputed ID',async field=>{
    const s=await signed();
    const replacements={payee:payer,token:payer,memoContract:payer,amount:'20000',reference:'OTHER',description:'changed',expiresAt:'0',nonce:`0x${'22'.repeat(32)}`,createdAtBlock:'99'};
    const altered={...s,message:{...s.message,[field]:replacements[field]}};
    altered.requestId=requestHash(altered);
    await expect(verifyRequest(altered)).rejects.toThrow();
  });
  it('rejects transplanted signatures, extra fields, version and unknown network',async()=>{
    const s=await signed();const transplanted={...s,...mainnetUnsigned()};transplanted.requestId=requestHash(transplanted);
    await expect(verifyRequest(transplanted)).rejects.toThrow();
    for(const value of [{...s,schemaVersion:2},{...s,rpc:'https://evil.test'},{...s,domain:{...s.domain,chainId:1}},{...s,domain:{...s.domain,verifyingContract:MEMO}}]) await expect(verifyRequest(value)).rejects.toThrow();
  });
  it('keeps expired signatures verifiable and marks deadline equality as expired',async()=>{
    const s=await signed();expect(await verifyRequest(s)).toEqual(s);
    expect(expired(s,1999999999n)).toBe(false);expect(expired(s,2000000000n)).toBe(true);
    expect(expired({...s,message:{...s.message,expiresAt:'0'}},9999999999n)).toBe(false);
  });
  it('encodes only the allowed Memo and transfer call',async()=>{
    const s=await signed();const decoded=decodeFunctionData({abi:memoAbi,data:paymentData(s)});
    expect(decoded.functionName).toBe('memo');expect(decoded.args?.[0]).toBe(USDC);expect(decoded.args?.[2]).toBe(s.requestId);
    expect(String(decoded.args?.[1]).slice(0,10)).toBe('0xa9059cbb');
  });
  it('generates independent cryptographic nonces and normalizes text before signing',()=>{
    const input={chainId:5042002,payee:payee.address,amount:'0.01',reference:' e\u0301 ',description:'',expiresAt:'0',block:100n};
    const a=createRequest(input),b=createRequest(input);expect(a.message.reference).toBe('é');expect(a.message.nonce).not.toBe(b.message.nonce);
  });
  it.each(['0','-1','1e6','1.0000001','01',' 1','1.','+1','NaN','9'.repeat(90)])('rejects unsafe amount %s',value=>expect(()=>parseAmount(value)).toThrow());
  it('preserves six-decimal precision and uint256 bounds',()=>{
    expect(parseAmount('0.000001')).toBe('1');expect(parseAmount('12345678901234567890.123456')).toBe('12345678901234567890123456');
    const r=unsigned();r.message.amount=maxUint256.toString();expect(parseUnsigned(r)).toEqual(r);
    r.message.amount=(maxUint256+1n).toString();expect(()=>parseUnsigned(r)).toThrow();
  });
  it('rejects oversized, malformed and noncanonical fields',async()=>{
    for(const reference of ['a'.repeat(129),'€'.repeat(43),' x','x\n','e\u0301'])expect(()=>parseUnsigned({...unsigned(),message:{...unsigned().message,reference}})).toThrow();
    await expect(decodeRequest('x'.repeat(21847))).rejects.toThrow();await expect(decodeRequest('%%%')).rejects.toThrow();
    await expect(decodeRequest(btoa('{"schemaVersion":1}'))).rejects.toThrow();
  });
});
