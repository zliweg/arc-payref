import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EvidencePanel } from '../src/evidence-panel';
import { Composer } from '../src/ui';
import { verifyEvidence } from '../src/verification';
import { evidence, otherHash, payer, signed } from './fixtures';

describe('evidence display using synthetic verified Arc payments',()=>{
  it('does not mark Memo, Transfer or payment result verified before a receipt check',async()=>{
    const request=await signed();
    const html=renderToStaticMarkup(createElement(EvidencePanel,{request,payments:[]}));
    expect(html.match(/class="evidence-step verified"/g)).toHaveLength(1);
    expect(html.match(/class="evidence-step unverified"/g)).toHaveLength(3);
    expect(html).toContain('Duplicate-payment lookup');expect(html).toContain('Not run');
  });
  it('does not attribute another request or another network payment to this request',async()=>{
    const request=await signed(),payment=verifyEvidence(request,evidence(request));
    const html=renderToStaticMarkup(createElement(EvidencePanel,{request,payments:[{...payment,requestId:otherHash},{...payment,chainId:5042}]}));
    expect(html.match(/class="evidence-step verified"/g)).toHaveLength(1);
    expect(html).not.toContain('0.01 USDC received');
  });
  it('preserves verified evidence after a failed refresh and reports lookup incompleteness separately',async()=>{
    const request=await signed(),payment=verifyEvidence(request,evidence(request));
    const html=renderToStaticMarkup(createElement(EvidencePanel,{request,payments:[payment],scan:{complete:false,fromBlock:'100',checkedThroughBlock:'101',targetBlock:'105',payments:[payment],anomalies:[],error:'Could not verify blocks 102–105.'},failure:{hash:otherHash,stage:'transaction',message:'RPC read failed.'}}));
    expect(html.match(/class="evidence-step verified"/g)).toHaveLength(4);
    expect(html).toContain('Incomplete');expect(html).toContain('Could not verify blocks 102–105.');
    expect(html).toContain('Previously verified payment evidence remains visible above.');
    expect(html).toContain('Transaction check could not confirm this transaction');
  });
  it('shows the failing evidence stage without claiming the rest of the receipt passed',async()=>{
    const request=await signed();
    const html=renderToStaticMarkup(createElement(EvidencePanel,{request,payments:[],failure:{hash:otherHash,stage:'transfer',message:'USDC transfer does not match the requested payment.'}}));
    expect(html.match(/class="evidence-step verified"/g)).toHaveLength(1);
    expect(html).toContain('USDC transfer could not confirm this transaction');
    expect(html.match(/class="evidence-step failed"/g)).toHaveLength(2);
  });
  it('shows all verified duplicates and late payments without claiming a full lookup',async()=>{
    const request=await signed(),first=verifyEvidence(request,evidence(request)),lateInput=evidence(request,otherHash);lateInput.blockTimestamp=BigInt(request.message.expiresAt);
    const html=renderToStaticMarkup(createElement(EvidencePanel,{request,payments:[first,verifyEvidence(request,lateInput)]}));
    expect(html).toContain('Duplicate payment detected');expect(html).toContain('After the deadline');
    expect(html.match(/class="evidence-payment"/g)).toHaveLength(2);
    expect(html).toContain('Not run');
  });
});

describe('reusing a request as an unsigned composer draft',()=>{
  it('copies only editable business fields while using the current receiving wallet and clearing the deadline',async()=>{
    const request=await signed();
    const html=renderToStaticMarkup(createElement(Composer,{busy:false,account:payer,chainId:5042002,records:[],initialRequest:request,onSubmit:()=>{}}));
    expect(html).toContain('value="TEST-001"');expect(html).toContain('value="0.01"');
    expect(html).toContain(request.message.description);expect(html).toMatch(/name="deadline"[^>]*value=""/);
    expect(html).toContain('0x2222…2222');expect(html).not.toContain(request.message.payee);
    expect(html).toContain('It needs a new signature and request ID.');
    expect(html).toContain('The original request and its shared link remain unchanged.');
    expect(html).not.toContain(request.signature);expect(html).not.toContain(request.requestId);
  });
});
