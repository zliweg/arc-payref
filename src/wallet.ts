import { createWalletClient, custom, formatUnits, getAddress, isAddress, toHex } from 'viem';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { MEMO, network } from './config';
import { PayRefError, rejected } from './errors';
import { createRequest, paymentData, requestHash, typedData, verifyRequest } from './protocol';
import type { SignedRequest } from './protocol';
import { checkEoa, checkNetwork, preflight, publicClient, read, scanRequest } from './chain';
import type { Preflight } from './chain';
import { browserRepository, locked, transactionHash, unresolved } from './storage';
import type { Attempt } from './storage';

export type Provider = EIP1193Provider & { on?: (event: string, listener: (...args: unknown[])=>void)=>void; removeListener?: (event:string,listener:(...args:unknown[])=>void)=>void };
export interface WalletOption { id: string; name: string; provider: Provider }
export interface PaymentReview extends Preflight {
  requestId: Hex; chainId: number; payer: Address; checkedThroughBlock: string;
  preparedAt: number; expiresAt: number;
}
const REVIEW_LIFETIME_MS = 120_000;

function unresolvedAttempt(req: SignedRequest) {
  const pending = browserRepository().attempts().find(a => a.chainId === req.domain.chainId && a.requestId === req.requestId && unresolved(a.status));
  if (pending) throw new PayRefError('UNRESOLVED_ATTEMPT', 'payment', 'Resolve the previous wallet attempt before paying again.', { requestId: req.requestId, attemptId: pending.id, ...(pending.hash ? { txHash: pending.hash } : {}) });
}
function checkReview(req: SignedRequest, payer: Address, review: PaymentReview) {
  if (!review || review.requestId !== req.requestId || review.chainId !== req.domain.chainId || getAddress(review.payer) !== getAddress(payer)) {
    throw new PayRefError('REVIEW_CHANGED', 'payment', 'The request, account or network no longer matches the payment review. Check the payment again.', { requestId: req.requestId });
  }
  const now = Date.now();
  if (!Number.isSafeInteger(review.preparedAt) || !Number.isSafeInteger(review.expiresAt) || review.preparedAt > now || review.expiresAt <= now || review.expiresAt - review.preparedAt > REVIEW_LIFETIME_MS) {
    throw new PayRefError('REVIEW_EXPIRED', 'payment', 'The payment review has expired. Check the payment again before opening your wallet.', { requestId: req.requestId });
  }
}
function checkCancelled(req: SignedRequest, signal?: AbortSignal) {
  if (signal?.aborted) throw new PayRefError('PAYMENT_CHECK_CANCELLED', 'preflight', 'Payment check cancelled. A new complete check is required.', { requestId: req.requestId });
}
async function checkUnpaid(req: SignedRequest, progress: (message: string) => void, signal?: AbortSignal) {
  const scan = await scanRequest(req, { progress, signal });
  checkCancelled(req, signal);
  if (!scan.complete || scan.checkedThroughBlock === null) throw new PayRefError('INCOMPLETE_SCAN', 'payment', 'Payment is blocked until the request range is fully checked.', { requestId: req.requestId });
  if (scan.payments.length) throw new PayRefError('ALREADY_PAID', 'payment', 'This request already has a verified payment.', { requestId: req.requestId });
  return scan.checkedThroughBlock;
}

