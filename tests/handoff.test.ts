// Synthetic unit tests. RPC functions are mocked; these do not prove live Arc integration.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanRequest, verifyPayment } from '../src/chain';
import { MAINNET } from '../src/config';
import { PayRefError } from '../src/errors';
import { buildHandoff, HANDOFF_LIMITS, previewHandoff, summarizeHandoff, verifyHandoff } from '../src/handoff';
import type { HandoffSnapshot } from '../src/handoff';
import type { SignedRequest } from '../src/protocol';
import type { Receivable } from '../src/receivables';
import { verifyEvidence } from '../src/verification';
import { evidence, otherHash, signed, txHash, unsigned } from './fixtures';

vi.mock('../src/chain', () => ({ scanRequest: vi.fn(), verifyPayment: vi.fn() }));
const at = '2026-09-21T00:00:00.000Z';
function business(request: SignedRequest, id = 'business-1'): Receivable {
  return { version: 1, id, chainId: request.domain.chainId, reference: request.message.reference, amount: request.message.amount, customer: 'Synthetic client', note: 'Declared delivery only', source: { name: 'synthetic.csv', row: 2 }, requestId: request.requestId, hashes: [], review: { state: 'reviewed', note: 'Human note, not proof', updatedAt: at } };
}
async function secondRequest() {
  const input = unsigned(); input.message.nonce = `0x${'33'.repeat(32)}`;
  return signed(input);
}
function snapshot(request: SignedRequest): HandoffSnapshot {
  const payment = verifyEvidence(request, evidence(request));
  return { capturedAt: at, payments: [payment], scan: { complete: true, fromBlock: '100', checkedThroughBlock: '105', targetBlock: '105', payments: [payment], anomalies: [] }, note: 'Untrusted exported claim' };
}
beforeEach(() => { vi.mocked(verifyPayment).mockReset(); vi.mocked(scanRequest).mockReset(); });

