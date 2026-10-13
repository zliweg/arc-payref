import { createPublicClient, http, erc20Abi, getAddress, isAddress, isHex, parseGwei } from 'viem';
import type { Address, Hex } from 'viem';
import { MEMO, USDC, memoAbi, network } from './config';
import { expired, paymentData, verifyRequest } from './protocol';
import type { SignedRequest } from './protocol';
import { verifyEvidence, mergePayments } from './verification';
import type { VerifiedPayment } from './verification';
import { PayRefError, errorText } from './errors';

export const publicClient = (id: number) => createPublicClient({ chain: network(id), transport: http(network(id).rpcUrls.default.http[0], { retryCount: 0, timeout: 15000 }) });
export type ArcClient = ReturnType<typeof publicClient>;
export interface ScanResult {
  complete: boolean; fromBlock: string; checkedThroughBlock: string | null; targetBlock: string;
  payments: VerifiedPayment[]; anomalies: { hash: Hex; reason: string }[]; error?: string;
}
type Progress = (message: string) => void;
function causes(error: unknown): string {
  let current = error; let result = '';
  for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
    const obj = current as Record<string, unknown>;
    result += ` ${obj.name ?? ''} ${obj.message ?? ''} ${obj.status ?? ''} ${obj.code ?? ''}`;
    current = obj.cause;
  }
  return result;
}
// Provider messages may contain URLs, calldata and signed links. Expose only
// classified reasons and numeric transport codes; retain the original cause on errors.
function readDetails(error: unknown): Record<string, string> {
  const details: Record<string, string> = {};
  const summary = causes(error);
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
    const item = current as Record<string, unknown>;
    if (typeof item.code === 'number' && Number.isSafeInteger(item.code)) details.rpcCode = String(item.code);
    if (typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599) details.httpStatus = String(item.status);
    current = item.cause;
  }
  details.reason = /block range|range.{0,30}(large|limit|exceed)|too many (results|blocks)|response size exceeded/i.test(summary) ? 'RANGE_LIMIT'
    : /429|rate limit|too many requests/i.test(summary) ? 'RATE_LIMIT'
    : /timeout|timed out/i.test(summary) ? 'TIMEOUT'
    : /\b5\d\d\b/.test(summary) ? 'HTTP_SERVER_ERROR'
    : /fetch failed|failed to fetch|network request failed/i.test(summary) ? 'NETWORK_ERROR'
    : /receipt.*not found|transaction.*not found/i.test(summary) ? 'NOT_FOUND'
    : /invalid params|invalid argument/i.test(summary) ? 'INVALID_PARAMS'
    : /permission denied|unauthori[sz]ed|forbidden/i.test(summary) ? 'ACCESS_DENIED'
    : details.rpcCode ? 'RPC_ERROR' : 'UNKNOWN_READ_ERROR';
  return details;
}
function retryAfter(error: unknown): number | null {
  let current = error;
  for (let i=0; i<8 && current && typeof current === 'object'; i++) {
    const obj = current as { headers?: Headers; cause?: unknown };
    const raw = obj.headers?.get?.('retry-after');
    if (raw) { const seconds = Number(raw); return Number.isFinite(seconds) ? Math.max(0,seconds*1000) : Math.max(0,Date.parse(raw)-Date.now()); }
    current = obj.cause;
  }
  return null;
}
export async function read<T>(operation: () => Promise<T>, stage: string, progress?: Progress): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { const value = await operation(); if (retry) progress?.(`${stage}: read succeeded after ${retry} retries`); return value; }
    catch (cause) {
      const summary = causes(cause);
      const details = readDetails(cause);
      // Some providers return JSON-RPC -32005 with a rate-limit message over
      // HTTP 200. The code alone is ambiguous (it can also mean a range limit).
      if (retry < 2 && (details.reason === 'RATE_LIMIT' || /\b5\d\d\b|timeout|timed out|fetch failed|failed to fetch|network request failed/i.test(summary))) {
        const delay = retryAfter(cause) ?? (retry+1)*(details.reason === 'RATE_LIMIT' ? 1000 : 500);
        if (delay <= 10000) { progress?.(`${stage}: read retry ${retry+1}/2 (${readDetails(cause).reason}, delay ${delay} ms)`); await new Promise(r => setTimeout(r,delay)); continue; }
      }
      throw new PayRefError('RPC_READ_FAILED', stage, 'RPC could not complete this read. Its result remains unknown.', { ...readDetails(cause), attempts: String(retry + 1), ...(retryAfter(cause) === null ? {} : { retryAfterMs: String(retryAfter(cause)) }) }, { cause });
    }
  }
}
export async function checkNetwork(client: ArcClient, id: number, progress?: Progress) {
  if (await read(() => client.getChainId(), 'network', progress) !== id) throw new PayRefError('WRONG_RPC_CHAIN', 'network', 'RPC reports the wrong chain.');
}
export async function checkEoa(client: ArcClient, account: Address) {
  const code = await read(() => client.getCode({ address: account }), 'account');
  if (code && code !== '0x') throw new PayRefError('UNSUPPORTED_ACCOUNT', 'account', 'Use an ordinary EOA without delegated code.');
}
export async function verifyPayment(req: SignedRequest, hash: Hex, client = publicClient(req.domain.chainId)): Promise<VerifiedPayment> {
  await verifyRequest(req);
  const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const bind = (condition: unknown, message: string, evidenceStage = 'transaction') => {
    if (!condition) throw new PayRefError('EVIDENCE_MISMATCH', 'receipt', message, { requestId: req.requestId, txHash: hash, evidenceStage });
  };
  bind(validHash(hash), 'Expected a complete transaction hash.');
  await checkNetwork(client, req.domain.chainId);
  const [transaction, receipt] = await Promise.all([
    read(() => client.getTransaction({ hash }), 'transaction'),
    read(() => client.getTransactionReceipt({ hash }), 'receipt'),
  ]);
  bind(same(transaction.hash, hash) && same(receipt.transactionHash, hash), 'RPC transaction and receipt must match the requested hash.');
  bind(transaction.chainId === undefined || transaction.chainId === req.domain.chainId, 'Transaction chain ID does not match the request.', 'network');
  bind(transaction.blockNumber !== null && transaction.blockNumber === receipt.blockNumber, 'Transaction and receipt inclusion blocks do not match.');
  bind(validHash(transaction.blockHash) && validHash(receipt.blockHash) && same(transaction.blockHash, receipt.blockHash), 'Transaction and receipt block hashes do not match.');
  bind(isAddress(transaction.from) && (transaction.to === null || isAddress(transaction.to)), 'Transaction addresses are malformed.');
  bind(receipt.status === 'success' || receipt.status === 'reverted', 'Unknown receipt status.');
  const [block, senderCode] = await Promise.all([
    read(() => client.getBlock({ blockNumber: receipt.blockNumber }), 'block'),
    read(() => client.getCode({ address: transaction.from, blockNumber: receipt.blockNumber }), 'sender'),
  ]);
  bind(block.number === receipt.blockNumber && validHash(block.hash) && same(block.hash, receipt.blockHash), 'The returned block does not contain this receipt.', 'block');
  bind(typeof block.timestamp === 'bigint' && block.timestamp >= 0n, 'The returned block timestamp is invalid.', 'block');
  bind(senderCode === undefined || isHex(senderCode, { strict: true }), 'The sender code response is malformed.', 'sender');
  const indexes = new Set<number>();
  for (const log of receipt.logs.filter(log => same(log.address, USDC) || same(log.address, MEMO))) {
    bind(same(log.transactionHash, hash) && log.blockNumber === receipt.blockNumber && same(log.blockHash, receipt.blockHash) && !log.removed, 'A payment log belongs to different or removed chain evidence.', 'receipt');
    bind(log.logIndex !== null && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !indexes.has(log.logIndex), 'Payment log positions are missing or duplicated.', 'receipt');
    indexes.add(log.logIndex!);
  }
  return verifyEvidence(req, { chainId: req.domain.chainId, transaction, receipt, blockTimestamp: block.timestamp, senderCode: senderCode ?? '0x' });
}
export async function scanRequest(req: SignedRequest, options: { signal?: AbortSignal; progress?: Progress; previous?: VerifiedPayment[]; client?: ArcClient } = {}): Promise<ScanResult> {
  const client = options.client ?? publicClient(req.domain.chainId);
  await verifyRequest(req);
  await checkNetwork(client, req.domain.chainId, options.progress);
  const tip = await read(() => client.getBlockNumber({ cacheTime: 0 }), 'scan', options.progress);
  let cursor = BigInt(req.message.createdAtBlock);
  const result: ScanResult = { complete: false, fromBlock: cursor.toString(), checkedThroughBlock: null, targetBlock: tip.toString(), payments: options.previous ?? [], anomalies: [] };
  if (cursor > tip) throw new PayRefError('FUTURE_BLOCK', 'scan', 'Request starts in a future block.');
  let size = 1000n, adjustments = 0;
  // Observed public-RPC throttling during sustained historical scans. This is
  // an application pacing policy, not a claim about the provider's quota.
  const interval = tip - cursor + 1n > 10000n ? 1100 : 0;
  let lastLogStart = -Infinity;
  const pacedLogs = async (end: bigint) => {
    const delay = Math.max(0, interval - (performance.now() - lastLogStart));
    if (delay > 0 && !options.signal?.aborted) {
      options.progress?.(`Pacing history lookup: blocks ${cursor}–${end} of ${tip}. Waiting before the next read.`);
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        options.signal?.addEventListener('abort', finish, { once: true });
      });
    }
    if (options.signal?.aborted) throw new PayRefError('SCAN_CANCELLED', 'scan', 'Scan cancelled. Verification is incomplete.');
    lastLogStart = performance.now();
    return client.getLogs({ address: MEMO, event: memoAbi[2], args: { memoId: req.requestId }, fromBlock: cursor, toBlock: end, strict: true });
  };
  const hashes = new Set<string>();
  while (cursor <= tip) {
    if (options.signal?.aborted) return { ...result, error: 'Scan cancelled. Verification is incomplete.' };
    const end = cursor + size - 1n < tip ? cursor + size - 1n : tip;
    options.progress?.(`Scanning blocks ${cursor}–${end} of ${tip}`);
    let verifyingHash: Hex | undefined;
    try {
      const logs = await read(() => pacedLogs(end), 'scan', options.progress);
      if (options.signal?.aborted) return { ...result, error: 'Scan cancelled. Verification is incomplete.' };
      for (const log of logs) {
        if (options.signal?.aborted) return { ...result, error: 'Scan cancelled. Verification is incomplete.' };
        if (!log.transactionHash || hashes.has(log.transactionHash)) continue;
        hashes.add(log.transactionHash);
        verifyingHash = log.transactionHash;
        try { result.payments = mergePayments(result.payments, [await verifyPayment(req, log.transactionHash, client)]); }
        catch (error) {
          if (error instanceof PayRefError && error.code === 'EVIDENCE_MISMATCH') result.anomalies.push({ hash: log.transactionHash, reason: error.message });
          else throw error;
        }
      }
      if (options.signal?.aborted) return { ...result, error: 'Scan cancelled. Verification is incomplete.' };
      result.checkedThroughBlock = end.toString();
      cursor = end + 1n;
    } catch (error) {
      if (options.signal?.aborted) return { ...result, error: 'Scan cancelled. Verification is incomplete.' };
      if (!verifyingHash && /block range|range.{0,30}(large|limit|exceed)|too many (results|blocks)|response size exceeded/i.test(causes(error)) && size > 1n && adjustments < 10) {
        size = size / 2n || 1n; adjustments++; options.progress?.(`Reducing query range to ${size} blocks (${adjustments}/10).`); continue;
      }
      const detail = error instanceof PayRefError ? error : new PayRefError('SCAN_READ_FAILED', 'scan', 'The range read failed.', readDetails(error), { cause: error });
      return { ...result, error: `Could not verify blocks ${cursor}–${end}. ${errorText(detail)} · chainId=${req.domain.chainId} requestId=${req.requestId}${verifyingHash ? ` txHash=${verifyingHash}` : ''}. Retry the read; do not assume unpaid.` };
    }
  }
  return { ...result, complete: true };
}
export interface Preflight { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; balance: bigint; nonce: number }
export async function preflight(req: SignedRequest, payer: Address, progress?: Progress, client = publicClient(req.domain.chainId)): Promise<Preflight> {
  await verifyRequest(req);
  if (getAddress(payer) === req.message.payee) throw new PayRefError('SELF_PAYMENT', 'preflight', 'Use a different payer account.');
  await checkNetwork(client, req.domain.chainId, progress);
  await checkEoa(client, payer);
  const [block, code, decimals, balance, fees, nonce] = await Promise.all([
    read(() => client.getBlock(), 'block'), read(() => client.getCode({ address: MEMO }), 'memo'),
    read(() => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }), 'usdc'),
    read(() => client.getBalance({ address: payer }), 'balance'),
    read(() => client.estimateFeesPerGas(), 'gas'),
    read(() => client.getTransactionCount({ address: payer, blockTag: 'pending' }), 'nonce'),
  ]);
  if (!code || code === '0x' || decimals !== 6) throw new PayRefError('NETWORK_CONFIG', 'preflight', 'Memo code or USDC precision does not match the application.');
  if (expired(req, block.timestamp)) throw new PayRefError('EXPIRED', 'preflight', 'This request has expired.');
  const rawGas = await read(() => client.estimateGas({ account: payer, to: MEMO, data: paymentData(req), value: 0n }), 'simulation', progress);
  const gas = (rawGas * 120n + 99n) / 100n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  const floor = parseGwei('20') + maxPriorityFeePerGas;
  const maxFeePerGas = fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor;
  if (balance < BigInt(req.message.amount) * 10n**12n + gas * maxFeePerGas) throw new PayRefError('INSUFFICIENT_BALANCE', 'preflight', 'USDC must cover both the payment and the maximum gas cost.');
  return { gas, maxFeePerGas, maxPriorityFeePerGas, balance, nonce };
}
