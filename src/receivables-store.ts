import type { Hex } from 'viem';
import { PayRefError } from './errors';
import { transactionHash } from './storage';
import { RECEIVABLE_LIMIT, validateReceivable } from './receivables';
import type { Receivable } from './receivables';

const PREFIX = 'arc-payref:receivables:v1:';

export class ReceivablesRepository {
  constructor(private storage: Storage) {}
  private read(id: string): Receivable | undefined {
    try {
      const raw = this.storage.getItem(PREFIX + id);
      if (raw === null) return undefined;
      const record = validateReceivable(JSON.parse(raw));
      if (record.id !== id) throw new Error('Record ID does not match its storage key.');
      return record;
    } catch (cause) { throw new PayRefError('RECEIVABLE_STORAGE_READ', 'receivables-storage', 'A business record is unavailable or damaged. Existing data was retained.', { receivableId: id }, { cause }); }
  }
  list(): Receivable[] {
    try {
      const ids: string[] = [];
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (key?.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length));
      }
      if (ids.length > RECEIVABLE_LIMIT) throw new Error('Stored business record count exceeds the supported limit.');
      const linked = new Set<string>();
      return ids.map(id => {
        const item = this.read(id);
        if (!item) throw new PayRefError('RECEIVABLE_STORAGE_CHANGED', 'receivables-storage', 'Business records changed while reading. Retry the read.', { receivableId: id });
        if (item.requestId && linked.has(item.requestId)) throw new PayRefError('RECEIVABLE_LINK_CONFLICT', 'receivables-storage', 'A signed request is linked to multiple business records. Existing data was retained; the records cannot be safely counted.', { requestId: item.requestId });
        if (item.requestId) linked.add(item.requestId);
        return item;
      });
    } catch (cause) {
      if (cause instanceof PayRefError) throw cause;
      throw new PayRefError('RECEIVABLE_STORAGE_READ', 'receivables-storage', 'Could not read the local business records. Existing data was retained.', {}, { cause });
    }
  }
  private write(item: Receivable) {
    const value = validateReceivable(item);
    try {
      const encoded = JSON.stringify(value);
      this.storage.setItem(PREFIX + value.id, encoded);
      if (this.storage.getItem(PREFIX + value.id) !== encoded) throw new Error('Business record read-back mismatch.');
    } catch (cause) { throw new PayRefError('RECEIVABLE_STORAGE_WRITE', 'receivables-storage', 'The business record could not be saved. Existing records were not cleared.', { receivableId: value.id }, { cause }); }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('payref-receivables'));
  }
  /** Imports are insert-only: the same ID can never silently overwrite different content. */
  save(input: Receivable): void {
    const item = validateReceivable(input), previous = this.read(item.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(item)) throw new PayRefError('RECEIVABLE_CONFLICT', 'receivables-storage', 'This record ID already has different content. The original record was retained.', { receivableId: item.id });
      return;
    }
    const existing = this.list();
    if (existing.length >= RECEIVABLE_LIMIT) throw new PayRefError('RECEIVABLE_LIMIT', 'receivables-storage', `This browser supports at most ${RECEIVABLE_LIMIT} business records.`, { receivableId: item.id });
    this.checkLink(item, existing);
    this.write(item);
  }
  private checkLink(item: Receivable, existing = this.list()) {
    const conflict = item.requestId ? existing.find(record => record.id !== item.id && record.requestId === item.requestId) : undefined;
    if (conflict) throw new PayRefError('RECEIVABLE_LINK_CONFLICT', 'receivables-storage', 'This signed request is already linked to another business record. Choose the original record to avoid counting the same payment twice.', { receivableId: item.id, conflictingReceivableId: conflict.id, requestId: item.requestId! });
  }
  private current(id: string): Receivable {
    const item = this.read(id);
    if (!item) throw new PayRefError('RECEIVABLE_MISSING', 'receivables-storage', 'The business record is no longer available. Reload before editing.', { receivableId: id });
    return item;
  }
  linkRequest(id: string, requestId: Hex): void {
    const item = this.current(id), linked = transactionHash(requestId).toLowerCase() as Hex;
    if (item.requestId === linked) return;
    const updated = { ...item, requestId: linked, review: { state: 'open' as const, note: item.review.note, updatedAt: new Date().toISOString() } };
    this.checkLink(updated); this.write(updated);
  }
  addHash(id: string, hash: Hex): void {
    const item = this.current(id), next = transactionHash(hash).toLowerCase() as Hex;
    if (item.hashes.includes(next)) return;
    this.write({ ...item, hashes: [...item.hashes, next], review: { state: 'open', note: item.review.note, updatedAt: new Date().toISOString() } });
  }
  review(id: string, state: 'open' | 'reviewed', note: string, expectedNote?: string): void {
    const item = this.current(id);
    if (expectedNote !== undefined && item.review.note !== expectedNote) throw new PayRefError('RECEIVABLE_REVIEW_CONFLICT', 'receivables-storage', 'Another window updated this review note. The saved note was retained. Close and reopen this record to read the latest note before editing again.', { receivableId: id });
    this.write({ ...item, review: { state, note, updatedAt: new Date().toISOString() } });
  }
}

export function browserReceivables(): ReceivablesRepository {
  try { return new ReceivablesRepository(window.localStorage); }
  catch (cause) { throw new PayRefError('RECEIVABLE_STORAGE_UNAVAILABLE', 'receivables-storage', 'Local storage is unavailable. Business records cannot be saved.', {}, { cause }); }
}
