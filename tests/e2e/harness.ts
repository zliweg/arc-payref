// Test-only synthetic EIP-1193 wallet and Arc-shaped RPC. No real wallet or chain writes.
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { encodeFunctionData, erc20Abi, toHex } from 'viem';
import type { Hex } from 'viem';
import { MEMO, TESTNET, USDC } from '../../src/config';
import { requestHash, requestLink, verifyRequest } from '../../src/protocol';
import type { SignedRequest, UnsignedRequest } from '../../src/protocol';
import { evidence, payee, payer, signed, txHash } from '../fixtures';

export const origin = 'http://127.0.0.1:5188';
export const key = (r: SignedRequest) => `arc-payref:v1:request:${r.domain.chainId}:${r.requestId}`;
const blockHash = `0x${'10'.repeat(32)}`;
export async function harness(context: BrowserContext) {
  const state = {
    request: await signed(), account: payee.address as string, chain: TESTNET,
    accounts: undefined as string[] | undefined,
    permissionAccount: undefined as string | undefined, permissionError: 0,
    permissionEmitAccountChange: false, chainReadErrors: 0,
    permissionRequests: [] as unknown[][], signRequests: 0, signedBy: [] as string[],
    signError: 0, sendError: 0, sent: [] as Record<string, string>[], mined: false,
    sendDelay: 0, attemptsBeforeSend: [] as string[],
    duplicate: false, receiptMismatch: false, logError: false, logRateFailures: 0, logDelay: 0, logReads: 0, tip: 101,
    logGate: undefined as Promise<void> | undefined,
    balance: 20n * 10n ** 18n, baseFee: 20_000_000_000n, receiptReads: 0, unexpected: [] as string[],
    actualAmount: undefined as string | undefined, directTransfer: false,
  };
  await context.exposeBinding('__syntheticWallet', async ({page}, call: {method:string;params?:unknown[]}) => {
    switch (call.method) {
      case 'eth_requestAccounts': case 'eth_accounts': return {value:state.accounts??[state.account]};
      case 'wallet_requestPermissions':
        state.permissionRequests.push(call.params??[]);
        if(state.permissionError)return {error:{code:state.permissionError,message:'Synthetic account permission failure'}};
        // Selecting an unshared account inside the wallet does not change what
        // eth_accounts exposes until this explicit permission request succeeds.
        if(state.permissionAccount){state.account=state.permissionAccount;state.accounts=undefined;}
        if(state.permissionEmitAccountChange)await emitWalletEvent(page,'accountsChanged',state.accounts??[state.account]);
        return {value:[{parentCapability:'eth_accounts',caveats:[{type:'restrictReturnedAccounts',value:state.accounts??[state.account]}]}]};
      case 'eth_chainId':
        if(state.chainReadErrors>0){state.chainReadErrors--;return {error:{code:-32603,message:'Synthetic wallet chain read failed'}};}
        return {value:toHex(state.chain)};
      case 'wallet_switchEthereumChain': state.chain=Number(BigInt((call.params![0] as {chainId:Hex}).chainId)); return {value:null};
      case 'eth_signTypedData_v4': {
        state.signRequests++;
        state.signedBy.push(call.params![0] as string);
        if(state.signError)return {error:{code:state.signError,message:'Synthetic wallet rejection'}};
        const typed=JSON.parse(call.params![1] as string);
        const signature=await payee.signTypedData(typed);
        const request:UnsignedRequest={schemaVersion:1,domain:typed.domain,message:typed.message};
        state.request=await verifyRequest({...request,requestId:requestHash(request),signature});
        return {value:signature};
      }
      case 'eth_sendTransaction':
        state.attemptsBeforeSend=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('arc-payref:v1:attempt:')).map(([,v])=>JSON.parse(v).status));
        state.sent.push(call.params![0] as Record<string,string>);
        if(state.sendDelay)await new Promise(resolve=>setTimeout(resolve,state.sendDelay));
        if(state.sendError)return {error:{code:state.sendError,message:'Synthetic send failure'}};
        return {value:txHash};
      default: state.unexpected.push(call.method); throw new Error(`Unexpected wallet method: ${call.method}`);
    }
  });
  await context.addInitScript(() => {
    const w=window as unknown as {ethereum:unknown;__syntheticWallet:(arg:unknown)=>Promise<{value:unknown;error?:{code:number;message:string}}>;__emitSyntheticWalletEvent:(event:string,payload:unknown)=>void};
    const listeners=new Map<string,Set<(payload:unknown)=>void>>();
    w.__emitSyntheticWalletEvent=(event,payload)=>{for(const listener of listeners.get(event)??[])listener(payload);};
    w.ethereum={request:async(arg:unknown)=>{const result=await w.__syntheticWallet(arg);if(result.error)throw Object.assign(new Error(result.error.message),result.error);return result.value;},on:(event:string,listener:(payload:unknown)=>void)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(listener);},removeListener:(event:string,listener:(payload:unknown)=>void)=>{listeners.get(event)?.delete(listener);}};
  });
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.route('https://rpc.*.arc.io/**', async route => {
    const calls=route.request().postDataJSON();
    const rpc=async(call:{id:number;method:string;params:unknown[]})=>{
      const hash=(call.method==='eth_getTransactionByHash'||call.method==='eth_getTransactionReceipt'?call.params[0]:txHash) as Hex;
      // These alternate fixtures preserve mined receipt/log provenance. They are
      // intentionally invalid as payment for the signed request, not mock success.
      const actualRequest={...state.request,message:{...state.request.message,amount:state.actualAmount??state.request.message.amount}};
      const ev=evidence(actualRequest,hash);
      const logs=ev.receipt.logs.map(l=>({...l,logIndex:toHex(l.logIndex!),blockNumber:'0x65',blockHash,transactionIndex:'0x0',removed:false}));
      const transaction={...ev.transaction,blockNumber:'0x65',blockHash,nonce:'0x3',value:'0x0',gas:'0x10000',gasPrice:toHex(20_000_000_000n),transactionIndex:'0x0',type:'0x2',chainId:toHex(TESTNET),v:'0x0',r:txHash,s:txHash};
      if(state.directTransfer){transaction.to=USDC;transaction.input=encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[state.request.message.payee,BigInt(actualRequest.message.amount)]});}
      const block={number:toHex(state.tip),hash:blockHash,parentHash:blockHash,timestamp:toHex(BigInt(Math.floor(Date.now()/1000))),baseFeePerGas:toHex(state.baseFee),gasLimit:'0x1000000',gasUsed:'0x0',transactions:[],miner:payer,nonce:'0x0000000000000000',extraData:'0x',logsBloom:`0x${'00'.repeat(256)}`,difficulty:'0x0',size:'0x0'};
      let result:unknown;
      switch(call.method){
        case 'eth_chainId': result=toHex(TESTNET);break;
        case 'eth_blockNumber':result=toHex(state.tip);break;
        case 'eth_getBlockByNumber':result={...block,number:call.params[0]==='latest'?block.number:call.params[0]};break;
        case 'eth_getCode':result=String(call.params[0]).toLowerCase()===MEMO.toLowerCase()?'0x1234':'0x';break;
        case 'eth_getBalance':result=toHex(state.balance);break;
        case 'eth_call':result=toHex(6n,{size:32});break;
        case 'eth_estimateGas':result=toHex(55000);break;
        case 'eth_maxPriorityFeePerGas':result='0x0';break;
        case 'eth_gasPrice':result=toHex(20_000_000_000n);break;
        case 'eth_getTransactionCount':result='0x3';break;
        case 'eth_getLogs':
          state.logReads++;
          if(state.logRateFailures>0){state.logRateFailures--;return {id:call.id,jsonrpc:'2.0',error:{code:-32005,message:'Rate limit exceeded (synthetic HTTP 200 JSON-RPC response)'}};}
          result=state.mined&&!state.directTransfer?[logs[3]]:[];
          if(state.mined&&!state.directTransfer&&state.duplicate){const second=evidence(state.request,`0x${'cd'.repeat(32)}`);(result as unknown[]).push({...logs[3],transactionHash:second.transaction.hash});}
          if(state.logGate)await state.logGate;
          if(state.logDelay)await new Promise(resolve=>setTimeout(resolve,state.logDelay));
          if(state.logError)return {id:call.id,jsonrpc:'2.0',error:{code:-32602,message:'Synthetic query rejected'}};
          break;
        case 'eth_getTransactionByHash':result=state.mined?transaction:null;break;
        case 'eth_getTransactionReceipt':state.receiptReads++;result=state.mined?{transactionHash:hash,blockNumber:'0x65',blockHash,from:payer,to:state.directTransfer?USDC:MEMO,status:'0x1',gasUsed:toHex(ev.receipt.gasUsed),effectiveGasPrice:toHex(ev.receipt.effectiveGasPrice),cumulativeGasUsed:'0x10000',transactionIndex:'0x0',type:'0x2',contractAddress:null,logs:state.receiptMismatch||state.directTransfer?logs.filter(l=>l.address!==MEMO):logs,logsBloom:block.logsBloom}:null;break;
        default:state.unexpected.push(call.method);return {id:call.id,jsonrpc:'2.0',error:{code:-32601,message:`Unimplemented synthetic RPC: ${call.method}`}};
      }
      return {id:call.id,jsonrpc:'2.0',result};
    };
    await route.fulfill({json:Array.isArray(calls)?await Promise.all(calls.map(rpc)):await rpc(calls)});
  });
  return state;
}
export async function emitWalletEvent(page:Page,event:'accountsChanged'|'chainChanged',payload:unknown){
  await page.evaluate(({event,payload})=>{(window as unknown as {__emitSyntheticWalletEvent:(event:string,payload:unknown)=>void}).__emitSyntheticWalletEvent(event,payload);},{event,payload});
}
export async function connectWallet(page:Page){
  await page.locator('.wallet-menu > summary').click();
  // Synthetic scenarios explicitly select the fixture network; production defaults to mainnet.
  if(await page.getByLabel('Network',{exact:true}).isEnabled())await page.getByLabel('Network',{exact:true}).selectOption(String(TESTNET));
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Wallet connected');
  await page.locator('.wallet-menu > summary').click();
}
export async function loadPay(page:Page,req:SignedRequest){
  await page.goto(requestLink(req,origin));
  await expect(page.locator('.request-title')).toHaveText(req.message.reference);
}
export async function saved(page:Page){return page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('arc-payref:v1:request:')||k.startsWith('arc-payref:v1:attempt:')).map(([k,v])=>({key:k,...JSON.parse(v)})));}
export async function importRequests(page:Page, requests:SignedRequest[]){
  await openTestnetWorkspace(page,'/backups');
  await page.getByLabel('Import JSON backup').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,requests:requests.map(request=>({request,hashes:[]}))}))});
  await expect(page.getByRole('heading',{name:`${requests.length} valid · 0 rejected`})).toBeVisible();
  await page.getByRole('button',{name:'Import validated requests'}).click();
  await expect(page.getByRole('status')).toContainText(`Imported ${requests.length} requests`);
}

export async function navigateTo(page:Page,label:string){
  const menu=page.locator('.guest-navigation');if(await menu.count()&&(await menu.getAttribute('open'))===null)await menu.locator('summary').click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:label,exact:false}).click();
}
export async function preparePayment(page:Page){
  await page.getByRole('button',{name:'Check payment & fees',exact:true}).click();
  await expect(page.getByRole('region',{name:'Payment confirmation'})).toBeVisible();
}

// Explicit UI network selection for testnet fixtures; no production default override.
export async function openTestnetWorkspace(page:Page,path:string){
  await page.goto(path);
  await selectTestnetWorkspace(page);
}
export async function reloadTestnetWorkspace(page:Page){
  await page.reload();
  await selectTestnetWorkspace(page);
}
async function selectTestnetWorkspace(page:Page){
  const menu=page.locator('.wallet-menu');
  await menu.locator('summary').click();
  const network=page.getByLabel('Network',{exact:true});
  if(await network.isEnabled())await network.selectOption(String(TESTNET));
  await menu.locator('summary').click();
}
