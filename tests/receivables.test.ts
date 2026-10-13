import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINNET, TESTNET } from '../src/config';
import { createReceivable, exportReceivablesCsv, exportReceivablesJson, inspectReceivables, reconcileReceivable, validateReceivable } from '../src/receivables';
import { ReceivablesRepository, browserReceivables } from '../src/receivables-store';
import { verifyEvidence } from '../src/verification';
import { MemoryStorage, evidence, otherHash, signed, txHash } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
const create = (reference = 'TEST-001', amount = '0.01') => createReceivable({ chainId: TESTNET, reference, amount });

describe('business import previews without payment claims', () => {
  it('creates a new manual record with exact atomic amounts and no automatic association', () => {
    const item = create('CONSULT-01', '123456789123456789.123456');
    expect(item.amount).toBe('123456789123456789123456');
    expect(item.requestId).toBeUndefined(); expect(item.hashes).toEqual([]); expect(item.review.state).toBe('open');
    expect(item.id).not.toBe(create('CONSULT-01').id);
  });
  it('parses quoted commas, quotes, UTF-8 BOM and multiline notes without losing source line numbers', () => {
    const preview = inspectReceivables('\uFEFFreference,amount,customer,note\r\n"A,1",0.000001,"Acme ""Ltd""","First line\r\nSecond line"\r\nB,10,Other,Done\r\n', 'csv', TESTNET, 'invoices.csv');
    expect(preview.errors).toEqual([]); expect(preview.total).toBe(2);
    expect(preview.entries[0]).toMatchObject({ reference: 'A,1', amount: '1', customer: 'Acme "Ltd"', note: 'First line\nSecond line', source: { name: 'invoices.csv', row: 2 } });
    expect(preview.entries[1].source.row).toBe(4);
  });
  it('reports individual precision, network and malformed-column errors while preserving valid rows', () => {
    const preview = inspectReceivables(`reference,amount,chain_id\nGOOD,0.01,\nPRECISE,0.0000001,\nCHAIN,1,1\nCOLUMNS,1\nMAIN,2,${MAINNET}`, 'csv', TESTNET, 'invoices.csv');
    expect(preview.total).toBe(5); expect(preview.entries).toHaveLength(2);
    expect(preview.errors.map(error => error.row)).toEqual([3, 4, 5]);
    expect(preview.entries[1].chainId).toBe(MAINNET);
  });
  it.each(['reference,amount,paid\nA,1,true', 'reference,amount,reference\nA,1,A', 'amount,customer\n1,A'])('rejects unsupported or ambiguous CSV headers: %s', raw => {
    expect(() => inspectReceivables(raw, 'csv', TESTNET, 'input.csv')).toThrow();
  });
  it.each(['reference,amount\n"never closes,1', 'reference,amount\n"A"oops,1', 'reference,amount\nA"B,1'])('rejects malformed quoting without guessing row boundaries', raw => {
    expect(() => inspectReceivables(raw, 'csv', TESTNET, 'input.csv')).toThrow();
  });
  it('accepts ordinary JSON business rows only with decimal amount strings and rejects claimed paid states', () => {
    const preview = inspectReceivables(JSON.stringify([{ id: 'external-1', reference: 'ONE', amount: '1.234567', tx_hash: txHash }, { reference: 'FLOAT', amount: 0.1 }, { reference: 'CLAIM', amount: '1', status: 'PAID' }]), 'json', TESTNET, 'input.json');
    expect(preview.entries).toHaveLength(1); expect(preview.entries[0]).toMatchObject({ id: 'external-1', amount: '1234567', hashes: [txHash] });
    expect(preview.errors).toHaveLength(2);
  });
  it('round trips typed JSON using atomic amounts and retains manual notes without converting them to payment evidence', () => {
    const item = { ...create(), review: { state: 'reviewed' as const, note: 'Contacted the customer; awaiting reply.', updatedAt: '2026-09-21T00:00:00.000Z' } };
    const preview = inspectReceivables(exportReceivablesJson([item]), 'json', TESTNET, 'restored.json');
    expect(preview.entries).toEqual([item]);
    expect(reconcileReceivable(preview.entries[0], [], {}, {}).payment.status).toBe('not-verified');
  });
  it('rejects duplicate explicit IDs and repeated request associations, while allowing unlinked repeated references', () => {
    const rows = [{ id: 'one', reference: 'REPEAT', amount: '1', request_id: txHash }, { id: 'one', reference: 'OTHER', amount: '2' }, { id: 'two', reference: 'REPEAT', amount: '1', request_id: txHash }, { id: 'three', reference: 'REPEAT', amount: '1' }];
    const preview = inspectReceivables(JSON.stringify(rows), 'json', TESTNET, 'input.json');
    expect(preview.entries.map(item => item.id)).toEqual(['one', 'three']);
    expect(preview.errors.map(error => error.message)).toEqual([expect.stringContaining('RECEIVABLE_ID_CONFLICT'), expect.stringContaining('RECEIVABLE_LINK_CONFLICT')]);
  });
  it('enforces the record/file/text limits and rejects unsupported data versions', () => {
    expect(() => inspectReceivables('x'.repeat(1024 * 1024 + 1), 'csv', TESTNET, 'input.csv')).toThrow();
    expect(() => inspectReceivables(JSON.stringify(Array(101).fill({ reference: 'ONE', amount: '1' })), 'json', TESTNET, 'input.json')).toThrow();
    expect(() => inspectReceivables('reference,amount\n' + Array(101).fill('ONE,1').join('\n'), 'csv', TESTNET, 'input.csv')).toThrow();
    expect(() => inspectReceivables(JSON.stringify({ type: 'payref-receivables', version: 2, records: [] }), 'json', TESTNET, 'input.json')).toThrow();
    expect(() => create('界'.repeat(43))).toThrow();
    expect(() => validateReceivable({ ...create(), review: { state: 'paid', note: '', updatedAt: '2026-09-21T00:00:00.000Z' } })).toThrow();
    expect(() => validateReceivable({ ...create(), note: 'hidden\u0000value' })).toThrow();
  });
});

