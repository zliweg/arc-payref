import type { Hex } from 'viem';
import { scanRequest, verifyPayment } from './chain';
import type { ScanResult } from './chain';
import { network } from './config';
import { errorText, PayRefError } from './errors';
import { address, byteLength, record, uint, verifyRequest } from './protocol';
import type { SignedRequest } from './protocol';
import { validateReceivable } from './receivables';
import type { Receivable } from './receivables';
import { transactionHash } from './storage';
import { mergePayments } from './verification';
import type { VerifiedPayment } from './verification';

export const HANDOFF_LIMITS = { records: 100, bytes: 2 * 1024 * 1024, hashes: 100, evidence: 100 } as const;
export const HANDOFF_VERIFIER_VERSION = 'arc-payref-v1/1';
export interface HandoffSnapshot { capturedAt: string; payments: VerifiedPayment[]; scan: ScanResult | null; note: string }
export interface HandoffRecordInput {
  request: SignedRequest | null; receivable?: Receivable | null; hashes: Hex[]; snapshot?: HandoffSnapshot | null;
}
export interface ThreeWayComparison {
  businessAmount: string | null; signedAmount: string | null; verifiedAmount: string; paymentCount: number;
  referenceMatches: boolean | null; amountMatches: boolean | null; networkMatches: boolean | null;
  requestMatches: boolean | null; coverage: 'not-run' | 'incomplete' | 'complete';
}
export interface HandoffRecord extends HandoffRecordInput {
  recordKey: string; receivable: Receivable | null; snapshot: HandoffSnapshot | null; comparison: ThreeWayComparison;
}
export interface HandoffPackage {
  type: 'arc-payref-handoff'; version: 1; createdAt: string; verifierVersion: string; records: HandoffRecord[];
}
export interface HandoffFailure { stage: string; code: string; message: string; hash?: Hex }
export interface HandoffHashCheck { hash: Hex; status: 'verified' | 'failed'; payment?: VerifiedPayment; error?: HandoffFailure }
export interface HandoffRecordResult {
  recordKey: string; requestId: Hex | null; chainId: number; state: 'not-run' | 'checking' | 'finished' | 'cancelled';
  hashChecks: HandoffHashCheck[]; payments: VerifiedPayment[]; scan: ScanResult | null; errors: HandoffFailure[];
  comparison: ThreeWayComparison; verifiedAt: string | null;
}
export interface HandoffVerification {
  mode: 'hashes' | 'scan'; startedAt: string; finishedAt: string; cancelled: boolean; records: HandoffRecordResult[];
}
export interface HandoffProgress { index: number; total: number; recordKey: string; message: string }
export interface HandoffVerificationOptions {
  mode?: 'hashes' | 'scan'; signal?: AbortSignal;
  onResult?: (result: HandoffRecordResult) => void; onProgress?: (progress: HandoffProgress) => void;
}

