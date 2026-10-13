import type { ReactNode } from 'react';
import type { SignedRequest } from './protocol';
import type { VerifiedPayment } from './verification';
import type { ScanResult } from './chain';
import { MEMO, USDC, network } from './config';
import { Icon, money } from './ui';

export interface EvidenceFailure { hash: string; stage: string; message: string }
export interface EvidencePanelProps {
  request: SignedRequest;
  payments: VerifiedPayment[];
  scan?: ScanResult;
  failure?: EvidenceFailure;
}
type StepState = 'verified' | 'unverified' | 'failed';

function EvidenceStep({title,state,children}:{title:string;state:StepState;children:ReactNode}) {
  return <li className={`evidence-step ${state}`}>
    <span className="evidence-step-icon"><Icon name={state==='verified'?'check':state==='failed'?'close':'clock'} size={15}/></span>
    <div><div className="evidence-step-heading"><h4>{title}</h4><span>{state==='verified'?'Verified':state==='failed'?'Needs review':'Not verified'}</span></div>{children}</div>
  </li>;
}

// The caller supplies signed requests and payments already accepted by the shared
// verifier. This panel explains those results; it never infers payment from a hash.
export function EvidencePanel({request,payments,scan,failure}:EvidencePanelProps) {
  const matches=payments.filter(p=>p.chainId===request.domain.chainId&&p.requestId.toLowerCase()===request.requestId.toLowerCase());
  const hasPayment=matches.length>0;
  const stageState=(stage:string):StepState=>hasPayment?'verified':failure?.stage===stage?'failed':'unverified';
  const resultState:StepState=hasPayment?'verified':failure?'failed':'unverified';
  const failureLabels:Record<string,string>={network:'Network check',transaction:'Transaction check',receipt:'Receipt check',memo:'Memo binding',transfer:'USDC transfer',block:'Block lookup',sender:'Sender check'};

  return <section className="evidence-panel" aria-label="Payment evidence">
    <div className="evidence-heading"><div><p className="eyebrow">FOLLOW THE EVIDENCE</p><h3>From the request to the transfer</h3></div><Icon name="shield" size={23}/></div>
    <p className="evidence-intro">Each verified payment must match the signed request and the actual USDC transfer. A transaction hash alone is not proof of payment.</p>
    <ol className="evidence-steps">
      <EvidenceStep title="1. Signed request" state="verified"><p>The receiving wallet signed {money(request.message.amount)} USDC for <strong>{request.message.reference}</strong> on {network(request.domain.chainId).name}.</p><dl><dt>Receiving wallet</dt><dd className="address">{request.message.payee}</dd><dt>Request ID</dt><dd className="address">{request.requestId}</dd></dl></EvidenceStep>
      <EvidenceStep title="2. Arc Memo binding" state={stageState('memo')}><p>{hasPayment?'The direct Memo call and its event pair match this request ID, the sender, the USDC call and the PayRef protocol marker.':'A receipt must be checked before its Memo events can be matched to this request.'}</p><details><summary>Expected Memo contract</summary><p className="address">{MEMO}</p></details></EvidenceStep>
      <EvidenceStep title="3. Actual USDC transfer" state={stageState('transfer')}><p>{hasPayment?`The ERC-20 Transfer matches the payer, this receiving wallet and exactly ${money(request.message.amount)} USDC.`:'The actual USDC sender, recipient and amount have not yet been verified.'}</p><details><summary>Expected USDC contract</summary><p className="address">{USDC}</p><p>Only the 6-decimal ERC-20 amount counts as the payment. The native system event is not counted a second time.</p></details></EvidenceStep>
      <EvidenceStep title="4. Payment result" state={resultState}><p>{hasPayment?`${matches.length} matching payment${matches.length===1?'':'s'} verified from included, successful transactions.`:'No matching payment has been verified in this session.'}</p></EvidenceStep>
    </ol>

    {matches.length>1&&<div className="evidence-warning"><strong>Duplicate payment detected</strong><p>{matches.length} verified payments match this same request. Review them with the payer; no refund is initiated by PayRef.</p></div>}
    {matches.map(p=><article className="evidence-payment" key={`${p.chainId}:${p.hash}:${p.logIndex}`}><div><strong>{money(p.amount)} USDC received</strong>{p.late&&<span className="evidence-late">After the deadline</span>}</div><dl><dt>Actual payer</dt><dd className="address">{p.payer}</dd><dt>Actual recipient</dt><dd className="address">{p.payee}</dd><dt>Requested / received</dt><dd>{money(request.message.amount)} / {money(p.amount)} USDC</dd></dl><a className="address" href={`${network(request.domain.chainId).blockExplorers.default.url}/tx/${p.hash}`} target="_blank" rel="noreferrer">{p.hash} ↗</a></article>)}

    <div className={`evidence-coverage ${scan?.complete?'complete':'incomplete'}`}><div><Icon name={scan?.complete?'check':'clock'} size={16}/><strong>Duplicate-payment lookup</strong><span>{scan?.complete?'Complete for this range':scan?'Incomplete':'Not run'}</span></div>{scan?<p>Requested range: blocks {scan.fromBlock}–{scan.targetBlock}. {scan.checkedThroughBlock?`Checked through block ${scan.checkedThroughBlock}.`:'No complete segment recorded.'} {scan.complete?'This result covers the stated range, not future payments.':'The remaining range must be checked before ruling out another payment.'}</p>:<p>A matching receipt proves that payment occurred. Checking the full request range is still needed to look for other payments.</p>}{scan?.error&&<p className="evidence-error">{scan.error}</p>}{!!scan?.anomalies.length&&<p className="evidence-error">{scan.anomalies.length} unmatched Memo record(s) need review in the technical details. They do not replace verified payments.</p>}</div>
    {failure&&<div className="evidence-failure" role="note"><strong>Latest check: {failureLabels[failure.stage]??'Verification'} could not confirm this transaction</strong><p>{failure.message}</p>{failure.hash&&<p className="address">{failure.hash}</p>}{hasPayment&&<p>Previously verified payment evidence remains visible above.</p>}</div>}
    <p className="evidence-boundary">A signature shows what a wallet signed. This evidence does not establish identity or confirm that a service was delivered.</p>
  </section>;
}
