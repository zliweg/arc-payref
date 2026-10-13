import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { checkNetwork, publicClient, read, verifyPayment } from './chain';
import type { ArcClient } from './chain';
import { MEMO } from './config';
import { PayRefError } from './errors';
import { paymentData, verifyRequest } from './protocol';
import type { SignedRequest } from './protocol';
import { transactionHash } from './storage';
import type { EvidenceStage, VerifiedPayment } from './verification';

const MAX_CHECKS = 20;
const MAX_DURATION_MS = 60_000;
const INTERVAL_MS = 3_000;
type Terminal = { status: 'verified'; payment: VerifiedPayment } | { status: 'reverted'; error: PayRefError };
export type PaymentWatchResult = (Terminal | { status: 'pending' | 'rpc-error' | 'evidence-mismatch' | 'cancelled'; error: PayRefError }) & { attempts: number };
export interface PaymentWatchOptions {
  payer: Address; signal?: AbortSignal; progress?: (message: string) => void; client?: ArcClient;
}
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
function notIncluded(error: unknown): boolean {
  let current = error;
  for (let n = 0; n < 8 && current && typeof current === 'object'; n++) {
    const value = current as { name?: string; cause?: unknown };
    if (value.name === 'TransactionNotFoundError' || value.name === 'TransactionReceiptNotFoundError') return true;
    current = value.cause;
  }
  return false;
}
class WatchStopped extends Error {
  constructor(public reason: 'cancelled' | 'deadline') { super(reason); }
}