describe('portable handoff validation', () => {
  it('round trips full signed requests and business declarations without local storage', async () => {
    const request = await signed(), receivable = business(request);
    const packet = await buildHandoff([{ request, receivable, hashes: [txHash, txHash] }]);
    const parsed = await previewHandoff(JSON.stringify(packet));
    expect(parsed.type).toBe('arc-payref-handoff'); expect(parsed.records[0].recordKey).toBe(receivable.id);
    expect(parsed.records[0].request).toEqual(request); expect(parsed.records[0].receivable).toEqual(receivable);
    expect(parsed.records[0].hashes).toEqual([txHash]);
    expect(parsed.records[0].comparison).toMatchObject({ businessAmount: '10000', signedAmount: '10000', verifiedAmount: '0', referenceMatches: true, requestMatches: true, coverage: 'not-run' });
    expect(verifyPayment).not.toHaveBeenCalled(); expect(scanRequest).not.toHaveBeenCalled();
  });
  it('rejects modified signed data and reports its record index', async () => {
    const packet = await buildHandoff([{ request: await signed(), hashes: [] }]);
    packet.records[0].request!.message.amount = '10001';
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toMatchObject({ code: 'HANDOFF_RECORD_INVALID', context: { recordIndex: '1' } });
  });
  it('rejects arbitrary RPC and target fields rather than loading configuration from a package', async () => {
    const packet = await buildHandoff([{ request: await signed(), hashes: [] }]);
    await expect(previewHandoff(JSON.stringify({ ...packet, rpc: 'https://example.com' }))).rejects.toThrow('Unexpected or missing');
    await expect(previewHandoff(JSON.stringify({ ...packet, records: [{ ...packet.records[0], target: '0x0000000000000000000000000000000000000001' }] }))).rejects.toThrow('Unexpected or missing');
    packet.records[0].request!.message.memoContract = '0x1111111111111111111111111111111111111111';
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('configured Arc USDC and Memo');
  });
  it('bounds file bytes, record counts and hash counts, rejecting duplicate keys and hashes on import', async () => {
    const request = await signed(), item = { request, hashes: [] };
    await expect(buildHandoff(Array.from({ length: 101 }, () => item))).rejects.toThrow('100 records');
    await expect(previewHandoff(' '.repeat(HANDOFF_LIMITS.bytes + 1))).rejects.toThrow('2 MiB');
    const packet = await buildHandoff([item]);
    await expect(previewHandoff(JSON.stringify({ ...packet, records: [packet.records[0], packet.records[0]] }))).rejects.toThrow('Duplicate handoff record key');
    packet.records[0].hashes = [txHash, txHash];
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('Duplicate transaction hashes');
    packet.records[0].hashes = Array.from({ length: 101 }, (_, index) => `0x${index.toString(16).padStart(64, '0')}` as const);
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('at most 100');
  });
  it('rejects unsupported package versions, request backups, malformed snapshots and detached keys', async () => {
    const request = await signed(), packet = await buildHandoff([{ request, hashes: [], snapshot: snapshot(request) }]);
    await expect(previewHandoff(JSON.stringify({ version: 1, requests: [] }))).rejects.toThrow();
    await expect(previewHandoff(JSON.stringify({ ...packet, version: 2 }))).rejects.toThrow('version 1');
    packet.records[0].snapshot!.scan!.checkedThroughBlock = '104';
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('Inconsistent historical block range');
    packet.records[0].snapshot = null; packet.records[0].recordKey = 'injected';
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('record key');
  });
  it('retains missing-request business rows without treating their hashes or reviewed flag as evidence', async () => {
    const request = await signed(), receivable = business(request);
    const packet = await buildHandoff([{ request: null, receivable, hashes: [txHash] }]);
    const result = await verifyHandoff(packet);
    expect(result.records).toHaveLength(1); expect(result.records[0].errors[0].code).toBe('MISSING_SIGNED_REQUEST');
    expect(result.records[0].payments).toEqual([]); expect(verifyPayment).not.toHaveBeenCalled(); expect(scanRequest).not.toHaveBeenCalled();
  });
  it('exports an initial RPC failure with an unknown scan target without inventing completed coverage', async () => {
    const request = await signed(), history = snapshot(request);
    history.scan = { complete: false, fromBlock: '100', checkedThroughBlock: null, targetBlock: 'unknown', payments: [], anomalies: [], error: 'RPC could not read the current block.' };
    const packet = await buildHandoff([{ request, hashes: [], snapshot: history }]);
    expect(packet.records[0].snapshot?.scan).toEqual(history.scan);
    expect(packet.records[0].comparison.coverage).toBe('incomplete');
    packet.records[0].snapshot!.scan!.complete = true;
    await expect(previewHandoff(JSON.stringify(packet))).rejects.toThrow('unknown target');
  });
});

