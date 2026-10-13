import { useEffect, useRef, useState } from 'react';
import type { ScanResult } from './chain';
import { network } from './config';
import { requestState } from './dashboard';
import { errorText } from './errors';
import { requestLink } from './protocol';
import type { SignedRequest } from './protocol';
import { browserRepository } from './storage';
import type { Attempt, InboxBookmark, StoredRequest } from './storage';
import { Badge, dateLabel, Empty, money } from './ui';
import { mergePayments } from './verification';
import type { VerifiedPayment } from './verification';

function useInbox() {
  const [state,setState]=useState<{loaded:boolean;entries:InboxBookmark[];error?:string}>({loaded:false,entries:[]});
  useEffect(()=>{
    const refresh=()=>{
      try { setState({loaded:true,entries:browserRepository().inbox()}); }
      catch(error) { setState({loaded:true,entries:[],error:errorText(error)}); }
    };
    refresh();
    window.addEventListener('storage',refresh);window.addEventListener('payref-storage',refresh);
    return ()=>{window.removeEventListener('storage',refresh);window.removeEventListener('payref-storage',refresh);};
  },[]);
  return state;
}

export function SaveToInboxButton({request}:{request:SignedRequest}) {
  const inbox=useInbox();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setBusy(false);setMessage('');setError('');return ()=>{generation.current++;};},[request.domain.chainId,request.requestId]);
  const saved=inbox.entries.some(entry=>entry.chainId===request.domain.chainId&&entry.requestId===request.requestId.toLowerCase());
  const save=async()=>{
    const current=generation.current;
    setBusy(true);setError('');setMessage('');
    try {
      await browserRepository().saveToInbox(request);
      if(current===generation.current) setMessage('Saved in this browser’s payment inbox. No payment was made.');
    } catch(cause) { if(current===generation.current)setError(errorText(cause)); }
    finally { if(current===generation.current)setBusy(false); }
  };
  return <div className="save-to-inbox"><button type="button" className="secondary" disabled={busy||!inbox.loaded||!!inbox.error||saved} onClick={()=>void save()}>{busy?'Saving…':saved?'Saved in payment inbox':'Save to payment inbox'}</button>
    {saved&&<a className="text-link" href="/inbox">Open payment inbox</a>}
    {message&&<p role="status">{message}</p>}{(error||inbox.error)&&<p className="inline-warning" role="alert">{error||inbox.error}</p>}
  </div>;
}

export interface PaymentInboxProps {
  chainId:number; requests:StoredRequest[]; payments:Record<string,VerifiedPayment[]>;
  scans:Record<string,ScanResult>; attempts:Attempt[];
}
export function PaymentInbox({chainId,requests,payments,scans,attempts}:PaymentInboxProps) {
  const inbox=useInbox();
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setBusy('');setError('');setNotice('');return ()=>{generation.current++;};},[chainId]);
  const entries=inbox.entries.filter(entry=>entry.chainId===chainId);
  const known=new Map(requests.filter(entry=>entry.request.domain.chainId===chainId).map(entry=>[entry.request.requestId.toLowerCase(),entry]));
  const now=BigInt(Math.floor(Date.now()/1000));
  const remove=async(entry:InboxBookmark)=>{
    const current=generation.current;
    setBusy(entry.requestId);setError('');setNotice('');
    try {
      await browserRepository().removeFromInbox(entry.chainId,entry.requestId);
      if(current===generation.current)setNotice('Bookmark removed. The signed request, transaction hashes and payment attempts remain saved. You can add the request again from its payment page.');
    } catch(cause) { if(current===generation.current)setError(errorText(cause)); }
    finally { if(current===generation.current)setBusy(''); }
  };
  return <section className="payment-inbox panel" aria-label="Payment inbox">
    <div className="panel-title"><div><h2>Payment inbox</h2><p>Requests you explicitly saved to review or pay later on {network(chainId).name}.</p></div></div>
    <p className="evidence-boundary">Saved only in this browser. This is not cloud sync or your wallet’s complete payment history. A bookmark is not proof of payment; badges use this session’s verification and local unresolved attempts.</p>
    {(inbox.error||error)&&<p role="alert" className="inline-warning">{error||inbox.error}</p>}{notice&&<p role="status">{notice}</p>}
    {!inbox.loaded?<Empty title="Loading payment inbox">Reading your local bookmarks.</Empty>:inbox.error?<Empty title="Payment inbox unavailable">Existing requests and payment records are unaffected. The damaged bookmark data has not been cleared.</Empty>:!entries.length?<Empty title="No saved payment requests">Open a signed payment link and choose “Save to payment inbox” to keep it here before paying. No wallet connection is needed.</Empty>:<div className="inbox-items">{entries.map(entry=>{
      const stored=known.get(entry.requestId),request=stored?.request;
      if(!request)return <article className="evidence-payment" key={entry.requestId}><h3>Signed request unavailable</h3><p>This bookmark has no currently loaded signed request. Restore the original link or JSON backup before reviewing payment.</p><p className="address">{entry.requestId}</p><button type="button" className="secondary" disabled={!!busy} onClick={()=>void remove(entry)}>Remove bookmark</button></article>;
      const verified=mergePayments(payments[request.requestId]??[]).filter(payment=>payment.chainId===chainId&&payment.requestId.toLowerCase()===entry.requestId);
      const scan=scans[request.requestId];
      return <article className="evidence-payment" key={entry.requestId}><div><h3>{request.message.reference}</h3><Badge state={requestState(request,verified,scan,attempts,now)}/></div>
        {request.message.description&&<p>{request.message.description}</p>}<dl><dt>Requested amount</dt><dd>{money(request.message.amount)} USDC</dd><dt>Pay to</dt><dd className="address">{request.message.payee}</dd><dt>Deadline</dt><dd>{dateLabel(request.message.expiresAt)}</dd><dt>Request ID</dt><dd className="address">{request.requestId}</dd></dl>
        {scan&&<p>{scan.complete?`Lookup complete through block ${scan.checkedThroughBlock??scan.targetBlock}.`:'Lookup incomplete; do not assume this request is unpaid.'}</p>}
        <div className="actions"><a className="button" href={requestLink(request,'')}>Review payment request</a><button type="button" className="secondary" disabled={!!busy} onClick={()=>void remove(entry)}>{busy===entry.requestId?'Removing…':'Remove bookmark'}</button></div>
      </article>;
    })}</div>}
  </section>;
}