function invalid(message: string): never { throw new PayRefError('INVALID_HANDOFF', 'handoff', message); }
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('Unexpected or missing handoff fields.');
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('Expected a UTC ISO timestamp.');
  return value;
}
function boundedText(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || byteLength(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid('Invalid or oversized handoff text.');
  return value;
}
function boundedList(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`Expected an array with at most ${max} entries.`);
  return value;
}
function hashes(value: unknown): Hex[] {
  const list = boundedList(value, HANDOFF_LIMITS.hashes).map(item => transactionHash(item).toLowerCase() as Hex);
  if (new Set(list).size !== list.length) invalid('Duplicate transaction hashes in a record.');
  return list;
}
function historicalPayment(value: unknown): VerifiedPayment {
  const p = record(value);
  fields(p, ['chainId', 'requestId', 'hash', 'logIndex', 'block', 'payer', 'payee', 'amount', 'timestamp', 'gasCostNative', 'late']);
  if (typeof p.chainId !== 'number') invalid('Invalid historical payment network.');
  network(p.chainId);
  if (typeof p.logIndex !== 'number' || !Number.isSafeInteger(p.logIndex) || p.logIndex < 0 || typeof p.late !== 'boolean') invalid('Invalid historical payment fields.');
  return { chainId: p.chainId, requestId: transactionHash(p.requestId), hash: transactionHash(p.hash), logIndex: p.logIndex,
    block: uint(p.block), payer: address(p.payer), payee: address(p.payee), amount: uint(p.amount, true), timestamp: uint(p.timestamp), gasCostNative: uint(p.gasCostNative), late: p.late };
}
function historicalScan(value: unknown): ScanResult | null {
  if (value === null) return null;
  const scan = record(value);
  fields(scan, ['complete', 'fromBlock', 'checkedThroughBlock', 'targetBlock', 'payments', 'anomalies'], ['error']);
  if (typeof scan.complete !== 'boolean') invalid('Invalid historical coverage.');
  const fromBlock = uint(scan.fromBlock), targetBlock = scan.targetBlock === 'unknown' ? 'unknown' : uint(scan.targetBlock);
  const checkedThroughBlock = scan.checkedThroughBlock === null ? null : uint(scan.checkedThroughBlock);
  if (targetBlock === 'unknown') {
    if (scan.complete || checkedThroughBlock !== null) invalid('An unknown target cannot claim completed scan coverage.');
  } else if (BigInt(fromBlock) > BigInt(targetBlock) || (checkedThroughBlock !== null && (BigInt(checkedThroughBlock) < BigInt(fromBlock) || BigInt(checkedThroughBlock) > BigInt(targetBlock))) || (scan.complete && checkedThroughBlock !== targetBlock)) invalid('Inconsistent historical block range.');
  return { complete: scan.complete, fromBlock, checkedThroughBlock, targetBlock,
    payments: boundedList(scan.payments, HANDOFF_LIMITS.evidence).map(historicalPayment),
    anomalies: boundedList(scan.anomalies, HANDOFF_LIMITS.evidence).map(value => {
      const anomaly = record(value); fields(anomaly, ['hash', 'reason']);
      return { hash: transactionHash(anomaly.hash), reason: boundedText(anomaly.reason) };
    }), ...(scan.error === undefined ? {} : { error: boundedText(scan.error) }) };
}
function historicalSnapshot(value: unknown): HandoffSnapshot | null {
  if (value === null) return null;
  const snapshot = record(value); fields(snapshot, ['capturedAt', 'payments', 'scan', 'note']);
  return { capturedAt: iso(snapshot.capturedAt), payments: boundedList(snapshot.payments, HANDOFF_LIMITS.evidence).map(historicalPayment), scan: historicalScan(snapshot.scan), note: boundedText(snapshot.note) };
}
function recordChain(item: Pick<HandoffRecordInput, 'request' | 'receivable'>): number {
  const id = item.request?.domain.chainId ?? item.receivable?.chainId;
  if (id === undefined) invalid('A record needs a signed request or a business receivable.');
  return id;
}
export function compareHandoff(item: Pick<HandoffRecordInput, 'request' | 'receivable'>, payments: VerifiedPayment[], scan: ScanResult | null): ThreeWayComparison {
  const { request, receivable } = item;
  const matched = request ? mergePayments(payments.filter(p => p.chainId === request.domain.chainId && p.requestId.toLowerCase() === request.requestId.toLowerCase())) : [];
  return { businessAmount: receivable?.amount ?? null, signedAmount: request?.message.amount ?? null,
    verifiedAmount: matched.reduce((total, p) => total + BigInt(p.amount), 0n).toString(), paymentCount: matched.length,
    referenceMatches: request && receivable ? request.message.reference === receivable.reference : null,
    amountMatches: request && receivable ? request.message.amount === receivable.amount : null,
    networkMatches: request && receivable ? request.domain.chainId === receivable.chainId : null,
    requestMatches: request && receivable ? !!receivable.requestId && receivable.requestId.toLowerCase() === request.requestId.toLowerCase() : null,
    coverage: scan ? scan.complete ? 'complete' : 'incomplete' : 'not-run' };
}
function historicalComparison(value: unknown): ThreeWayComparison {
  const obj = record(value);
  fields(obj, ['businessAmount', 'signedAmount', 'verifiedAmount', 'paymentCount', 'referenceMatches', 'amountMatches', 'networkMatches', 'requestMatches', 'coverage']);
  if (typeof obj.paymentCount !== 'number' || !Number.isSafeInteger(obj.paymentCount) || obj.paymentCount < 0 || obj.paymentCount > HANDOFF_LIMITS.evidence * 2) invalid('Invalid historical payment count.');
  for (const key of ['referenceMatches', 'amountMatches', 'networkMatches', 'requestMatches']) if (obj[key] !== null && typeof obj[key] !== 'boolean') invalid('Invalid historical comparison.');
  if (obj.coverage !== 'not-run' && obj.coverage !== 'incomplete' && obj.coverage !== 'complete') invalid('Invalid historical comparison coverage.');
  // A sum of valid uint256 payments may itself exceed uint256.
  if (typeof obj.verifiedAmount !== 'string' || !/^(0|[1-9]\d*)$/.test(obj.verifiedAmount) || obj.verifiedAmount.length > 81) invalid('Invalid historical payment total.');
  return { businessAmount: obj.businessAmount === null ? null : uint(obj.businessAmount, true), signedAmount: obj.signedAmount === null ? null : uint(obj.signedAmount, true), verifiedAmount: obj.verifiedAmount, paymentCount: obj.paymentCount,
    referenceMatches: obj.referenceMatches as boolean | null, amountMatches: obj.amountMatches as boolean | null, networkMatches: obj.networkMatches as boolean | null, requestMatches: obj.requestMatches as boolean | null, coverage: obj.coverage };
}
function keyFor(item: HandoffRecordInput): string {
  if (item.receivable) return item.receivable.id;
  if (item.request) return `request:${item.request.domain.chainId}:${item.request.requestId.toLowerCase()}`;
  return invalid('A record needs a signed request or a business receivable.');
}
async function parseRecord(value: unknown): Promise<HandoffRecord> {
  const item = record(value); fields(item, ['recordKey', 'request', 'receivable', 'hashes', 'snapshot', 'comparison']);
  const request = item.request === null ? null : await verifyRequest(item.request);
  const receivable = item.receivable === null ? null : validateReceivable(item.receivable);
  const parsed = { request, receivable, hashes: hashes(item.hashes), snapshot: historicalSnapshot(item.snapshot) };
  if (item.recordKey !== keyFor(parsed)) invalid('The handoff record key does not match its business record or request.');
  recordChain(parsed);
  return { ...parsed, recordKey: item.recordKey, comparison: historicalComparison(item.comparison) };
}