/** Stop waiting even when an RPC transport is still in flight. Late results cannot settle this promise. */
function bounded<T>(operation: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new WatchStopped('cancelled')); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new WatchStopped('deadline')); return; }
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const stop = (error: unknown) => { if (!finished) { finished = true; cleanup(); reject(error); } };
    const abort = () => stop(new WatchStopped('cancelled'));
    timer = setTimeout(() => stop(new WatchStopped('deadline')), remaining);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => {
      if (!finished) { finished = true; cleanup(); resolve(value); }
    }, stop);
  });
}
function pause(deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WatchStopped('cancelled')); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new WatchStopped('deadline')); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new WatchStopped('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.min(INTERVAL_MS, remaining));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Watches one existing hash using bounded reads. This module never sends transactions or edits attempts.
 * A failed transaction is attributed to an attempt only after its hash, payer and exact request call match.
 */
export async function watchPayment(req: SignedRequest, inputHash: Hex, options: PaymentWatchOptions): Promise<PaymentWatchResult> {
  const hash = transactionHash(inputHash);
  const payer = getAddress(options.payer);
  const sourceClient = options.client ?? publicClient(req.domain.chainId);
  const deadline = Date.now() + MAX_DURATION_MS;
  const context = { requestId: req.requestId, txHash: hash };
  let attempts = 0;
  let active = true;
  let requestChecked = false;
  const error = (code: string, message: string, cause?: unknown, stage?: EvidenceStage) => {
    const evidenceStage = stage ?? (cause instanceof PayRefError ? cause.context.evidenceStage : undefined);
    return new PayRefError(code, 'payment-watch', message, { ...context, ...(evidenceStage ? { evidenceStage } : {}) }, cause === undefined ? undefined : { cause });
  };
  const pending = () => ({ status: 'pending' as const, attempts, error: error('PAYMENT_PENDING', 'The bounded confirmation check ended without verified inclusion. This payment remains unresolved; do not send it again.') });
  const progress = (message: string) => { if (active && !options.signal?.aborted && Date.now() < deadline) options.progress?.(message); };
  const ensureActive = () => {
    if (!active || options.signal?.aborted) throw new WatchStopped('cancelled');
    if (Date.now() >= deadline) throw new WatchStopped('deadline');
  };
  // The shared verifier performs bounded retries. Guard every actual RPC invocation so a late
  // transport result cannot start another read or retry after this watch has been stopped.
  const client = new Proxy(sourceClient, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? (...args: unknown[]) => { ensureActive(); return Reflect.apply(value, target, args); } : value;
    },
  });
  const inspect = async (): Promise<Terminal> => {
    // A missing receipt is the usual pending case: do not issue transaction or block queries yet.
    const receipt = await read(() => client.getTransactionReceipt({ hash }), 'receipt', progress);
    ensureActive();
    const tx = await read(() => client.getTransaction({ hash }), 'transaction', progress);
    ensureActive();
    const mismatch = (condition: unknown, message: string) => {
      if (!condition) throw error('EVIDENCE_MISMATCH', message, undefined, 'transaction');
    };
    mismatch(same(tx.hash, hash) && same(receipt.transactionHash, hash), 'RPC returned evidence for a different transaction hash.');
    mismatch(tx.blockNumber !== null && tx.blockNumber === receipt.blockNumber && receipt.blockNumber >= BigInt(req.message.createdAtBlock), 'Transaction and receipt do not describe the same included payment.');
    mismatch(same(tx.from, payer) && !same(payer, req.message.payee), 'The transaction sender does not match this payment attempt.');
    mismatch(same(tx.to, MEMO) && tx.value === 0n && same(tx.input, paymentData(req)), 'The transaction target, value or call does not match the signed request.');
    const senderCode = await read(() => client.getCode({ address: tx.from, blockNumber: receipt.blockNumber }), 'sender', progress);
    ensureActive();
    mismatch(!senderCode || senderCode === '0x', 'Only a direct payment from an ordinary EOA is supported.');
    if (receipt.status === 'reverted') return { status: 'reverted', error: error('TRANSACTION_REVERTED', 'The matching payment transaction was included but reverted. No successful payment is recorded for this transaction.') };
    const payment = await verifyPayment(req, hash, client);
    ensureActive();
    mismatch(same(payment.hash, hash) && same(payment.payer, payer) && payment.requestId === req.requestId && payment.chainId === req.domain.chainId, 'The verified receipt does not match this payment attempt.');
    return { status: 'verified', payment };
  };
  try {
    await bounded(async () => {
      await verifyRequest(req);
      requestChecked = true;
      ensureActive();
      await checkNetwork(client, req.domain.chainId, progress);
    }, deadline, options.signal);
    while (attempts < MAX_CHECKS && Date.now() < deadline) {
      ensureActive();
      attempts++;
      progress(`Checking submitted payment (${attempts}/${MAX_CHECKS})…`);
      try {
        const result = await bounded(inspect, deadline, options.signal);
        return { ...result, attempts };
      } catch (cause) {
        if (!notIncluded(cause)) throw cause;
        progress(`No included receipt yet (${attempts}/${MAX_CHECKS}). The payment remains pending.`);
      }
      if (attempts < MAX_CHECKS) await pause(deadline, options.signal);
    }
    return pending();
  } catch (cause) {
    if (cause instanceof WatchStopped || options.signal?.aborted || Date.now() >= deadline) {
      return options.signal?.aborted || (cause instanceof WatchStopped && cause.reason === 'cancelled')
        ? { status: 'cancelled', attempts, error: error('PAYMENT_WATCH_CANCELLED', 'Confirmation checking stopped. The submitted payment remains unresolved until its evidence is verified.') }
        : pending();
    }
    if (!requestChecked) return { status: 'evidence-mismatch', attempts, error: error('INVALID_REQUEST', 'The original signed request could not be verified. No payment status can be established.', cause) };
    if (cause instanceof PayRefError && (cause.code === 'EVIDENCE_MISMATCH' || cause.code === 'WRONG_RPC_CHAIN')) return { status: 'evidence-mismatch', attempts, error: error(cause.code, cause.message, cause, cause.code === 'WRONG_RPC_CHAIN' ? 'network' : undefined) };
    return { status: 'rpc-error', attempts, error: error('PAYMENT_WATCH_READ_FAILED', 'Could not complete receipt verification. The payment remains unresolved; retry the read or inspect the wallet.', cause) };
  } finally { active = false; }
}