describe('independent handoff re-verification with synthetic RPC responses', () => {
  it('never trusts a forged historical paid/complete comparison and defaults to known hashes only', async () => {
    const request = await signed(), packet = await buildHandoff([{ request, hashes: [], snapshot: snapshot(request) }]);
    packet.records[0].comparison.verifiedAmount = '999999999999'; packet.records[0].comparison.coverage = 'complete';
    const result = await verifyHandoff(packet);
    expect(result.mode).toBe('hashes'); expect(result.records[0].payments).toEqual([]);
    expect(result.records[0].comparison).toMatchObject({ verifiedAmount: '0', paymentCount: 0, coverage: 'not-run' });
    expect(result.records[0].scan).toBeNull(); expect(scanRequest).not.toHaveBeenCalled();
  });
  it('uses the shared receipt verifier and preserves partial successes when another hash fails', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request)), updates: number[] = [];
    vi.mocked(verifyPayment).mockResolvedValueOnce(payment).mockRejectedValueOnce(new PayRefError('EVIDENCE_MISMATCH', 'receipt', 'Wrong transfer amount.'));
    const packet = await buildHandoff([{ request, hashes: [txHash, otherHash] }]);
    const result = await verifyHandoff(packet, { onResult: record => updates.push(record.payments.length) });
    expect(verifyPayment).toHaveBeenNthCalledWith(1, request, txHash); expect(verifyPayment).toHaveBeenNthCalledWith(2, request, otherHash);
    expect(result.records[0].payments).toEqual([payment]); expect(result.records[0].hashChecks.map(check => check.status)).toEqual(['verified', 'failed']);
    expect(result.records[0].errors[0]).toMatchObject({ code: 'EVIDENCE_MISMATCH', hash: otherHash }); expect(updates).toContain(1);
    expect(result.records[0].comparison.coverage).toBe('not-run');
  });
  it('does not let one record RPC failure prevent the next record from being checked', async () => {
    const first = await signed(), second = await secondRequest(), payment = verifyEvidence(second, evidence(second));
    vi.mocked(verifyPayment).mockRejectedValueOnce(new PayRefError('RPC_READ_FAILED', 'receipt', 'RPC unavailable.')).mockResolvedValueOnce(payment);
    const result = await verifyHandoff(await buildHandoff([{ request: first, hashes: [txHash] }, { request: second, hashes: [txHash] }]));
    expect(result.records[0].errors[0].code).toBe('RPC_READ_FAILED'); expect(result.records[1].payments).toEqual([payment]);
  });
  it('full-range lookup explicitly starts fresh and seeds only receipts checked in this run', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request)), claim = snapshot(request);
    claim.scan!.checkedThroughBlock = '999'; claim.scan!.targetBlock = '999'; claim.payments[0].hash = otherHash;
    vi.mocked(verifyPayment).mockResolvedValue(payment);
    vi.mocked(scanRequest).mockResolvedValue({ complete: true, fromBlock: '100', checkedThroughBlock: '110', targetBlock: '110', payments: [payment], anomalies: [] });
    const result = await verifyHandoff(await buildHandoff([{ request, hashes: [txHash], snapshot: claim }]), { mode: 'scan' });
    expect(scanRequest).toHaveBeenCalledWith(request, expect.objectContaining({ previous: [payment] }));
    expect(result.records[0].scan?.targetBlock).toBe('110'); expect(result.records[0].payments).toEqual([payment]);
    expect(result.records[0].comparison.coverage).toBe('complete');
  });
  it('keeps matched receipts, anomalies and incomplete scan coverage distinct', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request));
    vi.mocked(scanRequest).mockResolvedValue({ complete: false, fromBlock: '100', checkedThroughBlock: '102', targetBlock: '110', payments: [payment], anomalies: [{ hash: otherHash, reason: 'Unsupported nested transfer.' }], error: 'Could not verify blocks 103–110.' });
    const result = await verifyHandoff(await buildHandoff([{ request, hashes: [] }]), { mode: 'scan' });
    expect(result.records[0].payments).toEqual([payment]); expect(result.records[0].scan?.anomalies).toHaveLength(1);
    expect(result.records[0].comparison).toMatchObject({ verifiedAmount: '10000', coverage: 'incomplete' });
    expect(result.records[0].errors[0].code).toBe('SCAN_INCOMPLETE');
  });
  it('retains a verified known hash if the full scan throws', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request));
    vi.mocked(verifyPayment).mockResolvedValue(payment); vi.mocked(scanRequest).mockRejectedValue(new PayRefError('RPC_READ_FAILED', 'scan', 'Range lookup failed.'));
    const result = await verifyHandoff(await buildHandoff([{ request, hashes: [txHash] }]), { mode: 'scan' });
    expect(result.records[0].payments).toEqual([payment]); expect(result.records[0].comparison.coverage).toBe('not-run'); expect(result.records[0].errors[0].stage).toBe('scan');
  });
  it('cancels between reads without losing the completed receipt or starting remaining records', async () => {
    const request = await signed(), next = await secondRequest(), payment = verifyEvidence(request, evidence(request)), controller = new AbortController();
    vi.mocked(verifyPayment).mockImplementationOnce(async () => { controller.abort(); return payment; });
    const result = await verifyHandoff(await buildHandoff([{ request, hashes: [txHash, otherHash] }, { request: next, hashes: [txHash] }]), { mode: 'scan', signal: controller.signal });
    expect(result.cancelled).toBe(true); expect(result.records[0].state).toBe('cancelled'); expect(result.records[0].payments).toEqual([payment]);
    expect(result.records[1].state).toBe('not-run'); expect(verifyPayment).toHaveBeenCalledTimes(1); expect(scanRequest).not.toHaveBeenCalled();
  });
  it('does not call RPC for an already cancelled run', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await verifyHandoff(await buildHandoff([{ request: await signed(), hashes: [txHash] }]), { signal: controller.signal });
    expect(result.cancelled).toBe(true); expect(result.records[0].state).toBe('not-run'); expect(verifyPayment).not.toHaveBeenCalled();
  });
  it('reports business mismatches independently from a verified payment and preserves integer precision', async () => {
    const input = unsigned(); input.message.amount = '1000000000000000000000000000001';
    const request = await signed(input), receivable = business(request), payment = verifyEvidence(request, evidence(request));
    receivable.amount = '1000000000000000000000000000002'; receivable.reference = 'Different declaration';
    vi.mocked(verifyPayment).mockResolvedValue(payment);
    const result = await verifyHandoff(await buildHandoff([{ request, receivable, hashes: [txHash] }]));
    expect(result.records[0].comparison).toMatchObject({ referenceMatches: false, amountMatches: false, requestMatches: true, verifiedAmount: input.message.amount });
  });
  it('preserves a bounded historical aggregate above uint256 without treating it as real chain evidence', async () => {
    const input = unsigned(); input.message.amount = ((1n << 256n) - 1n).toString();
    const base = await signed(), historical = verifyEvidence(base, evidence(base)), request = await signed(input);
    // These are deliberately untrusted numeric claims, not encodable Arc native-transfer fixtures.
    const first = { ...historical, requestId: request.requestId, amount: input.message.amount }, second = { ...first, hash: otherHash };
    const packet = await buildHandoff([{ request, hashes: [txHash, otherHash], snapshot: { capturedAt: at, payments: [first, second], scan: null, note: '' } }]);
    expect(packet.records[0].comparison.verifiedAmount).toBe((2n * BigInt(input.message.amount)).toString());
    expect(verifyPayment).not.toHaveBeenCalled();
  });
  it('deduplicates shared request/payment totals and keeps synthetic testnet/mainnet amounts separate', async () => {
    const test = await signed(), main = await signed(unsigned(MAINNET));
    const testPayment = verifyEvidence(test, evidence(test)), mainPayment = verifyEvidence(main, evidence(main));
    vi.mocked(verifyPayment).mockResolvedValueOnce(testPayment).mockResolvedValueOnce(testPayment).mockResolvedValueOnce(mainPayment);
    const packet = await buildHandoff([{ request: test, receivable: business(test, 'first'), hashes: [txHash] }, { request: test, receivable: business(test, 'second'), hashes: [txHash] }, { request: main, hashes: [txHash] }]);
    const result = await verifyHandoff(packet), summaries = summarizeHandoff(packet, result.records);
    expect(summaries.find(summary => summary.chainId === test.domain.chainId)).toMatchObject({ businessAmount: '20000', signedAmount: '10000', verifiedAmount: '10000', requestCount: 1, paymentCount: 1 });
    expect(summaries.find(summary => summary.chainId === MAINNET)).toMatchObject({ signedAmount: '10000', verifiedAmount: '10000', requestCount: 1, paymentCount: 1 });
  });
});
