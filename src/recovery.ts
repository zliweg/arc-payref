import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { checkNetwork, publicClient, read, verifyPayment } from './chain';
import type { ArcClient } from './chain';
import { PayRefError } from './errors';
import type { SignedRequest } from './protocol';
import { verifyRequest } from './protocol';
import type { Attempt } from './storage';
import type { VerifiedPayment } from './verification';

// A supplied replacement is evidence only after inclusion with the same sender and nonce.
export async function recoverAttempt(req: SignedRequest, attempt: Attempt, hash: Hex, client: ArcClient = publicClient(attempt.chainId)): Promise<{ attempt: Attempt; payment?: VerifiedPayment }> {
  await verifyRequest(req);
  if(req.requestId!==attempt.requestId || req.domain.chainId!==attempt.chainId) throw new PayRefError('WRONG_REQUEST','recovery','Restore the signed request matching this attempt.',{attemptId:attempt.id});
  await checkNetwork(client,attempt.chainId);
  const [tx,receipt]=await Promise.all([
    read(()=>client.getTransaction({hash}),'recovery'),read(()=>client.getTransactionReceipt({hash}),'recovery'),
  ]);
  if(getAddress(tx.from)!==getAddress(attempt.payer) || tx.blockNumber===null || tx.blockNumber!==receipt.blockNumber || tx.hash.toLowerCase()!==hash.toLowerCase() || receipt.transactionHash.toLowerCase()!==hash.toLowerCase()) throw new PayRefError('WRONG_ATTEMPT','recovery','Transaction does not match this included payment attempt.',{attemptId:attempt.id,txHash:hash});
  if(attempt.hash?.toLowerCase()!==hash.toLowerCase() && tx.nonce!==attempt.nonce) throw new PayRefError('WRONG_NONCE','recovery','Replacement must consume the recorded sender nonce.',{attemptId:attempt.id,txHash:hash});
  const replacing=Boolean(attempt.hash && attempt.hash.toLowerCase()!==hash.toLowerCase());
  if(replacing && attempt.hash) {
    const original=await read(()=>client.getTransaction({hash:attempt.hash!}),'original-transaction');
    if(original.hash.toLowerCase()!==attempt.hash.toLowerCase() || getAddress(original.from)!==getAddress(attempt.payer) || original.nonce!==tx.nonce) throw new PayRefError('WRONG_REPLACEMENT','recovery','Cannot establish that this transaction replaces the original wallet transaction.',{attemptId:attempt.id,txHash:hash});
  }
  const updated:Attempt={...attempt,...(replacing?{replacementHash:hash}:{hash}),updatedAt:new Date().toISOString()};
  if(receipt.status==='reverted') return {attempt:{...updated,status:'REVERTED'}};
  try { const payment=await verifyPayment(req,hash,client);return {attempt:{...updated,status:'CONFIRMED'},payment}; }
  catch(error) {
    // A known original with mismatched payment evidence remains unresolved for investigation.
    if(error instanceof PayRefError && error.code==='EVIDENCE_MISMATCH' && replacing) return {attempt:{...updated,status:'REPLACED',errorCode:'NONCE_CONSUMED_NO_MATCH'}};
    throw error;
  }
}
