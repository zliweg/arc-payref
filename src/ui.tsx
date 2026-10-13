import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { network } from './config';
import { parseAmount } from './protocol';
import type { SignedRequest } from './protocol';
import type { StoredRequest } from './storage';
import type { RequestState } from './dashboard';
import { stateLabels } from './dashboard';
import { parseLocalDeadline } from './datetime';

export type IconName='grid'|'list'|'receipt'|'archive'|'arrow'|'plus'|'search'|'wallet'|'check'|'clock'|'download'|'refresh'|'shield'|'close'|'activity'|'link';
const paths:Record<IconName,ReactNode>={
  grid:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  list:<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
  receipt:<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 7h6M9 11h6M9 15h3"/></>,
  archive:<><path d="M4 8v12h16V8M9 12h6"/><rect x="3" y="3" width="18" height="5" rx="1"/></>,
  arrow:<path d="M5 12h14m-6-6 6 6-6 6"/>,plus:<path d="M12 5v14M5 12h14"/>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  wallet:<><path d="M19 7V4H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6M20 12h-5v4h5"/></>,
  check:<path d="m5 12 4 4L19 6"/>,clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  refresh:<><path d="M20 9a8 8 0 0 0-14-3L3 9m0-6v6h6M4 15a8 8 0 0 0 14 3l3-3m0 6v-6h-6"/></>,
  shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  close:<path d="m6 6 12 12M6 18 18 6"/>,activity:<path d="M2 12h5l3-8 4 16 3-8h5"/>,
  link:<><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0)"/></>,
};
export function Icon({name,size=18}:{name:IconName;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;}
export const short=(s:string)=>`${s.slice(0,6)}…${s.slice(-4)}`;
export function money(value:string|bigint){const [whole,part]=formatUnits(BigInt(value),6).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(part?'.'+part:'.00');}
export const dateLabel=(seconds:string)=>seconds==='0'?'No deadline':new Date(Number(seconds)*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
export function Badge({state}:{state:RequestState}){return <span className={`badge ${state}`}><i/>{stateLabels[state]}</span>;}
export function Empty({icon='receipt',title,children,action}:{icon?:IconName;title:string;children:ReactNode;action?:ReactNode}){return <div className="empty"><div className="empty-icon"><Icon name={icon} size={28}/></div><h3>{title}</h3><p>{children}</p>{action&&<div className="actions">{action}</div>}</div>;}

export function Composer({busy,account,chainId,records,onSubmit,initialRequest,businessDraft}:{busy:boolean;account:Address|undefined;chainId:number;records:StoredRequest[];onSubmit:(event:FormEvent<HTMLFormElement>)=>void;initialRequest?:SignedRequest;businessDraft?:{reference:string;amount:string}}) {
  const [reference,setReference]=useState(()=>businessDraft?.reference??initialRequest?.message.reference??''),[amount,setAmount]=useState(()=>businessDraft?formatUnits(BigInt(businessDraft.amount),6):initialRequest?formatUnits(BigInt(initialRequest.message.amount),6):''),[description,setDescription]=useState(()=>initialRequest?.message.description??''),[deadline,setDeadline]=useState('');
  const duplicate=reference.trim() && records.some(r=>r.request.domain.chainId===chainId&&r.request.message.payee===account&&r.request.message.reference===reference.normalize('NFC').trim());
  let amountLabel='0.00',amountError='';if(amount){try{amountLabel=money(parseAmount(amount));}catch{amountError='Enter a positive amount with up to 6 decimal places.';}}
  let deadlineSeconds=0,deadlineError='';try{deadlineSeconds=parseLocalDeadline(deadline);}catch{deadlineError='Enter a valid local date and time as YYYY-MM-DD HH:mm.';}
  const presets=[{name:'Project milestone',reference:'PROJECT-001',description:'Project delivery — first milestone'},{name:'Consulting session',reference:'SESSION-001',description:'Consulting services'},{name:'Service fee',reference:'SERVICE-001',description:'Professional services'}];
  return <div className="composer-grid"><form className="panel form-panel" noValidate onSubmit={onSubmit}>
    <div className="panel-title"><span className="step-number">01</span><div><h2>Set the details</h2><p>A clear reference makes every payment traceable.</p></div></div>
    {initialRequest&&<div className="reuse-notice" role="note"><Icon name="receipt"/><div><strong>New request from {initialRequest.message.reference}</strong><p>Only the reference, amount and description were copied. Choose a new deadline if needed. Your currently connected wallet will receive the payment.</p><p>This is an unsigned draft. It needs a new signature and request ID. The original request and its shared link remain unchanged.</p></div></div>}
    {businessDraft&&<div className="reuse-notice" role="note"><Icon name="list"/><div><strong>From your business receivable</strong><p>The reference and amount were copied. Customer labels and private business notes stay in your workspace. Review the details, then sign with the receiving wallet.</p><p>This will create and link a new request. Changing the amount or reference will remain visible as a business difference.</p></div></div>}
    <label>Start with a template <span className="optional">optional</span><select aria-label="Request template" defaultValue="" disabled={busy} onChange={e=>{const preset=presets.find(p=>p.name===e.target.value);if(preset){setReference(preset.reference);setDescription(preset.description);}}}><option value="">Custom request</option>{presets.map(p=><option key={p.name}>{p.name}</option>)}</select></label>
    <label>Business reference<input name="reference" value={reference} onChange={e=>setReference(e.target.value)} required maxLength={128} placeholder="e.g. WEBSITE-001" disabled={busy}/><span className="field-help">A project, order or service identifier. Visible to anyone with the link.</span></label>
    {duplicate&&<p className="inline-warning">This reference is already used in your saved requests. Signing creates a separate request with a new ID.</p>}
    <label>Amount in USDC<div className="currency-input"><input name="amount" required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" disabled={busy}/><span>USDC</span></div>{amountError&&<span className="field-error">{amountError}</span>}</label>
    <label>What is this payment for? <span className="optional">optional</span><textarea name="description" value={description} onChange={e=>setDescription(e.target.value)} maxLength={512} placeholder="Describe the service or deliverable" rows={3} disabled={busy}/></label>
    <label>Payment deadline <span className="optional">optional</span><input name="deadline" type="text" placeholder="YYYY-MM-DD HH:mm" maxLength={16} autoComplete="off" spellCheck={false} value={deadline} onChange={e=>setDeadline(e.target.value)} disabled={busy} aria-invalid={!!deadlineError} aria-describedby="deadline-help"/><span id="deadline-help" className="field-help">Local time, 24-hour format. Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>{deadlineError&&<span className="field-error">{deadlineError}</span>}</label>
    <div className="form-bottom"><p><Icon name="shield"/>Signing this request does not move funds or cost gas.</p><button type="submit" disabled={busy||!account||!!amountError||!!deadlineError||!amount||!reference.trim()}>Sign & create request <Icon name="arrow"/></button>{!account&&<small>Connect the receiving wallet using the button above.</small>}</div>
  </form><aside className="composer-preview"><p className="eyebrow">YOUR CUSTOMER WILL SEE</p><div className="invoice-preview"><div className="invoice-top"><span className="brand-mark">p<span>↗</span></span><span className="badge neutral">Unsigned preview</span></div><p className="eyebrow">PAYMENT REQUEST</p><h2>{reference||'Your business reference'}</h2><p className="preview-amount">{amountError?'—':amountLabel}<small> USDC</small></p><p className="preview-description">{description||'Your service description will appear here.'}</p><dl><dt>Pay to</dt><dd>{account?short(account):'Your connected wallet'}</dd><dt>Network</dt><dd>{network(chainId).name}</dd><dt>Due date</dt><dd>{deadlineError?'Invalid deadline':deadline?new Date(deadlineSeconds*1000).toLocaleDateString('en-US'):'No deadline'}</dd></dl><div className="preview-cta">Review & pay <Icon name="arrow"/></div><small>Preview only · No signed request exists yet</small></div><div className="tip"><Icon name="link"/><div><h3>Ready to share, easy to verify</h3><p>After signing, send one link. Your customer can review the details before connecting a wallet.</p></div></div></aside></div>;
}
