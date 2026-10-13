import { useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { SignedRequest } from './protocol';
import type { VerifiedPayment } from './verification';
import { browserRepository, locked } from './storage';
import { errorText } from './errors';
import { watchPayment } from './payment-watch';

export async function persistVerifiedPayment(request:SignedRequest,payment:VerifiedPayment) {
  await locked('requests',()=>browserRepository().saveRequest(request,[payment.hash]));
  const repository=browserRepository();
  for(const attempt of repository.attempts()) {
    if(attempt.requestId===request.requestId&&attempt.chainId===request.domain.chainId&&attempt.hash?.toLowerCase()===payment.hash.toLowerCase()) {
      repository.saveAttempt({...attempt,status:'CONFIRMED',updatedAt:new Date().toISOString()});
    }
  }
}
interface WatchState {
  requestId:Hex; hash:Hex; payer:Address;
  status:'checking'|'verified'|'reverted'|'pending'|'rpc-error'|'evidence-mismatch'|'cancelled';
  message:string;
}
export function usePaymentWatch(callbacks:{onPayment:(request:SignedRequest,payment:VerifiedPayment)=>void;onError:(error:unknown,hash:Hex)=>void;onFinish:()=>void}) {
  const [state,setState]=useState<WatchState>();
  const active=useRef<AbortController|null>(null);
  const started=useRef(new Set<string>());
  const handlers=useRef(callbacks);handlers.current=callbacks;
  function stop(clear=false){active.current?.abort();if(clear){active.current=null;started.current.clear();setState(undefined);}}
  function dismiss(){active.current?.abort();active.current=null;setState(undefined);}
  function start(request:SignedRequest,hash:Hex,payer:Address){
    active.current?.abort();const controller=new AbortController();active.current=controller;
    started.current.add(`${request.domain.chainId}:${request.requestId}:${hash.toLowerCase()}`);
    const base={requestId:request.requestId,hash,payer};
    setState({...base,status:'checking',message:'Submitted. Checking the onchain receipt…'});
    void(async()=>{
      try{
        const result=await watchPayment(request,hash,{payer,signal:controller.signal,progress:message=>{if(active.current===controller)setState({...base,status:'checking',message});}});
        if(active.current!==controller)return;
        const messages={verified:'Payment verified against the signed request. Full lookup is still needed to check for duplicates.',reverted:'The matching transaction reverted. No payment was confirmed.',pending:'Waiting ended. This transaction is still unresolved. Check again or inspect it in your wallet.',cancelled:'Automatic checking stopped. The transaction remains recorded; stopping checks does not cancel a payment.','rpc-error':'The receipt could not be read. Payment status remains unresolved.','evidence-mismatch':'The transaction does not match this request. Review the verification details.'};
        setState({...base,status:result.status,message:messages[result.status]});
        if(result.status==='verified'&&result.payment){
          handlers.current.onPayment(request,result.payment);
          await persistVerifiedPayment(request,result.payment);
        }else if(result.status==='reverted'){
          const repository=browserRepository();
          for(const attempt of repository.attempts()){
            if(attempt.chainId===request.domain.chainId&&attempt.requestId===request.requestId&&attempt.hash?.toLowerCase()===hash.toLowerCase()&&attempt.payer.toLowerCase()===payer.toLowerCase())repository.saveAttempt({...attempt,status:'REVERTED',updatedAt:new Date().toISOString()});
          }
        }
        if('error' in result&&result.error&&result.status!=='pending'&&result.status!=='cancelled')handlers.current.onError(result.error,hash);
      }catch(error){
        if(active.current===controller){handlers.current.onError(error,hash);setState(s=>s?.status==='verified'?s:{...base,status:'rpc-error',message:errorText(error)});}
      }finally{if(active.current===controller){active.current=null;handlers.current.onFinish();}}
    })();
  }
  function hasStarted(request:SignedRequest,hash:Hex){return started.current.has(`${request.domain.chainId}:${request.requestId}:${hash.toLowerCase()}`);}
  return {state,start,stop,dismiss,hasStarted};
}