/** Read-only preparation. It neither asks for a signature nor sends a transaction. */
export async function preparePayment(req: SignedRequest, provider: Provider, payer: Address, progress: (message: string) => void, signal?: AbortSignal): Promise<PaymentReview> {
  await verifyRequest(req);
  checkCancelled(req, signal);
  unresolvedAttempt(req);
  await currentAccount(provider, payer, req.domain.chainId);
  const checkedThroughBlock = await checkUnpaid(req, progress, signal);
  progress('Simulating payment and checking USDC + gas…');
  const check = await preflight(req, payer, progress);
  checkCancelled(req, signal);
  await currentAccount(provider, payer, req.domain.chainId);
  unresolvedAttempt(req);
  const preparedAt = Date.now();
  return { ...check, requestId: req.requestId, chainId: req.domain.chainId, payer: getAddress(payer), checkedThroughBlock, preparedAt, expiresAt: preparedAt + REVIEW_LIFETIME_MS };
}
export async function connect(provider: Provider): Promise<Address> {
  const accounts=await provider.request({method:'eth_requestAccounts'});
  if (!accounts[0]) throw new PayRefError('NO_ACCOUNT','wallet','No wallet account was connected.');
  return getAddress(accounts[0]);
}
/** Read the site's permitted accounts without opening permissions or selecting one. */
export async function connectedAccounts(provider: Provider): Promise<Address[]> {
  let value:unknown;
  try { value=await provider.request({method:'eth_accounts'}); }
  catch(cause) { throw new PayRefError('ACCOUNTS_READ_FAILED','wallet','Connected accounts could not be read. Reconnect before signing.',{},{cause}); }
  if(!Array.isArray(value)) throw new PayRefError('INVALID_ACCOUNTS','wallet','The wallet returned an invalid account list. Reconnect before signing.');
  const accounts:Address[]=[];
  for(let index=0;index<value.length;index++) {
    const entry:unknown=value[index];
    if(typeof entry!=='string'||!isAddress(entry)) throw new PayRefError('INVALID_ACCOUNT','wallet','The wallet returned an invalid account address. Reconnect before signing.',{accountIndex:String(index)});
    const account=getAddress(entry);
    if(!accounts.includes(account))accounts.push(account);
  }
  return accounts;
}
/** Explicit account selection only; ordinary reconnect must not replace site permissions. */
export async function switchAccount(provider: Provider): Promise<Address> {
  try { await provider.request({method:'wallet_requestPermissions',params:[{eth_accounts:{}}]}); }
  catch(cause) {
    const code=(cause as {code?:unknown})?.code;
    const context:Record<string,string>=typeof code==='number'?{rpcCode:String(code)}:{};
    if(rejected(cause)) throw new PayRefError('USER_REJECTED','wallet','Account selection was rejected. No new account was connected.',context,{cause});
    if(code===4100) throw new PayRefError('ACCOUNT_PERMISSION_DENIED','wallet','Account access was not granted. Check this site’s connected accounts in your wallet.',context,{cause});
    if(code===-32601||code===4200) throw new PayRefError('ACCOUNT_SELECTION_UNSUPPORTED','wallet','This wallet does not support account selection from the app. Change this site’s connected account in your wallet, then reconnect.',context,{cause});
    if(code===-32002) throw new PayRefError('ACCOUNT_SELECTION_PENDING','wallet','An account selection request is already open in your wallet. Complete it before trying again.',context,{cause});
    throw new PayRefError('ACCOUNT_SELECTION_FAILED','wallet','The wallet could not open account selection. Check this site’s connection permissions in your wallet.',context,{cause});
  }
  const accounts=await connectedAccounts(provider);
  if(!accounts[0]) throw new PayRefError('NO_ACCOUNT','wallet','No account is connected to this site. Select an account in your wallet, then reconnect.');
  return accounts[0];
}
export async function currentAccount(provider: Provider, expected: Address, chainId: number) {
  const accounts=await connectedAccounts(provider);
  const chain=await provider.request({method:'eth_chainId'});
  if(!accounts.includes(getAddress(expected)) || BigInt(chain)!==BigInt(chainId)) throw new PayRefError('WALLET_CHANGED','wallet','The selected account is no longer connected or the network changed. Reconnect on the correct network and start again.');
}
export async function switchNetwork(provider: Provider, id: number) {
  const chain=network(id);
  try { await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:toHex(id)}]}); }
  catch(error) {
    if((error as {code?:number})?.code!==4902) throw error;
    await provider.request({method:'wallet_addEthereumChain',params:[{chainId:toHex(id),chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:[...chain.rpcUrls.default.http],blockExplorerUrls:[chain.blockExplorers.default.url]}]});
  }
}
export async function signRequest(provider:Provider, account:Address, input:{chainId:number;amount:string;reference:string;description:string;expiresAt:string}):Promise<SignedRequest> {
  await currentAccount(provider,account,input.chainId);
  const client=publicClient(input.chainId);
  await checkNetwork(client,input.chainId); await checkEoa(client,account);
  const block=await read(()=>client.getBlock(),'create');
  if(input.expiresAt!=='0' && BigInt(input.expiresAt)<=block.timestamp) throw new PayRefError('EXPIRED','create','Choose a future deadline.');
  const req=createRequest({...input,payee:account,block:block.number});
  await currentAccount(provider,account,input.chainId);
  const wallet=createWalletClient({chain:network(input.chainId),transport:custom(provider,{retryCount:0})});
  const signature=await wallet.signTypedData({account,...typedData(req)});
  return verifyRequest({...req,requestId:requestHash(req),signature});
}
export async function sendPayment(req:SignedRequest,provider:Provider,payer:Address,progress:(message:string)=>void,review:PaymentReview,signal?:AbortSignal):Promise<Hex> {
  checkCancelled(req,signal);
  return locked(`payer:${req.domain.chainId}:${payer.toLowerCase()}`,()=>locked(`payment:${req.domain.chainId}:${req.requestId}`,async()=>{
    checkCancelled(req,signal);
    const repository=browserRepository();
    unresolvedAttempt(req);
    await verifyRequest(req);
    checkCancelled(req,signal);
    checkReview(req, payer, review);
    await currentAccount(provider,payer,req.domain.chainId);
    checkCancelled(req,signal);
    await checkUnpaid(req, progress, signal);
    progress('Simulating payment and checking USDC + gas…');
    checkCancelled(req,signal);
    const check=await preflight(req,payer,progress);
    checkCancelled(req,signal);
    await currentAccount(provider,payer,req.domain.chainId);
    checkCancelled(req,signal);
    checkReview(req, payer, review);
    if (check.nonce !== review.nonce) throw new PayRefError('REVIEW_NONCE_CHANGED', 'payment', 'The account transaction count changed. Check the payment again before sending.', { requestId: req.requestId });
    if (check.gas > review.gas || check.maxFeePerGas > review.maxFeePerGas || check.maxPriorityFeePerGas > review.maxPriorityFeePerGas) throw new PayRefError('REVIEW_FEES_CHANGED', 'payment', 'The latest gas limit or fee exceeds the reviewed maximum. Check the payment again to review the new cost.', { requestId: req.requestId });
    await locked('requests',()=>repository.saveRequest(req));
    checkCancelled(req,signal);
    await currentAccount(provider,payer,req.domain.chainId);
    checkCancelled(req,signal);
    checkReview(req,payer,review);
    progress(`Estimated maximum gas: ${formatUnits(check.gas * check.maxFeePerGas,18)} USDC. Review the payment in your wallet.`);
    checkCancelled(req,signal);
    // Commit the attempt and invoke the wallet in one synchronous segment. No navigation event
    // can interrupt this segment; once the wallet is invoked its result must still be saved.
    const attempt:Attempt={version:1,id:crypto.randomUUID(),requestId:req.requestId,chainId:req.domain.chainId,payer,status:'AWAITING_SIGNATURE',nonce:check.nonce,updatedAt:new Date().toISOString()};
    checkCancelled(req,signal);
    repository.saveAttempt(attempt);
    let hash:Hex;
    try {
      hash=transactionHash(await provider.request({method:'eth_sendTransaction',params:[{from:payer,to:MEMO,data:paymentData(req),value:'0x0',nonce:toHex(check.nonce),chainId:toHex(req.domain.chainId),gas:toHex(check.gas),maxFeePerGas:toHex(check.maxFeePerGas),maxPriorityFeePerGas:toHex(check.maxPriorityFeePerGas)}]}));
    } catch(cause) {
      const isRejected=rejected(cause);
      repository.saveAttempt({...attempt,status:isRejected?'REJECTED':'UNKNOWN',errorCode:isRejected?'USER_REJECTED':'BROADCAST_UNKNOWN',updatedAt:new Date().toISOString()});
      throw new PayRefError(isRejected?'USER_REJECTED':'BROADCAST_UNKNOWN','payment',isRejected?'Wallet request rejected. No payment success recorded.':'Wallet result is uncertain. Do not submit again; inspect the wallet and recover the transaction hash.',{attemptId:attempt.id},{cause});
    }
    // A failure here must retain the already-sent hash in the displayed error.
    try { repository.saveAttempt({...attempt,status:'SUBMITTED',hash,updatedAt:new Date().toISOString()});
      await locked('requests',()=>repository.saveRequest(req,[hash])); }
    catch(cause) { throw new PayRefError('SENT_NOT_SAVED','payment','Transaction was submitted but could not be fully saved. Keep this hash; do not send again.',{txHash:hash,attemptId:attempt.id},{cause}); }
    return hash;
  }));
}
