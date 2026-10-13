import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, isHex } from 'viem';
import type { Address, Hex } from 'viem';
import { checkNetwork, publicClient, read } from './chain';
import type { ArcClient } from './chain';
import { MEMO, USDC, memoAbi, network } from './config';
import { PayRefError } from './errors';
import type { SignedRequest } from './protocol';
import { verifyEvidence } from './verification';
import type { PaymentEvidence, VerifiedPayment } from './verification';

export type DiagnosisStatus = 'verified' | 'missing-memo' | 'amount-mismatch' | 'recipient-mismatch' | 'unsupported' | 'reverted' | 'pending' | 'rpc-error' | 'evidence-mismatch' | 'wrong-network' | 'cancelled';
export interface DiagnosticCheck {
  key: 'network' | 'transaction' | 'recipient' | 'amount' | 'memo';
  label: string; expected: string; observed: string; state: 'match' | 'mismatch' | 'unavailable';
}
export interface PaymentDiagnosis {
  requestId: Hex; hash: Hex; status: DiagnosisStatus; checks: DiagnosticCheck[];
  issues: { code: string; message: string }[];
  payment?: VerifiedPayment;
  error?: PayRefError;
}
export interface DiagnosePaymentOptions { client?: ArcClient; signal?: AbortSignal }

const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const amountLabel = (value: string | bigint) => {
  const [whole, fraction = ''] = formatUnits(BigInt(value), 6).split('.');
  return `${whole}.${fraction.padEnd(6, '0')} USDC`;
};
function notIncluded(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { name?: string; cause?: unknown };
    if (value.name === 'TransactionReceiptNotFoundError') return true;
    current = value.cause;
  }
  return false;
}
class DiagnosisCancelled extends Error {}

