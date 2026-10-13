import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { formatUnits, getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { MAINNET, TESTNET, network, networks } from './config';
import { decodeRequest, expired, requestLink } from './protocol';
import type { SignedRequest } from './protocol';
import { errorText, PayRefError, rejected } from './errors';
import { scanRequest, verifyPayment } from './chain';
import type { ScanResult } from './chain';
import { backup, browserRepository, download, exportCsv, inspectBackup, locked, transactionHash, unresolved } from './storage';
import type { Attempt, ExportStatus, ImportPreview, StoredRequest } from './storage';
import { connect, connectedAccounts, signRequest, switchAccount, switchNetwork, sendPayment, preparePayment } from './wallet';
import type { PaymentReview, Provider, WalletOption } from './wallet';
import type { VerifiedPayment } from './verification';
import { mergePayments } from './verification';
import { recoverAttempt } from './recovery';
import { filterRequests, needsAttention, requestState, stateLabels, summarize } from './dashboard';
import type { RequestState } from './dashboard';
import { Badge, Composer, Empty, Icon, dateLabel, money } from './ui';
import type { IconName } from './ui';
import { EvidencePanel } from './evidence-panel';
import { parseLocalDeadline } from './datetime';
import { usePaymentWatch, persistVerifiedPayment } from './use-payment-watch';
import { ReconciliationWorkspace } from './reconciliation-workspace';
import { HandoffWorkspace } from './handoff-workspace';
import { PaymentInbox, SaveToInboxButton } from './payment-inbox';
import { PaymentQr } from './payment-qr';
import { browserReceivables } from './receivables-store';
import type { Receivable } from './receivables';
import './reconciliation.css';
import './experience.css';
import './payment-experience.css';

const short = (s: string) => `${s.slice(0,8)}…${s.slice(-6)}`;

export default function App() {
  const [chainId,setChainId]=useState<number>(TESTNET);
  const [wallets,setWallets]=useState<WalletOption[]>([]);
  const [walletId,setWalletId]=useState('');
  const walletChosen=useRef(false);
  const [account,setAccount]=useState<Address>();
  const [authorizedAccounts,setAuthorizedAccounts]=useState<Address[]>([]);
  const [busy,setBusy]=useState(false), [notice,setNotice]=useState(''), [error,setError]=useState('');
  const [requests,setRequests]=useState<StoredRequest[]>([]), [attempts,setAttempts]=useState<Attempt[]>([]);
  const [selected,setSelected]=useState<SignedRequest>();
  const [review,setReview]=useState<PaymentReview>();
  const [reuseSource,setReuseSource]=useState<SignedRequest>();
  const [businessSource,setBusinessSource]=useState<Receivable>();
  const [showLoader,setShowLoader]=useState(false);
  const [exportStatus,setExportStatus]=useState<ExportStatus>();
  const [evidenceFailure,setEvidenceFailure]=useState<{hash:string;stage:string;message:string}>();
  const reviewEpoch=useRef(0);
  const walletEpoch=useRef(0);
  const routeEpoch=useRef(0);
  const routeValue=useRef(location.pathname+location.hash);
  const watchEpoch=useRef(0);
  const watchError=useRef<string|undefined>(undefined);
  const activeRead=useRef<AbortController|undefined>(undefined);
  const busyRef=useRef(false);
  const [hash,setHash]=useState(''), [input,setInput]=useState('');
  const [results,setResults]=useState<Record<string,ScanResult>>({});
  const [payments,setPayments]=useState<Record<string,VerifiedPayment[]>>({});
  const [preview,setPreview]=useState<ImportPreview>();
  const [scanController,setScanController]=useState<AbortController>();
  const [route,setRoute]=useState(location.pathname+location.hash);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<RequestState|'all'>('all'),[sort,setSort]=useState('newest');
  const [loaded,setLoaded]=useState(false),[storageError,setStorageError]=useState('');
  const [now,setNow]=useState(()=>BigInt(Math.floor(Date.now()/1000)));
  const provider=wallets.find(w=>w.id===walletId)?.provider;
  const path=route.split('#')[0];
  const reuseId=new URLSearchParams(route.split('#')[1]??'').get('reuse');
  const businessId=new URLSearchParams(route.split('#')[1]??'').get('receivable');
  useEffect(()=>{
    if(!selected || (path!=='/'&&path!=='/requests'))return;
    const previous=document.activeElement as HTMLElement|null;
    const dialog=document.querySelector<HTMLElement>('[role="dialog"]');dialog?.focus();
    const scroll=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=scroll;previous?.focus();};
  },[selected,path]);
  const reload=useCallback(async()=>{
    try { const repository=browserRepository();const [records,localAttempts]=await Promise.all([repository.requests(),Promise.resolve(repository.attempts())]);setRequests(records);setAttempts(localAttempts);setStorageError('');setLoaded(true);setExportStatus(repository.exportStatus(records)); }
    catch(e){setStorageError(errorText(e));setLoaded(false);}
  },[]);
  const watch=usePaymentWatch({
    onPayment:(req,p)=>{setPayments(prev=>({...prev,[req.requestId]:mergePayments(prev[req.requestId]??[],[p])}));if(watchEpoch.current===routeEpoch.current){setEvidenceFailure(undefined);clearWatchError();if(!busyRef.current)setNotice('Payment verified against the signed request. Check the full range for duplicate payments.');}},
    onError:(e,txHash)=>{if(watchEpoch.current!==routeEpoch.current)return;const message=errorText(e);watchError.current=message;setError(message);if(e instanceof PayRefError&&e.code==='EVIDENCE_MISMATCH')setEvidenceFailure({hash:txHash,stage:e.context.evidenceStage??e.stage,message:e.message});},
    onFinish:()=>{void reload();},
  });
  useEffect(()=>{setReview(undefined);reviewEpoch.current++;},[account,provider,chainId,selected?.requestId,route]);
  useEffect(()=>{setShowLoader(false);setEvidenceFailure(undefined);return()=>watch.stop(true);},[route,selected?.requestId]);
  useEffect(()=>{
    if(!selected||!loaded||(path!=='/pay'&&path!=='/receipt'))return;
    const attempt=attempts.find(a=>a.requestId===selected.requestId&&a.chainId===selected.domain.chainId&&a.hash&&unresolved(a.status));
    if(attempt?.hash&&!watch.hasStarted(selected,attempt.hash))startWatch(selected,attempt.hash,attempt.payer);
  },[selected,attempts,loaded,path]);
  useEffect(()=>{const change=()=>changeRoute(location.pathname+location.hash);window.addEventListener('popstate',change);window.addEventListener('hashchange',change);const timer=setInterval(()=>setNow(BigInt(Math.floor(Date.now()/1000))),1000);return()=>{window.removeEventListener('popstate',change);window.removeEventListener('hashchange',change);clearInterval(timer);};},[]);
  useEffect(()=>{void reload(); const handler=()=>{void reload();};window.addEventListener('storage',handler);window.addEventListener('payref-storage',handler);return()=>{window.removeEventListener('storage',handler);window.removeEventListener('payref-storage',handler);};},[reload]);
  useEffect(()=>{
    const announced=(event:Event)=>{
      const detail=(event as CustomEvent<{info:{uuid:string;name:string};provider:Provider}>).detail;
      if(!detail?.provider || typeof detail.info?.uuid!=='string') return;
      setWallets(items=>items.some(w=>w.id===detail.info.uuid)?items:[...items,{id:detail.info.uuid,name:detail.info.name,provider:detail.provider}]);
      setWalletId(current=>!walletChosen.current&&detail.info.name==='MetaMask'?detail.info.uuid:current||detail.info.uuid);
    };
    window.addEventListener('eip6963:announceProvider',announced);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const legacy=(window as unknown as {ethereum?:Provider}).ethereum;
    if(legacy){setWallets(items=>items.length?items:[{id:'injected',name:'Browser wallet',provider:legacy}]);setWalletId(id=>id||'injected');}
    return()=>window.removeEventListener('eip6963:announceProvider',announced);
  },[]);
  useEffect(()=>{
    let active=true;
    walletEpoch.current++;
    setAccount(undefined);setAuthorizedAccounts([]);
    invalidatePaymentReview();
    const accountsChanged=(value:unknown)=>{
      const epoch=++walletEpoch.current;
      invalidatePaymentReview();
      setAccount(undefined);setAuthorizedAccounts([]);
      if(!Array.isArray(value)||value.length===0){setNotice('No account is connected to this site. Connect a wallet to continue.');return;}
      if(value.some(item=>typeof item!=='string'||!isAddress(item))){setNotice('');setError('wallet · INVALID_ACCOUNT: The wallet returned an invalid account. Reconnect to continue.');return;}
      const available=[...new Set(value.map(item=>getAddress(item)))];
      const next=available[0];
      // An account event cannot silently switch the application's chosen network.
      void provider!.request({method:'eth_chainId'}).then(chain=>{
        if(!active||epoch!==walletEpoch.current)return;
        if(BigInt(chain)!==BigInt(chainId)){setNotice('Wallet network differs from this workspace. Reconnect on the selected network to continue.');return;}
        setAuthorizedAccounts(available);setAccount(next);setNotice('Wallet account updated. Previous payment checks were cleared.');
      }).catch(cause=>{if(active&&epoch===walletEpoch.current){setNotice('');setError(errorText(new PayRefError('ACCOUNT_SYNC_FAILED','wallet','Could not check the wallet network after the account changed. Reconnect to continue.',{}, {cause})));}});
    };
    const chainChanged=()=>{walletEpoch.current++;invalidatePaymentReview();setAccount(undefined);setAuthorizedAccounts([]);setNotice('Wallet network changed. Reconnect on the selected network to continue.');};
    provider?.on?.('accountsChanged',accountsChanged);provider?.on?.('chainChanged',chainChanged);
    return()=>{active=false;walletEpoch.current++;provider?.removeListener?.('accountsChanged',accountsChanged);provider?.removeListener?.('chainChanged',chainChanged);};
  },[provider,chainId]);
  useEffect(()=>{
    setSelected(undefined);setInput('');setHash('');setReuseSource(undefined);setBusinessSource(undefined);
    let active=true;const epoch=routeEpoch.current; const params=new URLSearchParams(route.split('#')[1]??'');const encoded=params.get('request');
    const business=params.get('receivable');
    if(path==='/requests/new'&&business){try{if(params.get('reuse'))throw new PayRefError('AMBIGUOUS_DRAFT','create','Choose one draft source.');const source=browserReceivables().list().find(item=>item.id===business);if(!source)throw new PayRefError('BUSINESS_MISSING','create','The business record is not saved in this browser.');if(source.requestId)throw new PayRefError('BUSINESS_ALREADY_LINKED','create','This business record already has a signed request. Review it before creating another request.');setBusinessSource(source);setChainId(source.chainId);}catch(e){setError(errorText(e));}}
    const reuse=params.get('reuse');if(path==='/requests/new'&&reuse){void browserRepository().requests().then(records=>{if(!active||epoch!==routeEpoch.current)return;const source=records.find(r=>r.request.requestId===reuse)?.request;if(!source)throw new PayRefError('MISSING_REQUEST','create','The original request is not saved in this browser.');setReuseSource(source);setChainId(source.domain.chainId);}).catch(e=>{if(active&&epoch===routeEpoch.current)setError(errorText(e));});}else setReuseSource(undefined);
    if(encoded) void decodeRequest(encoded).then(req=>{if(active&&epoch===routeEpoch.current){setSelected(req);setChainId(req.domain.chainId);setInput(requestLink(req,location.origin));const tx=params.get('tx');if(tx)setHash(transactionHash(tx));}}).catch(e=>{if(active&&epoch===routeEpoch.current)setError(errorText(e));});
    return()=>{active=false;};
  },[route]);
  function changeRoute(next:string){
    if(next===routeValue.current)return;
    routeEpoch.current++;reviewEpoch.current++;routeValue.current=next;
    activeRead.current?.abort();watch.stop(true);
    setReview(undefined);setSelected(undefined);setHash('');setInput('');setReuseSource(undefined);setBusinessSource(undefined);setNotice('');setError('');setEvidenceFailure(undefined);setRoute(next);
  }
  function scopedNotice(epoch:number){return (message:string)=>{if(epoch===routeEpoch.current)setNotice(message);};}
  function clearWatchError(){const previous=watchError.current;if(previous)setError(current=>current===previous?'':current);watchError.current=undefined;}
  function startWatch(req:SignedRequest,txHash:Hex,payer:Address){watchEpoch.current=routeEpoch.current;clearWatchError();setEvidenceFailure(undefined);watch.start(req,txHash,payer);}
  function navigate(event:MouseEvent<HTMLDivElement>) {
    const anchor=(event.target as Element).closest('a');if(!anchor||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||anchor.target||anchor.hasAttribute('download'))return;
    const url=new URL(anchor.href);if(url.origin!==location.origin)return;
    if(!['/','/requests','/requests/new','/activity','/backups','/receipt','/pay','/receivables','/exceptions','/handoff','/inbox'].includes(url.pathname))return;
    event.preventDefault();if(busyRef.current)return;history.pushState(null,'',url.pathname+url.hash);changeRoute(url.pathname+url.hash);window.scrollTo({top:0});
  }
  async function run(operation:()=>Promise<void>) {if(busyRef.current)return;const epoch=routeEpoch.current;busyRef.current=true;setBusy(true);setError('');setNotice('Working…');try{await operation();}catch(e){if(epoch===routeEpoch.current){setNotice('');setError(rejected(e)?'Wallet request rejected. No success recorded.':errorText(e));}}finally{busyRef.current=false;setBusy(false);void reload();}}
  function invalidatePaymentReview(){reviewEpoch.current++;setReview(undefined);activeRead.current?.abort();}
  async function syncWalletConnection(epoch:number,message:string,chosen?:Address) {
    if(!provider||epoch!==routeEpoch.current)return;
    // Permission selection may emit events before it resolves. Its final read
    // supersedes those reads, while a later event invalidates this snapshot.
    const walletVersion=++walletEpoch.current;
    setAccount(undefined);setAuthorizedAccounts([]);
    let accounts:Address[],chain:Hex;
    try{accounts=await connectedAccounts(provider);chain=await provider.request({method:'eth_chainId'});}
    catch(cause){if(walletVersion!==walletEpoch.current||epoch!==routeEpoch.current)return;throw new PayRefError('ACCOUNT_SYNC_FAILED','wallet','Could not read the connected account and network. Reconnect before signing.',{}, {cause});}
    if(walletVersion!==walletEpoch.current||epoch!==routeEpoch.current)return;
    if(!accounts[0])throw new PayRefError('NO_ACCOUNT','wallet','No account is connected to this site. Select an account in your wallet.');
    if(chosen&&!accounts.includes(chosen))throw new PayRefError('ACCOUNT_PERMISSION_CHANGED','wallet','That account is no longer connected to this site. Reconnect before signing.');
    if(BigInt(chain)!==BigInt(chainId))throw new PayRefError('WRONG_WALLET_NETWORK','wallet','Reconnect on the selected network before signing.');
    setAuthorizedAccounts(accounts);setAccount(chosen??accounts[0]);setError(current=>current.startsWith('wallet · ')?'':current);setNotice(message);
  }
  async function connectWallet() {
    if(!provider)throw new PayRefError('NO_WALLET','wallet','Open this page in Chrome with MetaMask enabled.');
    invalidatePaymentReview();
    const epoch=routeEpoch.current;await switchNetwork(provider,chainId);await connect(provider);await syncWalletConnection(epoch,'Wallet connected. No transaction sent.');
  }
  async function chooseWalletAccount() {
    if(!provider)throw new PayRefError('NO_WALLET','wallet','Open this page in Chrome with MetaMask enabled.');
    invalidatePaymentReview();
    const epoch=routeEpoch.current;
    setNotice('Choose the account to connect to this site in your wallet. No signature or payment is requested.');
    await switchAccount(provider);
    await syncWalletConnection(epoch,'Wallet account selected. No transaction sent.');
  }
  async function selectConnectedAccount(value:string){
    invalidatePaymentReview();
    await syncWalletConnection(routeEpoch.current,'Connected account selected. Previous payment checks were cleared.',getAddress(value));
  }
  async function refresh(req:SignedRequest, controller=new AbortController()) {
    const epoch=routeEpoch.current;activeRead.current=controller;setScanController(controller);
    try {
      let result:ScanResult;
      try { result=await scanRequest(req,{signal:controller.signal,progress:scopedNotice(epoch),previous:payments[req.requestId]}); }
      catch(e){setResults(r=>({...r,[req.requestId]:{complete:false,fromBlock:req.message.createdAtBlock,checkedThroughBlock:null,targetBlock:'unknown',payments:payments[req.requestId]??[],anomalies:[],error:errorText(e)}}));throw e;}
      setResults(r=>({...r,[req.requestId]:result}));setPayments(p=>({...p,[req.requestId]:mergePayments(p[req.requestId]??[],result.payments)}));
      if(result.payments.length){
        const hashes=result.payments.map(p=>p.hash);
        await locked('requests',()=>browserRepository().saveRequest(req,hashes));
        const repository=browserRepository();
        for(const attempt of repository.attempts()){
          if(attempt.requestId===req.requestId&&attempt.chainId===req.domain.chainId&&attempt.hash&&hashes.some(h=>h.toLowerCase()===attempt.hash!.toLowerCase())){
            repository.saveAttempt({...attempt,status:'CONFIRMED',updatedAt:new Date().toISOString()});
          }
        }
      }
      scopedNotice(epoch)(result.complete?`Checked through block ${result.targetBlock}.`:result.error??'Verification incomplete.');return result;
    }finally{if(activeRead.current===controller){activeRead.current=undefined;setScanController(undefined);}}
  }
  async function create(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const epoch=routeEpoch.current;const data=new FormData(event.currentTarget);
    await run(async()=>{
      if(!provider||!account)throw new PayRefError('CONNECT_FIRST','create','Connect the payee wallet first.');
      const deadline=String(data.get('deadline')??'');
      const seconds=parseLocalDeadline(deadline);
      const req=await signRequest(provider,account,{chainId,amount:String(data.get('amount')),reference:String(data.get('reference')),description:String(data.get('description')),expiresAt:String(seconds)});
      if(epoch===routeEpoch.current)setSelected(req);
      await locked('requests',()=>browserRepository().saveRequest(req));
      if(businessSource){const source=businessSource;await locked('receivables',async()=>{const current=browserReceivables().list().find(item=>item.id===source.id);if(!current||current.requestId)throw new PayRefError('BUSINESS_LINK_CHANGED','create','The signed request was saved, but the business association changed. Review the business record before linking it.',{requestId:req.requestId});if(current.chainId!==req.domain.chainId)throw new PayRefError('BUSINESS_NETWORK_CHANGED','create','The signed request was saved but could not be linked across networks.',{requestId:req.requestId});browserReceivables().linkRequest(source.id,req.requestId);});if(epoch===routeEpoch.current)setBusinessSource({...source,requestId:req.requestId});}
      scopedNotice(epoch)(businessSource?'Signed request saved and linked to the business record. Return to receivables to compare the details.':'Signed request saved in this browser. Share the link or download a backup.');
    });
  }
  async function loadInput() {
    const epoch=routeEpoch.current;
    setSelected(undefined);setHash('');
    let encoded=input.trim();
    let linkedHash='';
    if(encoded.startsWith('http://')||encoded.startsWith('https://')) {const params=new URLSearchParams(new URL(encoded).hash.slice(1));encoded=params.get('request')??'';const tx=params.get('tx');if(tx)linkedHash=transactionHash(tx);}
    const req=await decodeRequest(encoded);if(epoch===routeEpoch.current){setSelected(req);setHash(linkedHash);setChainId(req.domain.chainId);setNotice('Request signature verified. Confirm the payee matches your agreement.');}
  }
  async function verifyHash() {
    if(!selected)throw new PayRefError('NO_REQUEST','receipt','Load a signed request first.');
    const epoch=routeEpoch.current;const req=selected;const txHash=transactionHash(hash.trim());setEvidenceFailure(undefined);
    let p:VerifiedPayment;
    try{p=await verifyPayment(req,txHash);}catch(e){if(epoch===routeEpoch.current&&e instanceof PayRefError)setEvidenceFailure({hash:txHash,stage:e.context.evidenceStage??e.stage,message:e.message});throw e;}
    setPayments(prev=>({...prev,[req.requestId]:mergePayments(prev[req.requestId]??[],[p])}));
    if(epoch===routeEpoch.current&&watch.state?.requestId===req.requestId)watch.dismiss();
    await persistVerifiedPayment(req,p);
    scopedNotice(epoch)('This payment is verified. Scan the request to check for duplicate payments.');
  }
  async function recover(attempt:Attempt) {
    const epoch=routeEpoch.current;
    const txHash=hash.trim()?transactionHash(hash.trim()):attempt.hash;
    if(!txHash)throw new PayRefError('MISSING_HASH','recovery','Paste the original or replacement transaction hash.');
    const req=requests.find(r=>r.request.requestId===attempt.requestId&&r.request.domain.chainId===attempt.chainId)?.request??(selected?.requestId===attempt.requestId?selected:undefined);
    if(!req)throw new PayRefError('MISSING_REQUEST','recovery','Restore the original signed request first.');
    const recovered=await recoverAttempt(req,attempt,txHash);
    if(epoch===routeEpoch.current&&watch.state?.requestId===req.requestId)watch.dismiss();
    browserRepository().saveAttempt(recovered.attempt);
    if(recovered.payment){const p=recovered.payment;await locked('requests',()=>browserRepository().saveRequest(req,[txHash]));setPayments(prev=>({...prev,[req.requestId]:mergePayments(prev[req.requestId]??[],[p])}));scopedNotice(epoch)('The matching payment is verified.');}
    else scopedNotice(epoch)(recovered.attempt.status==='REVERTED'?'The matching transaction reverted. No successful payment was recorded.':'The nonce was consumed by a different transaction. This is not a verified PayRef payment. Check the request again before paying.');
  }
  const scoped=requests.filter(r=>r.request.domain.chainId===chainId);
  const pending=attempts.filter(a=>a.chainId===chainId&&unresolved(a.status));
  const localActivity=attempts.filter(a=>a.chainId===chainId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const summary=summarize(scoped,payments,results,attempts,now);
  const visible=filterRequests(scoped,query,filter,sort,payments,results,attempts,now);
  const currentPayments=selected?payments[selected.requestId]??[]:[];
  const currentResult=selected?results[selected.requestId]:undefined;
  const currentAttempts=selected?attempts.filter(a=>a.requestId===selected.requestId&&a.chainId===selected.domain.chainId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)):[];
  const knownHashes=selected?requests.find(r=>r.request.requestId===selected.requestId)?.hashes??[]:[];
  const workspace=path==='/'||path==='/requests';
  const publicPage=path==='/pay'||path==='/receipt';
  const deadlineReached=selected?expired(selected,now):false;
  function state(r:SignedRequest){return requestState(r,payments[r.requestId]??[],results[r.requestId],attempts,now);}
  function select(r:SignedRequest){setSelected(r);setHash(requests.find(x=>x.request.requestId===r.requestId)?.hashes[0]??'');setError('');}
  async function copy(value:string,label:string){const epoch=routeEpoch.current;await navigator.clipboard.writeText(value);scopedNotice(epoch)(label);}
  async function refreshAll(){
    const epoch=routeEpoch.current;const controller=new AbortController();let completed=0,failed=0,checked=0;const failures:string[]=[];
    for(const {request:r} of scoped){if(controller.signal.aborted||epoch!==routeEpoch.current)break;try{const result=await refresh(r,controller);if(result.complete)completed++;else failed++;}catch(e){failed++;if(failures.length<3)failures.push(`${errorText(e)} · requestId=${r.requestId}`);}checked++;}
    if(epoch===routeEpoch.current&&failures.length)setError(failures.join(' / '));
    scopedNotice(epoch)(`${completed} of ${scoped.length} requests fully checked. ${failed} incomplete or failed. ${scoped.length-checked} not checked.${controller.signal.aborted?' Scan cancelled.':''}`);
  }
  async function prepare(){
    if(!selected||!provider||!account)throw new PayRefError('CONNECT_FIRST','payment','Connect the paying wallet first.');
    setReview(undefined);const epoch=routeEpoch.current,preparedEpoch=reviewEpoch.current;const controller=new AbortController();activeRead.current=controller;setScanController(controller);
    try{const prepared=await preparePayment(selected,provider,account,scopedNotice(epoch),controller.signal);if(epoch!==routeEpoch.current)return;if(preparedEpoch!==reviewEpoch.current)throw new PayRefError('REVIEW_CHANGED','payment','Payment details changed. Check again.');setReview(prepared);setNotice('Checks passed. Review the amount and maximum network fee before continuing.');}finally{if(activeRead.current===controller){activeRead.current=undefined;setScanController(undefined);}}
  }
  async function pay(){
    if(!selected||!provider||!account||!review)throw new PayRefError('REVIEW_REQUIRED','payment','Check and review the payment first.');
    const epoch=routeEpoch.current;const req=selected,payer=account;const controller=new AbortController();activeRead.current=controller;
    try{const sent=await sendPayment(req,provider,payer,scopedNotice(epoch),review,controller.signal);if(epoch!==routeEpoch.current)return;setHash(sent);setReview(undefined);setNotice(`Submitted ${sent}. Checking the receipt automatically.`);if(!watch.hasStarted(req,sent))startWatch(req,sent,payer);}
    catch(e){if(epoch===routeEpoch.current)setReview(undefined);throw e;}
    finally{if(activeRead.current===controller)activeRead.current=undefined;}
  }
  async function exportRequests(records:StoredRequest[],name:string){
    // This exact snapshot is used both for the file and for export tracking.
    const snapshot=records.map(r=>({...r,hashes:[...r.hashes]}));
    download(name,backup(snapshot));
    try{browserRepository().recordExport(snapshot);}catch(cause){throw new PayRefError('EXPORT_TRACKING_FAILED','backup','The download was initiated, but its reminder record could not be saved. Check your downloads.',{}, {cause});}
    setNotice('JSON download initiated. Check that the file is saved somewhere safe.');
  }
  async function importFile(file:File){const epoch=routeEpoch.current;setPreview(undefined);if(file.size>2*1024*1024)throw new PayRefError('TOO_LARGE','import','Backup limit is 2 MiB.');const inspected=await inspectBackup(await file.text());if(epoch===routeEpoch.current){setPreview(inspected);setNotice(`Validation finished: ${inspected.entries.length} valid, ${inspected.errors.length} rejected. Review the preview before importing. Nothing has been saved yet.`);}}
  async function restoreLink(){
    const epoch=routeEpoch.current;setPreview(undefined);
    let url:URL;try{url=new URL(input.trim());}catch(cause){throw new PayRefError('INVALID_LINK','import','Paste a complete PayRef payment or receipt link.',{}, {cause});}
    if(!['http:','https:'].includes(url.protocol))throw new PayRefError('INVALID_LINK','import','Expected an HTTP or HTTPS payment link.');
    const params=new URLSearchParams(url.hash.slice(1));
    const request=await decodeRequest(params.get('request')??'');
    const tx=params.get('tx');if(epoch===routeEpoch.current){setPreview({entries:[{version:1,request,hashes:tx?[transactionHash(tx)]:[]}],errors:[]});setNotice('Request signature verified. Review the import preview before saving.');}
  }
  async function mergeImport(){if(!preview)return;const epoch=routeEpoch.current;let saved=0;await locked('requests',async()=>{for(const entry of preview.entries){try{await browserRepository().saveRequest(entry.request,entry.hashes);saved++;}catch(cause){throw new PayRefError('PARTIAL_IMPORT','import',`Saved ${saved} of ${preview.entries.length} validated requests. Import stopped; original records were retained.`,{requestId:entry.request.requestId},{cause});}}});if(epoch===routeEpoch.current){setPreview(undefined);setNotice(`Imported ${saved} requests. Refresh their onchain status to verify payments.`);}}
  const nav:{href:string;label:string;icon:IconName}[]=[{href:'/',label:'Overview',icon:'grid'},{href:'/receivables',label:'Business receivables',icon:'list'},{href:'/exceptions',label:'Exception review',icon:'activity'},{href:'/handoff',label:'Handoff & recheck',icon:'archive'},{href:'/requests',label:'Payment requests',icon:'receipt'},{href:'/inbox',label:'To pay',icon:'wallet'},{href:'/receipt',label:'Verify receipt',icon:'shield'},{href:'/activity',label:'Wallet activity',icon:'activity'},{href:'/backups',label:'Backups & exports',icon:'archive'}];
  const headings:Record<string,[string,string]>={
    '/':['Your payments, in perspective.','A clear view of your requests, receipts and what needs attention.'],
    '/requests':['Every payment has a story.','Keep your requests organized. Match the payment to the work.'],
    '/requests/new':['Good work deserves a clear request.','Create a signed USDC request your customer can review and verify.'],
    '/receipt':['Trust the evidence.','Independently verify a payment against the original signed request.'],
    '/pay':['A clear request. A confident payment.','Review the details, confirm the recipient, then pay with your wallet.'],
    '/activity':['Follow every wallet attempt.','Submitted, rejected and unresolved are different. Keep the full picture.'],
    '/receivables':['From business records to verified payments.','Compare what you expected, what was signed and what actually arrived.'],
    '/exceptions':['Make the difference clear.','Inspect the evidence, explain discrepancies and keep your review separate.'],
    '/handoff':['A record someone else can recheck.','Hand over the original requests and evidence references, then verify independently.'],
    '/inbox':['Keep the requests you need to pay.','Save a request before paying. Your local list stays separate from wallet history.'],
    '/backups':['Your records, in your hands.','Keep a complete backup. Take your payment history wherever you work.'],
  };
  const heading=headings[path]??headings['/'];
  return <div className={`app-shell ${publicPage?'public-page':''}`} onClick={navigate}>
    {!publicPage&&<aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">p<span>↗</span></span>payref<span className="brand-dot">.</span></a>
      <div className="workspace-label"><span className="workspace-avatar">P</span><div>Personal workspace<small>Onchain receivables</small></div></div>
      <p className="nav-caption">WORKSPACE</p><nav aria-label="Main navigation">{nav.map(n=><a key={n.href} href={n.href} className={path===n.href?'active':''} aria-current={path===n.href?'page':undefined}><Icon name={n.icon}/>{n.label}{n.href==='/requests'&&loaded&&<span className="nav-count">{scoped.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><Icon name="shield"/><strong>Your wallet. Your control.</strong><p>Direct USDC payments.<br/>Independently verifiable records.</p><a href="/backups">Keep a backup <Icon name="arrow" size={14}/></a></div><div className="built-on"><span className="arc-symbol">◠</span> Built on Arc <span>↗</span></div></div>
    </aside>}
    <div className="workspace-main">
      <header className="topbar"><div className="breadcrumb">{publicPage?<a className="guest-brand" href="/">payref<span>↗</span></a>:<>Workspace <span>/</span> {nav.find(n=>n.href===path)?.label??(path==='/requests/new'?'New request':'Payment request')}</>}</div><div className="topbar-actions">{publicPage&&<details className="guest-navigation"><summary>Workspace</summary><nav aria-label="Main navigation">{nav.map(n=><a key={n.href} href={n.href}>{n.label}</a>)}</nav></details>}<span className={`network-chip ${chainId===MAINNET?'mainnet':''}`}><i/>{network(chainId).name}</span><details className="wallet-menu"><summary><Icon name="wallet"/>{account?short(account):'Connect wallet'}<span>⌄</span></summary><section aria-label="Wallet connection"><label>Network<select aria-label="Network" value={chainId} disabled={busy||!!businessSource||!!selected&&publicPage} onChange={e=>{setChainId(Number(e.target.value));setAccount(undefined);setSelected(undefined);}}>{Object.values(networks).map(n=><option key={n.id} value={n.id}>{n.name}{n.id===MAINNET?' · real USDC':''}</option>)}</select></label><label>Wallet<select aria-label="Wallet" value={walletId} disabled={busy} onChange={e=>{walletChosen.current=true;setWalletId(e.target.value);}}>{!wallets.length&&<option value="">No browser wallet detected</option>}{wallets.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button disabled={busy} onClick={()=>void run(connectWallet)}>{account?'Reconnect wallet':'Connect wallet'}</button><button className="secondary" disabled={busy||!provider} onClick={()=>void run(chooseWalletAccount)}>Switch account</button>{account&&authorizedAccounts.length>1&&<label>Connected account<select aria-label="Connected account" value={account} disabled={busy} onChange={e=>void run(()=>selectConnectedAccount(e.target.value))}>{authorizedAccounts.map(address=><option key={address} value={address}>{address}</option>)}</select></label>}{account&&<small className="address" aria-label="Active account address">{account}</small>}<p>{authorizedAccounts.length>1?'Choose which connected account to use above. ':'Only accounts connected to this site are available. '}Use Switch account to update the accounts shared by your wallet.</p><p>Signing happens in your wallet. PayRef never holds your funds.</p></section></details></div></header>
      <main>
        <div className="environment"><span><i/>{chainId===MAINNET?'MAINNET · REAL USDC':'TESTNET WORKSPACE · TEST USDC ONLY'}</span><span>Local records · No account required</span></div>
        <section className="page-heading"><div><p className="eyebrow">{path==='/requests/new'?'CREATE & SHARE':publicPage?'PAYMENT EVIDENCE':'LESS ADMIN. MORE CLARITY.'}</p><h1>{heading[0]}</h1><p className="lead">{heading[1]}</p></div>{workspace&&<a className="button primary" href="/requests/new"><Icon name="plus"/>New request</a>}</section>
        {storageError&&<div role="alert" className="message error">{storageError}</div>}{error&&<div role="alert" className="message error">{error}</div>}{notice&&<div role="status" className="message"><Icon name={busy?'clock':'check'}/><span>{notice}</span>{scanController&&<button className="text-button" onClick={()=>scanController.abort()}>Cancel scan</button>}</div>}
        {(workspace||path==='/requests/new')&&loaded&&requests.length>0&&<section className="backup-reminder" aria-label="Backup reminder"><Icon name="archive"/><div><strong>{exportStatus?.error?'Backup reminder unavailable':`${exportStatus?.neverExported??0} requests not yet exported · ${exportStatus?.changed??0} updated since export`}</strong><p>{exportStatus?.error??(exportStatus?.lastExportedAt?`Last download initiated ${new Date(exportStatus.lastExportedAt).toLocaleString('en-US')}. Check your saved file.`:'Your records live in this browser. Download a JSON backup to keep a copy.')}</p></div><button className="secondary" disabled={busy} onClick={()=>void run(()=>exportRequests(requests,'payref-backup.json'))}>Download backup</button></section>}
        {(path==='/receivables'||path==='/exceptions')&&<ReconciliationWorkspace key={path+chainId} mode={path==='/receivables'?'receivables':'exceptions'} chainId={chainId} requests={requests} payments={payments} scans={results} onScan={refresh} onPayment={async(req,p)=>{setPayments(previous=>({...previous,[req.requestId]:mergePayments(previous[req.requestId]??[],[p])}));await persistVerifiedPayment(req,p);await reload();}}/>}
        {path==='/handoff'&&<HandoffWorkspace key={chainId} chainId={chainId} requests={requests} payments={payments} scans={results}/>}
        {path==='/inbox'&&<PaymentInbox chainId={chainId} requests={requests} payments={payments} scans={results} attempts={attempts}/>}
        {workspace&&<>
          <section className="metrics" aria-label="Request overview">
            <article className="metric featured"><div>Saved request value<Icon name="list"/></div><strong>{loaded?money(summary.requested):'—'}<small> USDC</small></strong><p>{loaded?`${scoped.length} signed requests on this network`:'Local records unavailable'}</p></article>
            <article className="metric"><div>Verified receipts<Icon name="receipt"/></div><strong>{loaded?money(summary.received):'—'}<small> USDC</small></strong><p>{summary.paid} requests with verified payments</p></article>
            <article className="metric"><div>Checks remaining<Icon name="clock"/></div><strong>{loaded?summary.unchecked:'—'}<small> requests</small></strong><p>Full payment lookup not completed</p></article>
            <article className="metric"><div>Needs attention<Icon name="activity"/></div><strong>{loaded?summary.attention:'—'}<small> requests</small></strong><p>Deadlines, exceptions or wallet attempts</p></article>
          </section>
          <p className="scope-note"><Icon name="shield" size={13}/>Receipt totals reflect checks in this session, including any duplicate payments. Saved request value is not revenue.</p>
          {loaded&&scoped.length>0&&summary.paid===0&&summary.unchecked>0&&<p className="scope-note" role="note">No payments verified in this session. Zero verified receipts does not mean unpaid. Your saved requests and transaction hashes remain available. Use Check all or verify a known transaction to recheck the chain.</p>}
          <section className="workspace-grid"><div className="panel requests-panel"><div className="panel-heading"><div><h2>{path==='/'?'Your payment requests':'Payment requests'} <span className="count-pill">{scoped.length}</span></h2><p>A reference for the work. A record for the payment.</p></div><button className="secondary" disabled={busy||!loaded||!scoped.length} onClick={()=>void run(refreshAll)}><Icon name="refresh"/>Check all</button></div>
            <div className="list-tools"><div className="search-field"><Icon name="search"/><input aria-label="Search requests" placeholder="Search reference, description or wallet…" value={query} onChange={e=>setQuery(e.target.value)}/></div><select aria-label="Sort requests" value={sort} onChange={e=>setSort(e.target.value)}><option value="newest">Newest first</option><option value="deadline">Deadline first</option><option value="amount">Highest amount</option><option value="reference">Reference A–Z</option></select></div>
            <div className="filter-tabs" role="group" aria-label="Filter requests">{(['all','unchecked','paid','pending','expired','incomplete','duplicate','open'] as const).map(f=><button key={f} aria-pressed={filter===f} className={filter===f?'selected':''} onClick={()=>setFilter(f)}>{f==='all'?'All requests':stateLabels[f]}</button>)}</div>
            {!loaded?<Empty icon="archive" title={storageError?'Records could not be loaded':'Loading your records'}>Payment information is unavailable until local records can be read.</Empty>:!scoped.length?<Empty title="Make your next payment easier to trace." action={<><a href="/requests/new" className="button">Create your first request <Icon name="arrow"/></a><a href="/backups" className="text-link">Restore a backup</a></>}>Create a request, share the link, and give every USDC payment a business reference. Your real records will appear here.</Empty>:!visible.length?<Empty icon="search" title="No matching requests" action={<button className="secondary" onClick={()=>{setQuery('');setFilter('all');}}>Clear filters</button>}>Try a different reference, wallet address or status.</Empty>:<div className="table-scroll"><table className="request-table"><thead><tr><th>REFERENCE / DETAILS</th><th>AMOUNT</th><th>STATUS</th><th>DEADLINE</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(({request:r})=><tr key={r.requestId}><td><button className="request-name" onClick={()=>select(r)}><span className="row-icon"><Icon name="receipt"/></span><span><strong>{r.message.reference}</strong><small>{r.message.description||short(r.message.payee)}</small></span></button></td><td className="number">{money(r.message.amount)}<small>USDC</small></td><td><Badge state={state(r)}/>{results[r.requestId]?.complete&&<small className="cell-note">As of block {results[r.requestId].targetBlock}</small>}</td><td className="date-cell">{dateLabel(r.message.expiresAt)}</td><td><button className="icon-button" aria-label={`Open ${r.message.reference}`} onClick={()=>select(r)}><Icon name="arrow"/></button></td></tr>)}</tbody></table></div>}
            <div className="table-footer"><span>{visible.length} of {scoped.length} requests · {network(chainId).name}</span><button className="text-button" disabled={busy||!loaded||!visible.length} onClick={()=>download('payref-reconciliation.csv',exportCsv(visible,payments),'text/csv;charset=utf-8')}><Icon name="download" size={14}/>Export view</button></div>
          </div><aside className="overview-aside"><div className="panel workflow-card"><p className="eyebrow">FROM WORK TO PAYMENT</p><h2>One connected record.</h2><ol className="workflow"><li><span>1</span><div><strong>Create a request</strong><p>Set the amount and reference.<br/>Sign with your receiving wallet.</p></div></li><li><span>2</span><div><strong>Share with your customer</strong><p>One link with the details.<br/>One payment through their wallet.</p></div></li><li><span>3</span><div><strong>Verify & keep the receipt</strong><p>Match the transfer to the work.<br/>Export a record you can recheck.</p></div></li></ol><a href="/requests/new" className="text-link">Create a request <Icon name="arrow" size={15}/></a></div><div className="backup-callout"><Icon name="archive" size={23}/><h3>A small habit. A safer record.</h3><p>Your requests live in this browser. A JSON backup keeps the full signed details with you.</p><a href="/backups">Manage backups <Icon name="arrow" size={15}/></a></div></aside></section>
          {(summary.attention>0||pending.length>0)&&<section className="panel attention-panel"><div className="panel-heading"><div><p className="eyebrow">REVIEW QUEUE</p><h2>A little attention needed.</h2></div><Icon name="activity"/></div>{scoped.filter(({request:r})=>needsAttention(r,payments[r.requestId]??[],results[r.requestId],attempts,now)).map(({request:r})=><button key={r.requestId} className="attention-row" onClick={()=>select(r)}><strong>{r.message.reference}</strong><span>{results[r.requestId]?.anomalies.length?`${results[r.requestId].anomalies.length} unmatched Memo record(s)`:results[r.requestId]&&!results[r.requestId].complete?'Latest check incomplete':attempts.some(a=>a.requestId===r.requestId&&unresolved(a.status))?'Wallet attempt unresolved':stateLabels[state(r)]}</span><Icon name="arrow"/></button>)}{pending.length>0&&<a className="text-link" href="/activity">Review {pending.length} unresolved wallet attempt(s) <Icon name="arrow"/></a>}</section>}
        </>}
        {path==='/requests/new'&&reuseId&&reuseSource?.requestId!==reuseId&&<Empty title={error?'Original request unavailable':'Loading the original request'} action={<a className="text-link" href="/requests/new">Start a blank request</a>}>The saved signed request must be verified before its fields can be reused.</Empty>}
        {path==='/requests/new'&&businessId&&!businessSource&&<Empty title={error?'Business draft unavailable':'Loading business draft'} action={<a className="text-link" href="/receivables">Return to business records</a>}>A valid, unlinked business record is required before creating its request.</Empty>}
        {path==='/requests/new'&&businessSource?.requestId&&<div className="message"><a className="text-link" href="/receivables">Return to business receivables to compare the new signed request <Icon name="arrow"/></a></div>}
        {path==='/requests/new'&&(!reuseId||reuseSource?.requestId===reuseId)&&(!businessId||!!businessSource)&&!businessSource?.requestId&&<Composer key={route+(reuseSource?.requestId??'')} initialRequest={reuseSource} businessDraft={businessSource} busy={busy} account={account} chainId={chainId} records={requests} onSubmit={create}/>}
        {publicPage&&selected&&<button className="text-button change-request" disabled={busy} onClick={()=>setShowLoader(value=>!value)}>{showLoader?'Hide request input':'Load another request'}</button>}
        {publicPage&&(!selected||showLoader)&&<section className="panel verification-loader"><div className="section-symbol"><Icon name="shield" size={25}/></div><div><h2>{selected?'Original signed request':'Start with the original request'}</h2><p>A transaction hash alone cannot recover the business details. Paste a PayRef payment or receipt link.</p><label className="sr-only" htmlFor="request-link">Signed request link</label><div className="load-row"><textarea id="request-link" value={input} onChange={e=>setInput(e.target.value)} placeholder="Paste a PayRef payment or receipt link…" rows={2} disabled={busy}/><button disabled={busy||!input} onClick={()=>void run(loadInput)}>Load & verify <Icon name="arrow"/></button></div></div></section>}
        {selected&&<section className={`detail-layout ${workspace?'detail-overlay':''}`} aria-label="Request details">{workspace&&<button className="detail-backdrop" aria-label="Close request details" onClick={()=>setSelected(undefined)}/>}<div className="panel request-detail" role={workspace?'dialog':undefined} aria-modal={workspace?true:undefined} aria-label={workspace?'Payment request details':undefined} tabIndex={workspace?-1:undefined} onKeyDown={e=>{if(!workspace)return;if(e.key==='Escape'){setSelected(undefined);return;}if(e.key==='Tab'){const nodes=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary'));const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===e.currentTarget)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}><div className="detail-heading"><div className="brand mini"><span className="brand-mark">p<span>↗</span></span>payref.</div><div className="actions"><span className="badge signed"><Icon name="shield" size={13}/>Signature verified</span>{workspace&&<button className="icon-button" aria-label="Close details" onClick={()=>setSelected(undefined)}><Icon name="close"/></button>}</div></div><p className="eyebrow">PAYMENT REQUEST · {network(selected.domain.chainId).name}</p><h2 className="request-title">{selected.message.reference}</h2><div className="request-amount">{money(selected.message.amount)}<small>USDC</small></div><p className="request-description">{selected.message.description||'No description provided.'}</p><div className="request-status"><Badge state={state(selected)}/>{currentResult?.complete&&<span className="cell-note">As of block {currentResult.targetBlock}</span>}{deadlineReached&&<span className="deadline-note">Deadline reached</span>}</div>
          <dl className="request-facts"><dt>Receiving wallet</dt><dd className="address">{selected.message.payee}</dd><dt>Payment deadline</dt><dd>{selected.message.expiresAt==='0'?'No deadline':new Date(Number(selected.message.expiresAt)*1000).toLocaleString('en-US')}</dd><dt>Payment network</dt><dd>{network(selected.domain.chainId).name} · USDC</dd></dl>
          <div className="detail-actions"><button className="secondary" disabled={busy} onClick={()=>void run(()=>refresh(selected).then(()=>{}))}><Icon name="refresh"/>Check payment</button><button className="secondary" disabled={busy} onClick={()=>void run(()=>copy(requestLink(selected,location.origin),'Payment link copied. Anyone with the link can read its details.'))}><Icon name="link"/>Copy link</button><button className="secondary" disabled={busy} onClick={()=>void run(()=>exportRequests([{version:1,request:selected,hashes:knownHashes}],'payref-request.json'))}><Icon name="download"/>Download request JSON</button>{workspace&&<a className="text-link" href={`/requests/new#reuse=${selected.requestId}`}>Reuse as new request <Icon name="plus"/></a>}{workspace&&<a className="text-link" href={requestLink(selected,location.origin)}>Open payment page <Icon name="arrow"/></a>}</div>
          {publicPage&&<SaveToInboxButton request={selected}/>}
          <PaymentQr key={selected.requestId} request={selected}/>
          <div className="payment-timeline"><h3>The payment record</h3><ol><li className="done"><span><Icon name="check" size={13}/></span><div><strong>Request signature verified</strong><p>The receiving wallet signed these exact details.</p></div></li><li className={currentAttempts.length||knownHashes.length?'done':''}><span><Icon name="wallet" size={13}/></span><div><strong>{currentAttempts.length?`Wallet attempt: ${currentAttempts[0].status.replaceAll('_',' ').toLowerCase()}`:knownHashes.length?'Transaction hash available':'Awaiting payment evidence'}</strong><p>A wallet attempt or saved hash is not proof of payment.</p></div></li><li className={currentPayments.length?'done':''}><span><Icon name="receipt" size={13}/></span><div><strong>{currentPayments.length?`${currentPayments.length} payment(s) verified`:'Onchain payment not yet verified'}</strong><p>{currentResult?.complete?`Full lookup completed through block ${currentResult.targetBlock}.`:'Full payment lookup still needed to check for duplicates.'}</p></div></li></ol></div>
          {path==='/pay'&&<div className="pay-action"><p className="eyebrow">REVIEW & PAY</p><h3>Pay directly from your wallet</h3><p>{selected.domain.chainId===MAINNET?'Real USDC and mainnet gas will be spent.':'Testnet only. This uses test USDC.'} Confirm the receiving address matches your agreement.</p>
            {review&&<section className="payment-review" aria-label="Payment confirmation"><div className="review-heading"><Icon name="shield"/><strong>Review your payment</strong><span className="badge signed">Checks passed</span></div><dl><dt>To</dt><dd className="address">{selected.message.payee}</dd><dt>From</dt><dd className="address">{review.payer}</dd><dt>Network</dt><dd>{network(review.chainId).name}</dd><dt>Payment amount</dt><dd>{money(selected.message.amount)} USDC</dd><dt>Maximum network fee</dt><dd>{formatUnits(review.gas*review.maxFeePerGas,18)} USDC</dd><dt>Maximum total spend</dt><dd className="review-total">{formatUnits(BigInt(selected.message.amount)*10n**12n+review.gas*review.maxFeePerGas,18)} USDC</dd><dt>Available balance</dt><dd>{formatUnits(review.balance,18)} USDC</dd></dl><p className="review-scope">Signature, wallet, balance and simulation checked. No matching payment found through block {review.checkedThroughBlock}. All checks run again before sending.</p><p className="review-expiry">{Number(now)*1000>=review.expiresAt?'This estimate has expired. Check payment again.':`Estimate expires in ${Math.min(120,Math.max(0,Math.ceil((review.expiresAt-Number(now)*1000)/1000)))} seconds. Actual network fees may be lower.`}</p></section>}
            <div className="pay-buttons"><button className={review?'secondary':''} disabled={busy||!account||currentPayments.length>0||deadlineReached||currentAttempts.some(a=>unresolved(a.status))} onClick={()=>void run(prepare)}><Icon name="shield"/>{review?'Refresh payment checks':'Check payment & fees'}</button>{review&&<button disabled={busy||Number(now)*1000>=review.expiresAt||!account||currentPayments.length>0||deadlineReached||currentAttempts.some(a=>unresolved(a.status))} onClick={()=>void run(pay)}><Icon name="wallet"/>Confirm & pay {money(selected.message.amount)} USDC <Icon name="arrow"/></button>}</div>{!account&&<small>Connect the paying wallet above to continue.</small>}{deadlineReached&&<small>This request has expired. Historical payments can still be verified.</small>}
          </div>}
          {watch.state&&watch.state.requestId===selected.requestId&&<section className={`watch-panel ${watch.state.status}`} aria-label="Payment progress" aria-live="polite"><div className="review-heading"><Icon name={watch.state.status==='verified'?'check':'clock'}/><h3>{watch.state.status==='checking'?'Checking your payment':watch.state.status==='verified'?'Payment confirmed':watch.state.status==='reverted'?'Transaction reverted':'Payment needs a check'}</h3></div><p>{watch.state.message}</p><a className="address" target="_blank" rel="noreferrer" href={`${network(selected.domain.chainId).blockExplorers.default.url}/tx/${watch.state.hash}`}>{watch.state.hash} ↗</a>{watch.state.status==='checking'?<button className="secondary" onClick={()=>watch.stop()}>Stop automatic checks</button>:watch.state.status!=='verified'&&watch.state.status!=='reverted'&&<button className="secondary" disabled={busy} onClick={()=>startWatch(selected,watch.state!.hash,watch.state!.payer)}>Check again</button>}<small>Read-only checks: up to 20 attempts within 60 seconds. The payment is never resent.</small></section>}
          <EvidencePanel request={selected} payments={currentPayments} scan={currentResult} failure={evidenceFailure}/>
          <div className="receipt-entry"><h3>Have a transaction hash?</h3><p>Recheck the transaction against this signed request.</p><div className="load-row"><input aria-label="Transaction hash" value={hash} onChange={e=>setHash(e.target.value)} placeholder="0x…" disabled={busy}/><button disabled={busy||!hash} onClick={()=>void run(verifyHash)}>Verify receipt</button></div>{knownHashes.length>0&&<select aria-label="Saved transaction hashes" value="" onChange={e=>setHash(e.target.value)}><option value="">Choose a saved hash — not yet trusted</option>{knownHashes.map(h=><option key={h} value={h}>{h}</option>)}</select>}</div>
          {currentPayments.map(p=><article key={p.hash+':'+p.logIndex} className="verified-receipt"><div><Icon name="shield" size={24}/><span><strong>Payment verified</strong><small>{p.late?'Received after the deadline':'Matched to the signed request'}</small></span><b>{money(p.amount)} USDC</b></div><dl><dt>Paid by</dt><dd className="address">{p.payer}</dd><dt>Received</dt><dd>{new Date(Number(p.timestamp)*1000).toLocaleString('en-US')}</dd><dt>Network fee</dt><dd>{formatUnits(BigInt(p.gasCostNative),18)} USDC</dd><dt>Block</dt><dd>{p.block}</dd></dl><a className="address" target="_blank" rel="noreferrer" href={`${network(selected.domain.chainId).blockExplorers.default.url}/tx/${p.hash}`}>{p.hash} ↗</a><div className="actions"><button className="secondary" onClick={()=>void run(()=>copy(requestLink(selected,location.origin,p.hash),'Verifiable receipt link copied.'))}><Icon name="link"/>Share receipt</button><button className="secondary" onClick={()=>window.print()}>Print receipt</button></div></article>)}
          <details className="technical-details"><summary>Evidence & verification scope</summary><p className="address">Request ID: {selected.requestId}</p><p>Lookup starts at block {selected.message.createdAtBlock}. {currentResult?.checkedThroughBlock?`Checked through ${currentResult.checkedThroughBlock}; target ${currentResult.targetBlock}.`:'No complete lookup range recorded in this session.'}</p><p>Signature verified against the payee. Payment verification checks the direct Memo transaction and matching USDC Transfer. Neither proves identity or service delivery.</p>{currentResult?.error&&<p className="field-error">{currentResult.error}</p>}{currentResult?.anomalies.map(a=><p key={a.hash} className="address">{a.hash}: {a.reason}</p>)}</details>
        </div></section>}
        {path==='/backups'&&<><section className="backup-grid"><article className="panel backup-card"><span className="section-symbol"><Icon name="archive" size={26}/></span><h2>Keep a complete backup</h2><div className="backup-status" aria-label="Backup reminder">{exportStatus?.error??`${exportStatus?.neverExported??0} requests not yet exported · ${exportStatus?.changed??0} updated since export`}{exportStatus?.lastExportedAt&&<small>Last download initiated {new Date(exportStatus.lastExportedAt).toLocaleString('en-US')}</small>}</div><p>Export the original signed requests and known transaction hashes. Restore them in another browser, then recheck the chain.</p><div className="file-format"><strong>JSON</strong><span>Full signed requests<small>{requests.length} records · all networks</small></span></div><button disabled={busy||!loaded||!requests.length} onClick={()=>void run(()=>exportRequests(requests,'payref-backup.json'))}><Icon name="download"/>Download backup</button></article><article className="panel backup-card"><span className="section-symbol"><Icon name="download" size={26}/></span><h2>Bring your records back</h2><p>Choose a PayRef JSON backup. Review signature validation results before merging records into this browser.</p><label className="upload-zone"><Icon name="plus" size={24}/><strong>Choose a JSON backup</strong><span>Up to 2 MiB · 1,000 requests</span><input aria-label="Import JSON backup" title="Choose a JSON backup" type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void run(()=>importFile(file));e.target.value='';}}/></label></article></section>
          <section className="panel restore-link"><div><Icon name="link" size={23}/><h2>Still have the payment link?</h2><p>Restore a single request from its original payment or receipt link. The signature is checked before import.</p></div><label className="sr-only" htmlFor="restore-link">Restore from a PayRef link</label><div className="load-row"><input id="restore-link" value={input} onChange={e=>setInput(e.target.value)} placeholder="Paste your original PayRef link…" disabled={busy}/><button className="secondary" disabled={busy||!input} onClick={()=>void run(restoreLink)}>Review request <Icon name="arrow"/></button></div></section>
          {preview&&<section className="panel import-preview"><div className="panel-heading"><div><p className="eyebrow">IMPORT PREVIEW</p><h2>{preview.entries.length} valid · {preview.errors.length} rejected</h2></div><button className="secondary" disabled={busy} onClick={()=>setPreview(undefined)}>Dismiss</button></div><p>Only validated requests will be merged. Existing records stay in place. Imported payment statuses are never trusted.</p><ul>{preview.entries.slice(0,10).map((entry,i)=><li key={i}>{entry.request.message.reference} · {money(entry.request.message.amount)} USDC · {network(entry.request.domain.chainId).name}</li>)}</ul>{preview.entries.length>10&&<p>And {preview.entries.length-10} more validated records.</p>}{preview.errors.map(e=><p className="field-error" key={e}>{e}</p>)}<button disabled={busy||!preview.entries.length} onClick={()=>void run(mergeImport)}>Import validated requests <Icon name="arrow"/></button></section>}
          <section className="panel export-card"><Icon name="list" size={28}/><div><h2>A spreadsheet for your reconciliation</h2><p>Export {network(chainId).name} records as CSV. Payments not verified in this session are explicitly marked. CSV cannot restore signed requests.</p></div><button className="secondary" disabled={busy||!loaded||!scoped.length} onClick={()=>download('payref-reconciliation.csv',exportCsv(scoped,payments),'text/csv;charset=utf-8')}><Icon name="download"/>Export CSV</button></section><div className="info-strip"><Icon name="shield"/><p>Records are saved for {location.origin} in this browser. Other site addresses (including localhost and 127.0.0.1) have separate storage. Connecting the same wallet will not restore those records. Use the original links or a JSON backup.</p></div></>}
        {path==='/activity'&&<section className="panel"><div className="panel-heading"><div><h2>Wallet activity <span className="count-pill">{localActivity.length}</span></h2><p>Local attempts on {network(chainId).name}. These are not a complete wallet transaction history.</p></div><Icon name="activity"/></div>{!loaded?<Empty title="Records unavailable">Resolve the storage error before reviewing wallet activity.</Empty>:!localActivity.length?<Empty icon="activity" title="No wallet attempts recorded">Payment attempts will appear here when you start a payment in this browser. Rejected and uncertain attempts remain visible.</Empty>:<div className="activity-list">{localActivity.map(a=><article key={a.id}><span className="row-icon"><Icon name={a.status==='CONFIRMED'?'check':unresolved(a.status)?'clock':'wallet'}/></span><div><strong>{requests.find(r=>r.request.requestId===a.requestId)?.request.message.reference??short(a.requestId)}</strong><p>{a.status.replaceAll('_',' ')} · {new Date(a.updatedAt).toLocaleString('en-US')}</p><small>Locally recorded status · use the original request to verify payment.</small>{a.hash&&<a className="address" href={`${network(a.chainId).blockExplorers.default.url}/tx/${a.hash}`} target="_blank" rel="noreferrer">{a.hash} ↗</a>}{a.replacementHash&&<p className="address">Replacement: {a.replacementHash}</p>}</div></article>)}</div>}</section>}
        {pending.length>0&&(path==='/activity'||publicPage)&&<section className="panel recovery-panel"><div className="panel-heading"><div><p className="eyebrow">ACTION REQUIRED</p><h2>Resolve before paying again</h2></div><Icon name="clock"/></div><p>Inspect the transaction in your wallet. A missing receipt does not mean no payment was sent.</p><label>Original or replacement transaction hash<input value={hash} onChange={e=>setHash(e.target.value)} aria-label="Recovery transaction hash" placeholder="0x…"/></label>{pending.map(a=><div className="attempt" key={a.id}><div><strong>{a.status.replaceAll('_',' ')}</strong><small>{short(a.requestId)} · {short(a.payer)}</small><small className="address">{a.hash??'No hash saved. Broadcast status is unknown.'}</small></div><button className="secondary" disabled={busy||(!a.hash&&!hash)} onClick={()=>void run(()=>recover(a))}>Check transaction</button></div>)}</section>}
        <footer><span><Icon name="shield" size={14}/>Signed by a wallet. Verified against the chain.</span><span>PayRef · Built on Arc</span></footer>
      </main>
    </div>
  </div>;
}