describe('independent business, strict-payment and query dimensions with synthetic fixtures', () => {
  it('shows same-reference or same-amount candidates without linking or counting their verified payment', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request));
    const result = reconcileReceivable(create(), [{ version: 1, request, hashes: [txHash] }], { [request.requestId]: [payment] }, {});
    expect(result.candidates).toHaveLength(1); expect(result.linkage).toBe('unlinked');
    expect(result.payment).toEqual({ status: 'not-verified', payments: [] }); expect(result.query.status).toBe('not-run');
  });
  it('treats an unknown request ID and an arbitrary hash as missing materials rather than a match', async () => {
    const request = await signed(), item = { ...create(), requestId: otherHash, hashes: [txHash] };
    const result = reconcileReceivable(item, [{ version: 1, request, hashes: [] }], {}, {});
    expect(result.linkage).toBe('missing-request'); expect(result.payment.status).toBe('not-verified'); expect(result.candidates).toHaveLength(1);
  });
  it('retains verified payment evidence independently of business discrepancies and incomplete lookup', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request));
    const item = { ...create('OTHER', '2'), chainId: MAINNET, requestId: request.requestId };
    const result = reconcileReceivable(item, [{ version: 1, request, hashes: [] }], { [request.requestId]: [payment] }, { [request.requestId]: { complete: false, fromBlock: '100', checkedThroughBlock: '101', targetBlock: '105', payments: [payment], anomalies: [], error: 'Read failed.' } });
    expect(result.business.status).toBe('mismatch'); expect(result.business.differences.map(d => d.field)).toEqual(['network', 'reference', 'amount']);
    expect(result.payment.status).toBe('verified'); expect(result.query.status).toBe('incomplete'); expect(result.query.error).toBe('Read failed.');
  });
  it('deduplicates verified receipts and excludes other requests/networks without trusting saved hashes', async () => {
    const request = await signed(), payment = verifyEvidence(request, evidence(request)), duplicate = verifyEvidence(request, evidence(request, otherHash));
    const records = [{ version: 1 as const, request, hashes: [txHash, otherHash] }], item = { ...create(), requestId: request.requestId };
    expect(reconcileReceivable(item, records, {}, {}).payment.status).toBe('not-verified');
    const result = reconcileReceivable(item, records, { [request.requestId]: [payment, payment, duplicate, { ...payment, chainId: MAINNET }, { ...payment, requestId: otherHash }] }, {});
    expect(result.payment.status).toBe('duplicate'); expect(result.payment.payments).toHaveLength(2);
  });
  it('escapes CSV formulas and preserves exact totals with explicit unverified and manual-review columns', async () => {
    const item = { ...create('=1+1'), customer: '+SUM(A1:A2)', note: 'line one\nline "two"', review: { state: 'reviewed' as const, note: '@LOOKUP', updatedAt: '2026-09-21T00:00:00.000Z' } };
    const csv = exportReceivablesCsv([item], [], {}, {});
    expect(csv).toContain('"\'=1+1"'); expect(csv).toContain('"\'+SUM(A1:A2)"'); expect(csv).toContain('"\'@LOOKUP"');
    expect(csv).toContain('"line one\nline ""two"""'); expect(csv).toContain('"not-verified"'); expect(csv).toContain('"reviewed"');
    const request = await signed(), first = verifyEvidence(request, evidence(request)), second = verifyEvidence(request, evidence(request, otherHash));
    const reconciled = exportReceivablesCsv([{ ...create(), requestId: request.requestId }], [{ version: 1, request, hashes: [] }], { [request.requestId]: [first, second] }, {});
    expect(reconciled).toContain('"duplicate","0.02"');
  });
});

