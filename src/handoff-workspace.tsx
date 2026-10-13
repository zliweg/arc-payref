import { useEffect, useState } from 'react';
import type { StoredRequest } from './storage';
import type { ScanResult } from './chain';
import type { VerifiedPayment } from './verification';
import type { Receivable } from './receivables';
import { browserReceivables } from './receivables-store';
import { errorText } from './errors';
import { HandoffPanel } from './handoff-panel';
import type { HandoffRecordInput } from './handoff';

export function HandoffWorkspace({ chainId, requests, payments, scans }: { chainId: number; requests: StoredRequest[]; payments: Record<string, VerifiedPayment[]>; scans: Record<string, ScanResult> }) {
  const [business, setBusiness] = useState<Receivable[]>([]);
  const [error, setError] = useState('');
  const [scope, setScope] = useState('business');
  useEffect(() => {
    const reload = () => { try { setBusiness(browserReceivables().list().filter(item => item.chainId === chainId)); setError(''); } catch (e) { setError(errorText(e)); } };
    reload(); window.addEventListener('storage', reload); window.addEventListener('payref-receivables', reload);
    return () => { window.removeEventListener('storage', reload); window.removeEventListener('payref-receivables', reload); };
  }, [chainId]);
  const scoped = requests.filter(entry => entry.request.domain.chainId === chainId);
  const snapshot = (id: string) => ({ capturedAt: new Date().toISOString(), payments: payments[id] ?? [], scan: scans[id] ?? null, note: 'Historical session snapshot. Reverify signatures and chain data; this file is not proof of settlement.' });
  const businessRecords: HandoffRecordInput[] = business.map(item => {
    const entry = requests.find(entry => entry.request.requestId.toLowerCase() === item.requestId?.toLowerCase());
    return { receivable: item, request: entry?.request ?? null, hashes: [...new Set([...item.hashes, ...(entry?.hashes ?? [])])], snapshot: entry ? snapshot(entry.request.requestId) : null };
  });
  const requestRecords: HandoffRecordInput[] = scoped.filter(entry => scope === 'requests' || !business.some(item => item.requestId?.toLowerCase() === entry.request.requestId.toLowerCase())).map(entry => ({ request: entry.request, receivable: null, hashes: entry.hashes, snapshot: snapshot(entry.request.requestId) }));
  const records = error ? [] : scope === 'requests' ? requestRecords : scope === 'all' ? [...businessRecords, ...requestRecords] : businessRecords;
  return <>
    <div className="work-tabs"><a href="/receivables">Business receivables</a><a href="/exceptions">Exception review</a><a className="active" href="/handoff">Handoff & recheck</a></div>
    {error && <div role="alert" className="message error">{error} Export is unavailable; independent file verification remains available.</div>}
    <section className="panel handoff-source"><label>Records to hand over<select aria-label="Handoff export scope" value={scope} onChange={event => setScope(event.target.value)}><option value="business">Business records, including unlinked rows</option><option value="all">Business records and other saved requests</option><option value="requests">Saved requests only</option></select></label><p>{records.length} records selected on this network. The package includes customer labels and notes; review them before sharing. Up to 100 records per package.</p></section>
    <HandoffPanel records={records}/>
  </>;
}
