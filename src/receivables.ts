import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { network } from './config';
import { PayRefError } from './errors';
import { byteLength, parseAmount, uint } from './protocol';
import type { SignedRequest } from './protocol';
import { transactionHash } from './storage';
import type { StoredRequest } from './storage';
import type { ScanResult } from './chain';
import { mergePayments } from './verification';
import type { VerifiedPayment } from './verification';

export const RECEIVABLE_LIMIT = 100;
export const RECEIVABLE_FILE_BYTES = 1024 * 1024;
const MAX_HASHES = 100;

export interface Receivable {
  version: 1;
  id: string;
  chainId: number;
  reference: string;
  amount: string;
  customer: string;
  note: string;
  source: { name: string; row: number };
  requestId?: Hex;
  hashes: Hex[];
  review: { state: 'open' | 'reviewed'; note: string; updatedAt: string };
}
export interface ReceivablePreview {
  entries: Receivable[];
  errors: { row: number; message: string }[];
  total: number;
}
export interface ReconciliationResult {
  request?: SignedRequest;
  linkage: 'unlinked' | 'missing-request' | 'linked';
  business: {
    status: 'unlinked' | 'match' | 'mismatch';
    differences: { field: 'network' | 'reference' | 'amount'; expected: string; actual: string }[];
  };
  payment: { status: 'not-verified' | 'verified' | 'duplicate'; payments: VerifiedPayment[] };
  query: { status: 'not-run' | 'incomplete' | 'complete'; fromBlock?: string; checkedThroughBlock?: string | null; targetBlock?: string; error?: string };
  candidates: StoredRequest[];
}

