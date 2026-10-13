// Read-only live testnet check. No wallet, private key or broadcast API is used.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { createPublicClient, http, erc20Abi, getAddress, formatUnits, keccak256, stringToHex } from 'viem';
const {values}=parseArgs({options:{payer:{type:'string'},payee:{type:'string'}}});
if(!values.payer||!values.payee) throw new Error('Usage: npm run check:rpc -- --payer 0x… --payee 0x…');
const payer=getAddress(values.payer),payee=getAddress(values.payee);
assert.notEqual(payer,payee,'Payer and payee must differ');
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
let stage='configuration';
try {
  const {TESTNET,USDC,MEMO,network,memoAbi}=await server.ssrLoadModule('/src/config.ts');
  const {createRequest,requestHash,paymentData}=await server.ssrLoadModule('/src/protocol.ts');
  const client=createPublicClient({chain:network(TESTNET),transport:http(network(TESTNET).rpcUrls.default.http[0],{retryCount:0,timeout:15000})});
  stage='chain';assert.equal(await client.getChainId(),TESTNET);
  stage='contracts';const [memoCode,decimals,block]=await Promise.all([client.getCode({address:MEMO}),client.readContract({address:USDC,abi:erc20Abi,functionName:'decimals'}),client.getBlock()]);
  assert.ok(memoCode&&memoCode!=='0x','Memo contract missing');assert.equal(decimals,6);
  stage='accounts';const accounts=[];
  for(const address of [payer,payee]) {
    const [code,native,erc20]=await Promise.all([client.getCode({address}),client.getBalance({address}),client.readContract({address:USDC,abi:erc20Abi,functionName:'balanceOf',args:[address]})]);
    assert.ok(!code||code==='0x',`Unsupported account: ${address}`);
    assert.equal(native/10n**12n,erc20,'ERC20 and native balance views disagree');
    accounts.push({address,ordinaryEoa:true,balanceUSDC:formatUnits(native,18)});
  }
  stage='simulation';
  const unsigned=createRequest({chainId:TESTNET,payee,amount:'0.01',reference:'READONLY-PROBE',description:'Unsigned simulation, not a payment or signed request',expiresAt:'0',block:block.number});
  const probe={...unsigned,requestId:requestHash(unsigned)};
  const gas=await client.estimateGas({account:payer,to:MEMO,data:paymentData(probe),value:0n});
  await client.call({account:payer,to:MEMO,data:paymentData(probe),value:0n,gas});
  stage='historical logs';
  const from=block.number>999n?block.number-999n:0n;
  const logs=await client.getLogs({address:MEMO,event:memoAbi[2],args:{memoId:keccak256(stringToHex('payref-readonly-query-probe'))},fromBlock:from,toBlock:block.number});
  console.log(JSON.stringify({scope:'LIVE_TESTNET_READ_AND_SIMULATION_ONLY',chainId:TESTNET,block:block.number.toString(),memoCodeBytes:(memoCode.length-2)/2,decimals,accounts,simulation:{amountUSDC:'0.01',estimatedGas:gas.toString(),call:'success',broadcast:false},query:{from:from.toString(),to:block.number.toString(),matches:logs.length},walletSignature:'NOT_RUN',paymentReceipt:'NOT_RUN'},null,2));
} catch(error) {
  console.error(JSON.stringify({stage,result:'FAILED',reason:error.shortMessage??error.message}));process.exitCode=1;
} finally {await server.close();}