/** The caller must pass a request accepted by verifyRequest. This diagnostic never changes local payment state. */
export async function diagnosePayment(req: SignedRequest, hash: Hex, options: DiagnosePaymentOptions = {}): Promise<PaymentDiagnosis> {
  const context = { requestId: req.requestId, txHash: hash };
  let active = true;
  let actualChain: number | undefined;
  let transactionStatus: 'success' | 'reverted' | 'pending' | undefined;
  let observedTransfers: { from: Address; to: Address; amount: bigint }[] | undefined;
  let memoIds: Hex[] | undefined;
  const issues: PaymentDiagnosis['issues'] = [];
  const ensureActive = () => { if (!active || options.signal?.aborted) throw new DiagnosisCancelled(); };
  const failure = (code: string, message: string, cause?: unknown, stage?: string) => {
    const evidenceStage = stage ?? (cause instanceof PayRefError ? cause.context.evidenceStage ?? cause.stage : undefined);
    return new PayRefError(code, 'diagnosis', message,
      { ...(cause instanceof PayRefError ? cause.context : {}), ...context, ...(evidenceStage ? { evidenceStage } : {}) }, cause === undefined ? undefined : { cause });
  };
  const result = (status: DiagnosisStatus, error?: PayRefError, payment?: VerifiedPayment): PaymentDiagnosis => {
    const recipientMatch = observedTransfers?.length === 1 && same(observedTransfers[0].to, req.message.payee);
    const amountMatch = observedTransfers?.length === 1 && observedTransfers[0].amount === BigInt(req.message.amount);
    const memoMatch = memoIds?.length === 1 && same(memoIds[0], req.requestId);
    const checks: DiagnosticCheck[] = [
      { key: 'network', label: 'RPC network', expected: `${network(req.domain.chainId).name} (${req.domain.chainId})`, observed: actualChain === undefined ? 'Not observed' : `Chain ID ${actualChain}`, state: actualChain === undefined ? 'unavailable' : actualChain === req.domain.chainId ? 'match' : 'mismatch' },
      { key: 'transaction', label: 'Transaction result', expected: 'Included and successful', observed: transactionStatus === 'success' ? 'Included and successful' : transactionStatus === 'reverted' ? 'Included but reverted' : transactionStatus === 'pending' ? 'No included receipt found; status unresolved' : 'Not observed', state: transactionStatus === undefined || transactionStatus === 'pending' ? 'unavailable' : transactionStatus === 'success' ? 'match' : 'mismatch' },
      { key: 'recipient', label: 'USDC recipient', expected: req.message.payee, observed: observedTransfers === undefined ? 'Not observed' : observedTransfers.length ? observedTransfers.map(t => t.to).join(', ') : 'No trusted ERC-20 USDC Transfer found', state: observedTransfers === undefined ? 'unavailable' : recipientMatch ? 'match' : 'mismatch' },
      { key: 'amount', label: 'USDC amount (6 decimals)', expected: amountLabel(req.message.amount), observed: observedTransfers === undefined ? 'Not observed' : observedTransfers.length ? observedTransfers.map(t => amountLabel(t.amount)).join(', ') : 'No trusted ERC-20 USDC Transfer found', state: observedTransfers === undefined ? 'unavailable' : amountMatch ? 'match' : 'mismatch' },
      { key: 'memo', label: 'Memo request ID', expected: req.requestId, observed: memoIds === undefined ? 'Not observed' : memoIds.length ? memoIds.join(', ') : 'No trusted Memo event found', state: memoIds === undefined ? 'unavailable' : memoMatch ? 'match' : 'mismatch' },
    ];
    return { requestId: req.requestId, hash, status, checks, issues: [...issues], ...(payment ? { payment } : {}), ...(error ? { error } : {}) };
  };
  const inspect = async (): Promise<PaymentDiagnosis> => {
    ensureActive();
    if (!validHash(hash)) throw failure('INVALID_HASH', 'Enter a complete transaction hash.', undefined, 'transaction');
    const source = options.client ?? publicClient(req.domain.chainId);
    // Guard every actual read, including shared read() retries after an abort.
    const client = new Proxy(source, { get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        ensureActive();
        const answer: unknown = await Reflect.apply(value, target, args);
        ensureActive();
        if (key === 'getChainId' && typeof answer === 'number') actualChain = answer;
        return answer;
      };
    } });
    await checkNetwork(client, req.domain.chainId);
    ensureActive();
    let receipt: Awaited<ReturnType<ArcClient['getTransactionReceipt']>>;
    try { receipt = await read(() => client.getTransactionReceipt({ hash }), 'receipt'); }
    catch (cause) {
      ensureActive();
      if (!notIncluded(cause)) throw cause;
      transactionStatus = 'pending';
      return result('pending', failure('PAYMENT_UNRESOLVED', 'No included receipt was found. This does not prove the transaction was never sent or failed.', cause, 'receipt'));
    }
    ensureActive();
    const tx = await read(() => client.getTransaction({ hash }), 'transaction');
    ensureActive();
    const bind = (condition: unknown, message: string, stage = 'transaction') => {
      if (!condition) throw failure('EVIDENCE_MISMATCH', message, undefined, stage);
    };
    bind(same(tx.hash, hash) && same(receipt.transactionHash, hash), 'RPC transaction and receipt must match the requested hash.');
    bind(tx.chainId === undefined || tx.chainId === req.domain.chainId, 'Transaction chain ID does not match this request.', 'network');
    bind(tx.blockNumber !== null && tx.blockNumber === receipt.blockNumber, 'Transaction and receipt inclusion blocks do not match.');
    bind(validHash(tx.blockHash) && validHash(receipt.blockHash) && same(tx.blockHash, receipt.blockHash), 'Transaction and receipt block hashes do not match.');
    bind(isAddress(tx.from) && (tx.to === null || isAddress(tx.to)), 'Transaction addresses are malformed.');
    bind(receipt.status === 'success' || receipt.status === 'reverted', 'Unknown receipt status.');
    const block = await read(() => client.getBlock({ blockNumber: receipt.blockNumber }), 'block');
    ensureActive();
    bind(block.number === receipt.blockNumber && validHash(block.hash) && same(block.hash, receipt.blockHash), 'The returned block does not contain this receipt.', 'block');
    bind(typeof block.timestamp === 'bigint' && block.timestamp >= 0n, 'The returned block timestamp is invalid.', 'block');
    const senderCode = await read(() => client.getCode({ address: tx.from, blockNumber: receipt.blockNumber }), 'sender');
    ensureActive();
    bind(senderCode === undefined || isHex(senderCode, { strict: true }), 'The sender code response is malformed.', 'sender');
    const logs = receipt.logs.filter(log => same(log.address, USDC) || same(log.address, MEMO));
    const indexes = new Set<number>();
    for (const log of logs) {
      bind(same(log.transactionHash, hash) && log.blockNumber === receipt.blockNumber && same(log.blockHash, receipt.blockHash) && !log.removed,
        'A payment log belongs to different or removed chain evidence.', 'receipt');
      bind(log.logIndex !== null && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !indexes.has(log.logIndex), 'Payment log positions are missing or duplicated.', 'receipt');
      indexes.add(log.logIndex!);
    }
    // Facts below belong to the requested transaction on the expected RPC chain, not necessarily to the request.
    transactionStatus = receipt.status;
    const input: PaymentEvidence = { chainId: req.domain.chainId, transaction: tx, receipt, blockTimestamp: block.timestamp, senderCode: senderCode ?? '0x' };
    let verificationError: unknown;
    try {
      const payment = verifyEvidence(req, input);
      observedTransfers = [{ from: payment.payer, to: payment.payee, amount: BigInt(payment.amount) }];
      memoIds = [req.requestId];
      return result('verified', undefined, payment);
    } catch (cause) { verificationError = cause; }
    const verificationMessage = verificationError instanceof PayRefError ? verificationError.message : 'This transaction does not satisfy the signed payment request.';
    if (receipt.status === 'reverted') {
      issues.push({ code: 'TRANSACTION_REVERTED', message: 'This transaction reverted. It does not establish payment or identify a matching local attempt.' });
      return result('reverted', failure('PAYMENT_DIAGNOSIS_FAILED', verificationMessage, verificationError));
    }
    observedTransfers = [];
    memoIds = [];
    const decodingErrors: unknown[] = [];
    for (const log of logs) {
      try {
        if (same(log.address, USDC)) {
          const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
          if (event.eventName === 'Transfer') observedTransfers.push({ from: getAddress(event.args.from), to: getAddress(event.args.to), amount: event.args.value });
        } else {
          const event = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics, strict: true });
          if (event.eventName === 'Memo') memoIds.push(event.args.memoId);
        }
      } catch (cause) { issues.push({ code: 'UNREADABLE_EVENT', message: 'A trusted-contract event could not be decoded; its values are not used as payment facts.' }); decodingErrors.push(cause); }
    }
    const error = failure('PAYMENT_DIAGNOSIS_FAILED', verificationMessage, verificationError);
    if (decodingErrors.length) error.cause = new AggregateError([verificationError, ...decodingErrors], 'Payment verification and event decoding failed.');
    if (!memoIds.length) issues.push({ code: 'MISSING_MEMO', message: 'No trusted Memo event binds this transaction to the signed request.' });
    if (observedTransfers.length === 1 && !same(observedTransfers[0].to, req.message.payee)) issues.push({ code: 'RECIPIENT_MISMATCH', message: 'The observed USDC recipient differs from the requested recipient.' });
    if (observedTransfers.length === 1 && observedTransfers[0].amount !== BigInt(req.message.amount)) issues.push({ code: 'AMOUNT_MISMATCH', message: 'The observed 6-decimal USDC amount differs from the requested amount.' });
    if (memoIds.length && (memoIds.length !== 1 || !same(memoIds[0], req.requestId))) issues.push({ code: 'MEMO_MISMATCH', message: 'The observed Memo request ID does not uniquely match this request.' });
    let shape: 'memo' | 'direct' | 'unsupported' = 'unsupported';
    try {
      if (tx.value === 0n && (senderCode === undefined || senderCode === '0x') && !same(tx.from, req.message.payee)) {
        if (same(tx.to, USDC)) {
          const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.input });
          if (decoded.functionName === 'transfer' && same(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: decoded.args }), tx.input)) shape = 'direct';
        } else if (same(tx.to, MEMO)) {
          const decoded = decodeFunctionData({ abi: memoAbi, data: tx.input });
          const [target, data] = decoded.args;
          if (same(target, USDC) && same(encodeFunctionData({ abi: memoAbi, functionName: 'memo', args: decoded.args }), tx.input)) {
            const inner = decodeFunctionData({ abi: erc20Abi, data });
            if (inner.functionName === 'transfer' && same(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: inner.args }), data)) shape = 'memo';
          }
        }
      }
    } catch { /* Unknown calls are diagnostic-only, never successful payments. */ }
    if (logs.filter(log => same(log.address, MEMO)).length > 2 || observedTransfers.length > 1) shape = 'unsupported';
    if (shape === 'unsupported') {
      issues.push({ code: 'UNSUPPORTED_CALL', message: 'The transaction is not a supported ordinary-EOA USDC transfer or simple Memo transfer; multiple transfer or Memo frames are not supported.' });
      return result('unsupported', error);
    }
    if (shape === 'direct' || !memoIds.length) return result('missing-memo', error);
    if (issues.some(issue => issue.code === 'RECIPIENT_MISMATCH')) return result('recipient-mismatch', error);
    if (issues.some(issue => issue.code === 'AMOUNT_MISMATCH')) return result('amount-mismatch', error);
    return result('evidence-mismatch', error);
  };
  try {
    // Aborting releases the UI immediately; a late transport response cannot launch another read.
    return await new Promise<PaymentDiagnosis>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new DiagnosisCancelled()); return; }
      const abort = () => reject(new DiagnosisCancelled());
      options.signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(inspect).then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort));
    });
  } catch (cause) {
    if (cause instanceof DiagnosisCancelled || options.signal?.aborted) return result('cancelled', failure('DIAGNOSIS_CANCELLED', 'Diagnosis stopped. Payment state was not changed.', cause));
    if (cause instanceof PayRefError && cause.code === 'WRONG_RPC_CHAIN') return result('wrong-network', failure(cause.code, 'The RPC reports another network; no transaction evidence was accepted.', cause, 'network'));
    if (cause instanceof PayRefError && (cause.code === 'EVIDENCE_MISMATCH' || cause.code === 'INVALID_HASH')) return result('evidence-mismatch', cause);
    return result('rpc-error', failure('DIAGNOSIS_READ_FAILED', 'Could not complete chain reads. Payment status remains unresolved.', cause));
  } finally { active = false; }
}