function invalid(code: string, message: string, context: Record<string, string> = {}): never {
  throw new PayRefError(code, 'receivables', message, context);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('RECEIVABLE_FORMAT', `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('RECEIVABLE_FIELDS', 'Unexpected or missing fields. Imported payment status is not accepted.');
}
function text(value: unknown, label: string, max: number, required = false, multiline = false): string {
  if (typeof value !== 'string') invalid('RECEIVABLE_TEXT', `${label} must be text.`);
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if ((required && !normalized) || byteLength(normalized) > max || controls.test(normalized)) invalid('RECEIVABLE_TEXT', `${label} must contain ${required ? '1' : '0'}–${max} UTF-8 bytes without unsupported control characters.`);
  return normalized;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid('RECEIVABLE_ID', 'Record ID must contain 1–128 letters, digits, dots, underscores, colons or hyphens.');
  return value;
}
function chain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid('RECEIVABLE_NETWORK', 'Expected a supported numeric Arc chain ID.');
  network(value);
  return value;
}
function hashes(value: unknown): Hex[] {
  if (!Array.isArray(value) || value.length > MAX_HASHES) invalid('RECEIVABLE_HASHES', `A record supports at most ${MAX_HASHES} transaction hashes.`);
  return [...new Set(value.map(item => transactionHash(item).toLowerCase() as Hex))];
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('RECEIVABLE_DATE', 'Review time must be a valid UTC timestamp.');
  return value;
}

/** Business records and manual review notes are never evidence of an onchain payment. */
export function validateReceivable(value: unknown): Receivable {
  const item = object(value, 'Receivable');
  fields(item, ['version', 'id', 'chainId', 'reference', 'amount', 'customer', 'note', 'source', 'hashes', 'review'], ['requestId']);
  if (item.version !== 1) invalid('RECEIVABLE_VERSION', 'Only receivable version 1 is supported.');
  const source = object(item.source, 'Source');
  fields(source, ['name', 'row']);
  if (!Number.isSafeInteger(source.row) || Number(source.row) < 1) invalid('RECEIVABLE_SOURCE', 'Source row must be a positive integer.');
  const review = object(item.review, 'Review');
  fields(review, ['state', 'note', 'updatedAt']);
  if (review.state !== 'open' && review.state !== 'reviewed') invalid('RECEIVABLE_REVIEW', 'Manual review must be open or reviewed; it cannot assert payment.');
  return {
    version: 1, id: identity(item.id), chainId: chain(item.chainId),
    reference: text(item.reference, 'Reference', 128, true), amount: uint(item.amount, true),
    customer: text(item.customer, 'Customer', 128), note: text(item.note, 'Note', 1024, false, true),
    source: { name: text(source.name, 'Source name', 256, true), row: Number(source.row) },
    ...(item.requestId === undefined ? {} : { requestId: transactionHash(item.requestId).toLowerCase() as Hex }),
    hashes: hashes(item.hashes),
    review: { state: review.state, note: text(review.note, 'Review note', 1024, false, true), updatedAt: timestamp(review.updatedAt) },
  };
}

interface CsvRow { row: number; cells: string[] }
function readCsv(raw: string): CsvRow[] {
  const input = raw.replace(/^\uFEFF/, '');
  const rows: CsvRow[] = [];
  let cells: string[] = [], value = '', quoted = false, closed = false, line = 1, start = 1;
  function endCell() { cells.push(value); value = ''; closed = false; }
  function endRow() {
    endCell();
    if (cells.some(cell => cell.trim() !== '')) rows.push({ row: start, cells });
    cells = [];
    if (rows.length > RECEIVABLE_LIMIT + 1) invalid('RECEIVABLE_LIMIT', `Import at most ${RECEIVABLE_LIMIT} records at once.`);
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        value += '\n'; line++;
      } else value += char;
    } else if (char === ',') endCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      endRow(); line++; start = line;
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (closed || char === '"') invalid('RECEIVABLE_CSV', `Malformed CSV quoting near line ${line}.`, { row: String(line) });
    else value += char;
  }
  if (quoted) invalid('RECEIVABLE_CSV', `Unclosed CSV quote near line ${line}.`, { row: String(start) });
  if (value || cells.length || closed) endRow();
  return rows;
}
const csvFields = ['reference', 'amount', 'customer', 'note', 'request_id', 'tx_hash', 'chain_id'] as const;
function businessRow(value: unknown, defaultChainId: number, sourceName: string, row: number): Receivable {
  const item = object(value, 'Import row');
  fields(item, ['reference', 'amount'], ['id', ...csvFields.filter(name => name !== 'reference' && name !== 'amount')]);
  if (typeof item.amount !== 'string') invalid('RECEIVABLE_AMOUNT', 'Amount must be decimal text, not a JSON floating-point number.');
  const rawChain = item.chain_id;
  const chainId = rawChain === undefined || rawChain === '' ? defaultChainId : typeof rawChain === 'number' ? rawChain : typeof rawChain === 'string' && /^(0|[1-9]\d*)$/.test(rawChain) ? Number(rawChain) : NaN;
  return validateReceivable({
    version: 1, id: item.id ?? crypto.randomUUID(), chainId,
    reference: item.reference, amount: parseAmount(item.amount.trim()), customer: item.customer ?? '', note: item.note ?? '',
    source: { name: sourceName, row },
    ...(item.request_id === undefined || item.request_id === '' ? {} : { requestId: item.request_id }),
    hashes: item.tx_hash === undefined || item.tx_hash === '' ? [] : [item.tx_hash],
    review: { state: 'open', note: '', updatedAt: new Date().toISOString() },
  });
}

export function createReceivable(input: { chainId: number; reference: string; amount: string; customer?: string; note?: string }): Receivable {
  return businessRow({ reference: input.reference, amount: input.amount, customer: input.customer ?? '', note: input.note ?? '' }, input.chainId, 'Manual entry', 1);
}

/** CSV uses decimal USDC. JSON arrays use the same business columns; typed exports use atomic amounts. */
export function inspectReceivables(raw: string, format: 'csv' | 'json', defaultChainId: number, sourceName: string): ReceivablePreview {
  chain(defaultChainId);
  const name = text(sourceName, 'Source name', 256, true);
  if (byteLength(raw) > RECEIVABLE_FILE_BYTES) invalid('RECEIVABLE_FILE_LIMIT', 'Business import limit is 1 MiB.');
  const preview: ReceivablePreview = { entries: [], errors: [], total: 0 };
  let rows: { row: number; value: unknown }[] = [], typed = false;
  if (format === 'csv') {
    const csv = readCsv(raw);
    if (!csv.length) invalid('RECEIVABLE_CSV', 'CSV is empty. Include reference and amount headers.');
    const headers = csv[0].cells.map(header => header.trim());
    if (!headers.includes('reference') || !headers.includes('amount') || new Set(headers).size !== headers.length || headers.some(header => !(csvFields as readonly string[]).includes(header))) invalid('RECEIVABLE_HEADERS', `CSV needs reference and amount. Optional columns: ${csvFields.slice(2).join(', ')}. Payment status columns are not accepted.`);
    rows = csv.slice(1).map(row => ({ row: row.row, value: row.cells.length === headers.length ? Object.fromEntries(headers.map((header, index) => [header, row.cells[index]])) : undefined }));
  } else if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (cause) { throw new PayRefError('RECEIVABLE_JSON', 'receivables', 'Business import is not valid JSON.', {}, { cause }); }
    let records: unknown[];
    if (Array.isArray(parsed)) records = parsed;
    else {
      const root = object(parsed, 'Import');
      fields(root, ['type', 'version', 'records']);
      if (root.type !== 'payref-receivables' || root.version !== 1 || !Array.isArray(root.records)) invalid('RECEIVABLE_JSON', 'Expected a business-row array or a PayRef receivables version 1 export.');
      typed = true; records = root.records;
    }
    rows = records.map((value, index) => ({ row: index + 1, value }));
  } else invalid('RECEIVABLE_FORMAT', 'Choose CSV or JSON for business imports.');
  if (rows.length > RECEIVABLE_LIMIT) invalid('RECEIVABLE_LIMIT', `Import at most ${RECEIVABLE_LIMIT} records at once.`);
  preview.total = rows.length;
  const seen = new Set<string>(), linked = new Set<string>();
  for (const row of rows) {
    try {
      if (row.value === undefined) invalid('RECEIVABLE_CSV', 'Column count does not match the header.');
      const entry = typed ? validateReceivable(row.value) : businessRow(row.value, defaultChainId, name, row.row);
      if (seen.has(entry.id)) invalid('RECEIVABLE_ID_CONFLICT', 'Duplicate record ID in this import. Review both source rows before importing.', { receivableId: entry.id });
      if (entry.requestId && linked.has(entry.requestId)) invalid('RECEIVABLE_LINK_CONFLICT', 'This signed request is already linked to another business row in this import. It cannot settle two separate records.', { requestId: entry.requestId });
      seen.add(entry.id); if (entry.requestId) linked.add(entry.requestId); preview.entries.push(entry);
    } catch (error) {
      preview.errors.push({ row: row.row, message: error instanceof PayRefError ? `${error.code}: ${error.message}` : 'Invalid business row; it was not imported.' });
    }
  }
  return preview;
}

export function reconcileReceivable(item: Receivable, requests: StoredRequest[], payments: Record<string, VerifiedPayment[]>, scans: Record<string, ScanResult>): ReconciliationResult {
  const request = item.requestId ? requests.find(record => record.request.requestId.toLowerCase() === item.requestId!.toLowerCase())?.request : undefined;
  const candidates = request ? [] : requests.filter(record => record.request.domain.chainId === item.chainId && (record.request.message.reference === item.reference || record.request.message.amount === item.amount));
  const differences: ReconciliationResult['business']['differences'] = [];
  if (request) {
    if (request.domain.chainId !== item.chainId) differences.push({ field: 'network', expected: String(item.chainId), actual: String(request.domain.chainId) });
    if (request.message.reference !== item.reference) differences.push({ field: 'reference', expected: item.reference, actual: request.message.reference });
    if (request.message.amount !== item.amount) differences.push({ field: 'amount', expected: item.amount, actual: request.message.amount });
  }
  const found = request ? mergePayments((payments[request.requestId] ?? []).filter(payment => payment.chainId === request.domain.chainId && payment.requestId.toLowerCase() === request.requestId.toLowerCase())) : [];
  const scan = request ? scans[request.requestId] : undefined;
  return {
    ...(request ? { request } : {}), linkage: request ? 'linked' : item.requestId ? 'missing-request' : 'unlinked',
    business: { status: !request ? 'unlinked' : differences.length ? 'mismatch' : 'match', differences },
    payment: { status: !found.length ? 'not-verified' : found.length > 1 ? 'duplicate' : 'verified', payments: found },
    query: scan ? { status: scan.complete ? 'complete' : 'incomplete', fromBlock: scan.fromBlock, checkedThroughBlock: scan.checkedThroughBlock, targetBlock: scan.targetBlock, ...(scan.error ? { error: scan.error } : {}) } : { status: 'not-run' },
    candidates,
  };
}

function csvCell(value: string): string {
  const safe = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportReceivablesCsv(items: Receivable[], requests: StoredRequest[], payments: Record<string, VerifiedPayment[]>, scans: Record<string, ScanResult>): string {
  const rows = [['record_id', 'chain_id', 'reference', 'customer', 'expected_usdc', 'linked_request_id', 'linkage', 'business_match', 'business_differences', 'strict_payment', 'verified_usdc', 'verified_hashes', 'lookup_status', 'checked_through_block', 'manual_review', 'review_note', 'business_note']];
  for (const item of items) {
    const result = reconcileReceivable(item, requests, payments, scans);
    rows.push([item.id, String(item.chainId), item.reference, item.customer, formatUnits(BigInt(item.amount), 6), item.requestId ?? '', result.linkage, result.business.status, result.business.differences.map(difference => `${difference.field}: expected ${difference.field === 'amount' ? `${formatUnits(BigInt(difference.expected), 6)} USDC` : difference.expected}; signed ${difference.field === 'amount' ? `${formatUnits(BigInt(difference.actual), 6)} USDC` : difference.actual}`).join(' | '), result.payment.status, formatUnits(result.payment.payments.reduce((total, payment) => total + BigInt(payment.amount), 0n), 6), result.payment.payments.map(payment => payment.hash).join(' | '), result.query.status, result.query.checkedThroughBlock ?? '', item.review.state, item.review.note, item.note]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function exportReceivablesJson(items: Receivable[]): string {
  if (items.length > RECEIVABLE_LIMIT) invalid('RECEIVABLE_LIMIT', `Export at most ${RECEIVABLE_LIMIT} records at once.`);
  const output = JSON.stringify({ type: 'payref-receivables', version: 1, records: items.map(validateReceivable) }, null, 2);
  if (byteLength(output) > RECEIVABLE_FILE_BYTES) invalid('RECEIVABLE_FILE_LIMIT', 'Business export exceeds the 1 MiB import limit. Export fewer records.');
  return output;
}