describe('business storage retains data and refuses silent overwrites', () => {
  it('inserts identical snapshots idempotently and rejects same-ID changed business content', () => {
    const storage = new MemoryStorage(), repo = new ReceivablesRepository(storage), item = create();
    repo.save(item); repo.save(item); expect(repo.list()).toEqual([item]);
    expect(() => repo.save({ ...item, amount: '20000' })).toThrow(expect.objectContaining({ code: 'RECEIVABLE_CONFLICT' }));
    expect(repo.list()).toEqual([item]);
  });
  it('prevents linking the same signed request to two records both on insert and later manual association', () => {
    const repo = new ReceivablesRepository(new MemoryStorage()), one = { ...create(), requestId: txHash }, two = create();
    repo.save(one); repo.save(two);
    expect(() => repo.linkRequest(two.id, txHash)).toThrow(expect.objectContaining({ code: 'RECEIVABLE_LINK_CONFLICT' }));
    expect(() => repo.save({ ...create(), requestId: txHash })).toThrow(expect.objectContaining({ code: 'RECEIVABLE_LINK_CONFLICT' }));
    expect(repo.list()[1].requestId).toBeUndefined();
  });
  it('fresh reads across repository instances preserve new hashes when saving a manual review', () => {
    const storage = new MemoryStorage(), first = new ReceivablesRepository(storage), second = new ReceivablesRepository(storage), item = create();
    first.save(item); second.addHash(item.id, txHash); first.review(item.id, 'reviewed', 'Reviewed the discrepancy; no payment conclusion.');
    const updated = second.list()[0]; expect(updated.hashes).toEqual([txHash]); expect(updated.review.state).toBe('reviewed');
    first.linkRequest(item.id, otherHash); expect(second.list()[0].review.state).toBe('open');
    second.addHash(item.id, txHash); expect(second.list()[0].hashes).toHaveLength(1);
  });
  it('rejects stale review edits without losing a newer note from another window', () => {
    const storage = new MemoryStorage(), first = new ReceivablesRepository(storage), second = new ReceivablesRepository(storage), item = create();
    first.save(item);
    second.review(item.id, 'open', 'Latest clarification from the payer.', '');
    expect(() => first.review(item.id, 'reviewed', 'Stale local draft.', '')).toThrow(expect.objectContaining({ code: 'RECEIVABLE_REVIEW_CONFLICT' }));
    expect(first.list()[0].review.note).toBe('Latest clarification from the payer.');
    expect(first.list()[0].review.state).toBe('open');
    first.review(item.id, 'reviewed', 'Read and reconciled the note only.', 'Latest clarification from the payer.');
    expect(second.list()[0].review.note).toBe('Read and reconciled the note only.');
    expect(second.list()[0].hashes).toEqual([]);
  });
  it('keeps corrupted records and reports their identifier', () => {
    const storage = new MemoryStorage(), repo = new ReceivablesRepository(storage), item = create(); repo.save(item);
    const key = storage.key(0)!; storage.setItem(key, '{');
    expect(() => repo.list()).toThrow(expect.objectContaining({ code: 'RECEIVABLE_STORAGE_READ', context: { receivableId: item.id } }));
    expect(storage.getItem(key)).toBe('{'); expect(() => repo.save(item)).toThrow(); expect(storage.length).toBe(1);
  });
  it('rejects mismatched storage keys and duplicate stored request associations without repairing them', () => {
    const storage = new MemoryStorage(), repo = new ReceivablesRepository(storage), item = { ...create(), requestId: txHash }; repo.save(item);
    storage.setItem('arc-payref:receivables:v1:wrong-id', JSON.stringify(item));
    expect(() => repo.list()).toThrow(); storage.removeItem('arc-payref:receivables:v1:wrong-id');
    const second = { ...create(), requestId: txHash }; storage.setItem('arc-payref:receivables:v1:' + second.id, JSON.stringify(second));
    expect(() => repo.list()).toThrow(expect.objectContaining({ code: 'RECEIVABLE_LINK_CONFLICT' })); expect(storage.length).toBe(2);
  });
  it('surfaces quota failure, read-back failure and unavailable storage without claiming save success', () => {
    const storage = new MemoryStorage(), repo = new ReceivablesRepository(storage), item = create(); repo.save(item);
    const original = storage.getItem(storage.key(0)!);
    storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    expect(() => repo.review(item.id, 'reviewed', 'note')).toThrow(expect.objectContaining({ code: 'RECEIVABLE_STORAGE_WRITE' }));
    expect(storage.getItem(storage.key(0)!)).toBe(original);
    const dropped = new MemoryStorage(); dropped.setItem = () => {};
    expect(() => new ReceivablesRepository(dropped).save(create())).toThrow(expect.objectContaining({ code: 'RECEIVABLE_STORAGE_WRITE' }));
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get() { throw new Error('denied'); } }));
    expect(() => browserReceivables()).toThrow(expect.objectContaining({ code: 'RECEIVABLE_STORAGE_UNAVAILABLE' }));
  });
  it('emits a business storage event only for a successful write', () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const repo = new ReceivablesRepository(new MemoryStorage()), item = create(); repo.save(item);
    expect(dispatchEvent).toHaveBeenCalledTimes(1); expect(dispatchEvent.mock.calls[0][0].type).toBe('payref-receivables');
    repo.save(item); expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
