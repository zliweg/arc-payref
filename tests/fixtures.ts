// Synthetic fixtures only. This public test key must NEVER hold real funds.
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import type { Hex } from 'viem';
import { MAINNET, MARKER, MEMO, TESTNET, USDC, memoAbi } from '../src/config';
import { callHash, paymentData, requestHash, typedData } from '../src/protocol';
import type { SignedRequest, UnsignedRequest } from '../src/protocol';
import type { PaymentEvidence } from '../src/verification';
export const payee = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
export const payer = '0x2222222222222222222222222222222222222222' as const;
export const txHash = `0x${'ab'.repeat(32)}` as Hex;
export const otherHash = `0x${'cd'.repeat(32)}` as Hex;
export function unsigned(chainId: number = TESTNET): UnsignedRequest {
  return {schemaVersion:1,domain:{name:'Arc PayRef',version:'1',chainId},message:{payee:payee.address,token:USDC,memoContract:MEMO,amount:'10000',reference:'TEST-001',description:'Synthetic protocol test',expiresAt:'2000000000',nonce:`0x${'11'.repeat(32)}`,createdAtBlock:'100'}};
}
export async function signed(req=unsigned()): Promise<SignedRequest> {
  return {...req,requestId:requestHash(req),signature:await payee.signTypedData(typedData(req))};
}
export function evidence(req:SignedRequest,hash=txHash): PaymentEvidence {
  const common={transactionHash:hash};
  return {chainId:req.domain.chainId,transaction:{hash,from:payer,to:MEMO,input:paymentData(req),value:0n,blockNumber:101n},receipt:{transactionHash:hash,blockNumber:101n,status:'success',gasUsed:55000n,effectiveGasPrice:20000000000n,logs:[
    {...common,address:MEMO,logIndex:1,topics:encodeEventTopics({abi:memoAbi,eventName:'BeforeMemo',args:{memoIndex:7n}}) as Hex[],data:'0x'},
    {...common,address:USDC,logIndex:2,topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:payer,to:req.message.payee}}) as Hex[],data:encodeAbiParameters([{type:'uint256'}],[BigInt(req.message.amount)])},
    {...common,address:'0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',logIndex:0,topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:payer,to:req.message.payee}}) as Hex[],data:encodeAbiParameters([{type:'uint256'}],[BigInt(req.message.amount)*10n**12n])},
    {...common,address:MEMO,logIndex:3,topics:encodeEventTopics({abi:memoAbi,eventName:'Memo',args:{sender:payer,target:USDC,memoId:req.requestId}}) as Hex[],data:encodeAbiParameters([{type:'bytes32'},{type:'bytes'},{type:'uint256'}],[callHash(req),MARKER,7n])},
  ]},blockTimestamp:1900000000n,senderCode:'0x'};
}
// Enrich only transport tests with the provenance fields returned by an actual RPC.
// Pure verifyEvidence tests continue to use evidence() above.
export function rpcEvidence(req:SignedRequest,hash=txHash) {
  const input=evidence(req,hash),blockHash=`0x${'10'.repeat(32)}` as Hex;
  return {...input,transaction:{...input.transaction,chainId:req.domain.chainId,blockHash},
    receipt:{...input.receipt,blockHash,logs:input.receipt.logs.map(log=>({...log,blockNumber:input.receipt.blockNumber,blockHash,removed:false}))}};
}
export class MemoryStorage implements Storage {
  data=new Map<string,string>();
  get length(){return this.data.size;}
  clear(){this.data.clear();}
  getItem(k:string){return this.data.get(k)??null;}
  key(i:number){return [...this.data.keys()][i]??null;}
  removeItem(k:string){this.data.delete(k);}
  setItem(k:string,v:string){this.data.set(k,v);}
}
export const mainnetUnsigned=()=>unsigned(MAINNET);