// Parsing authenticates signed requests only. Business records, exported results,
// reviews and comparisons remain untrusted claims until independently checked.
export async function previewHandoff(text: string): Promise<HandoffPackage> {
  if (byteLength(text) > HANDOFF_LIMITS.bytes) invalid('The handoff package exceeds 2 MiB.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (cause) { throw new PayRefError('INVALID_HANDOFF_JSON', 'handoff', 'The file is not valid JSON.', {}, { cause }); }
  const packet = record(raw); fields(packet, ['type', 'version', 'createdAt', 'verifierVersion', 'records']);
  if (packet.type !== 'arc-payref-handoff' || packet.version !== 1) invalid('Only Arc PayRef handoff version 1 is supported. This is not a request backup.');
  const version = boundedText(packet.verifierVersion, 128);
  if (!version) invalid('The historical verifier version is missing.');
  const items = boundedList(packet.records, HANDOFF_LIMITS.records);
  if (!items.length) invalid('The package contains no records.');
  const records: HandoffRecord[] = [], keys = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    try {
      const item = await parseRecord(items[index]);
      if (keys.has(item.recordKey)) invalid('Duplicate handoff record key.');
      keys.add(item.recordKey); records.push(item);
    } catch (cause) {
      throw new PayRefError('HANDOFF_RECORD_INVALID', 'handoff', `Record ${index + 1} could not be validated. ${errorText(cause)}`, { recordIndex: String(index + 1) }, { cause });
    }
  }
  return { type: 'arc-payref-handoff', version: 1, createdAt: iso(packet.createdAt), verifierVersion: version, records };
}
export async function buildHandoff(inputs: HandoffRecordInput[]): Promise<HandoffPackage> {
  if (!inputs.length || inputs.length > HANDOFF_LIMITS.records) invalid('Export between 1 and 100 records per package.');
  const packet: HandoffPackage = { type: 'arc-payref-handoff', version: 1, createdAt: new Date().toISOString(), verifierVersion: HANDOFF_VERIFIER_VERSION,
    records: inputs.map(input => {
      const item = { ...input, receivable: input.receivable ?? null, snapshot: input.snapshot ?? null };
      const snapshotPayments = mergePayments(item.snapshot?.payments ?? [], item.snapshot?.scan?.payments ?? []);
      return { ...item, hashes: [...new Set(input.hashes.map(hash => hash.toLowerCase() as Hex))], recordKey: keyFor(item), comparison: compareHandoff(item, snapshotPayments, item.snapshot?.scan ?? null) };
    }) };
  // The human-readable exported representation must also fit the import limit.
  return previewHandoff(JSON.stringify(packet, null, 2));
}
function failure(error: unknown, hash?: Hex): HandoffFailure {
  return { stage: error instanceof PayRefError ? error.stage : 'verification', code: error instanceof PayRefError ? error.code : 'VERIFICATION_FAILED', message: errorText(error), ...(hash ? { hash } : {}) };
}
function copyResult(result: HandoffRecordResult): HandoffRecordResult {
  return { ...result, hashChecks: [...result.hashChecks], payments: [...result.payments], errors: [...result.errors], comparison: { ...result.comparison } };
}

// No snapshot state, scan cursor, claimed total or review flag is used here.
// Only the application's allowlisted RPC configuration and shared verifiers run.
export async function verifyHandoff(packet: HandoffPackage, options: HandoffVerificationOptions = {}): Promise<HandoffVerification> {
  const validated = await previewHandoff(JSON.stringify(packet));
  const mode = options.mode ?? 'hashes', startedAt = new Date().toISOString();
  if (mode !== 'hashes' && mode !== 'scan') invalid('Unsupported handoff verification mode.');
  const results: HandoffRecordResult[] = validated.records.map(item => ({ recordKey: item.recordKey, requestId: item.request?.requestId ?? null, chainId: recordChain(item), state: 'not-run', hashChecks: [], payments: [], scan: null, errors: [], comparison: compareHandoff(item, [], null), verifiedAt: null }));
  for (let index = 0; index < validated.records.length; index++) {
    if (options.signal?.aborted) break;
    const item = validated.records[index], result = results[index];
    const emit = () => { result.comparison = compareHandoff(item, result.payments, result.scan); options.onResult?.(copyResult(result)); };
    const progress = (message: string) => options.onProgress?.({ index, total: results.length, recordKey: item.recordKey, message });
    result.state = 'checking'; emit();
    if (!item.request) {
      result.errors.push({ stage: 'request', code: 'MISSING_SIGNED_REQUEST', message: 'No complete signed request is linked. Business data and transaction hashes alone cannot establish PayRef payment evidence.' });
    } else {
      for (const hash of item.hashes) {
        if (options.signal?.aborted) break;
        progress(`Checking known transaction ${result.hashChecks.length + 1}/${item.hashes.length}`);
        try {
          const payment = await verifyPayment(item.request, hash);
          result.payments = mergePayments(result.payments, [payment]);
          result.hashChecks.push({ hash, status: 'verified', payment }); result.verifiedAt = new Date().toISOString();
        } catch (error) {
          const detail = failure(error, hash); result.hashChecks.push({ hash, status: 'failed', error: detail }); result.errors.push(detail);
        }
        emit();
      }
      if (mode === 'scan' && !options.signal?.aborted) {
        progress('Starting a fresh full-range lookup. Historical coverage is not reused.');
        try {
          result.scan = await scanRequest(item.request, { signal: options.signal, progress, previous: result.payments });
          result.payments = mergePayments(result.payments, result.scan.payments); result.verifiedAt = new Date().toISOString();
          if (result.scan.error) result.errors.push({ stage: 'scan', code: options.signal?.aborted ? 'SCAN_CANCELLED' : 'SCAN_INCOMPLETE', message: result.scan.error });
        } catch (error) { result.errors.push(failure(error)); }
      }
    }
    result.state = options.signal?.aborted ? 'cancelled' : 'finished'; emit();
  }
  return { mode, startedAt, finishedAt: new Date().toISOString(), cancelled: !!options.signal?.aborted, records: results };
}

export interface HandoffNetworkSummary { chainId: number; businessAmount: string; signedAmount: string; verifiedAmount: string; businessCount: number; requestCount: number; paymentCount: number }
// A request associated with two business rows must not count as two payments.
export function summarizeHandoff(packet: HandoffPackage, results: HandoffRecordResult[] = []): HandoffNetworkSummary[] {
  const summaries = new Map<number, HandoffNetworkSummary>();
  const get = (chainId: number) => {
    let summary = summaries.get(chainId);
    if (!summary) { summary = { chainId, businessAmount: '0', signedAmount: '0', verifiedAmount: '0', businessCount: 0, requestCount: 0, paymentCount: 0 }; summaries.set(chainId, summary); }
    return summary;
  };
  const seenRequests = new Set<string>();
  for (const item of packet.records) {
    if (item.receivable) { const summary = get(item.receivable.chainId); summary.businessCount++; summary.businessAmount = (BigInt(summary.businessAmount) + BigInt(item.receivable.amount)).toString(); }
    if (item.request) {
      const key = `${item.request.domain.chainId}:${item.request.requestId.toLowerCase()}`;
      if (!seenRequests.has(key)) { seenRequests.add(key); const summary = get(item.request.domain.chainId); summary.requestCount++; summary.signedAmount = (BigInt(summary.signedAmount) + BigInt(item.request.message.amount)).toString(); }
    }
  }
  for (const payment of mergePayments(...results.map(result => result.payments))) { const summary = get(payment.chainId); summary.paymentCount++; summary.verifiedAmount = (BigInt(summary.verifiedAmount) + BigInt(payment.amount)).toString(); }
  return [...summaries.values()];
}
