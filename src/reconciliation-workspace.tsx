import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Hex } from 'viem';
import type { SignedRequest } from './protocol';
import { requestLink } from './protocol';
import type { ScanResult } from './chain';
import type { StoredRequest } from './storage';
import { download, locked, transactionHash } from './storage';
import type { VerifiedPayment } from './verification';
import { errorText, PayRefError } from './errors';
import { network } from './config';
import { Empty, Icon, money, short } from './ui';
import { createReceivable, exportReceivablesCsv, exportReceivablesJson, inspectReceivables, reconcileReceivable } from './receivables';
import type { Receivable, ReceivablePreview } from './receivables';
import { browserReceivables } from './receivables-store';
import { diagnosePayment } from './diagnostics';
import type { PaymentDiagnosis } from './diagnostics';
import { DiagnosticPanel } from './diagnostic-panel';

interface Props {
  chainId: number;
  mode: 'receivables' | 'exceptions';
  requests: StoredRequest[];
  payments: Record<string, VerifiedPayment[]>;
  scans: Record<string, ScanResult>;
  onPayment: (request: SignedRequest, payment: VerifiedPayment) => Promise<void>;
  onScan: (request: SignedRequest, controller: AbortController) => Promise<ScanResult>;
}

export function ReconciliationWorkspace({ chainId, mode, requests, payments, scans, onPayment, onScan }: Props) {
  const [records, setRecords] = useState<Receivable[]>([]);
  const [storageError, setStorageError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState<ReceivablePreview>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [reviewFilter, setReviewFilter] = useState('all');
  const [linkId, setLinkId] = useState('');
  const [hash, setHash] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const reviewBase = useRef('');
  const [diagnosis, setDiagnosis] = useState<PaymentDiagnosis>();
  const controller = useRef<AbortController | undefined>(undefined);
  const active = useRef(true);
  const running = useRef(false);
  const reload = useCallback(() => {
    try { setRecords(browserReceivables().list().filter(item => item.chainId === chainId)); setStorageError(''); }
    catch (e) { setStorageError(errorText(e)); }
  }, [chainId]);
  useEffect(() => {
    active.current = true; reload();
    const listener = () => reload();
    window.addEventListener('storage', listener);
    window.addEventListener('payref-receivables', listener);
    return () => { active.current = false; controller.current?.abort(); window.removeEventListener('storage', listener); window.removeEventListener('payref-receivables', listener); };
  }, [reload]);
  const selected = records.find(item => item.id === selectedId);
  const association = `${selected?.id ?? ''}:${selected?.requestId ?? ''}`;
  const associationRef = useRef(association); associationRef.current = association;
  useEffect(() => { controller.current?.abort(); setLinkId(selected?.requestId ?? ''); reviewBase.current = selected?.review.note ?? ''; setReviewNote(reviewBase.current); setHash(''); setDiagnosis(undefined); }, [selectedId, selected?.requestId]);
  useEffect(() => {
    const latest = selected?.review.note ?? '';
    if (reviewNote === reviewBase.current) { reviewBase.current = latest; setReviewNote(latest); }
  }, [selected?.review.note]);
  const rows = records.map(item => ({ item, result: reconcileReceivable(item, requests, payments, scans) }));
  const needsReview = (row: typeof rows[number]) => row.result.business.status !== 'match' || row.result.payment.status !== 'verified' || row.result.query.status !== 'complete' || !!row.result.request && !!scans[row.result.request.requestId]?.anomalies.length;
  const exceptions = rows.filter(needsReview);
  const visible = (mode === 'exceptions' ? exceptions : rows).filter(({ item }) => (!query || `${item.reference} ${item.customer} ${item.note}`.toLowerCase().includes(query.toLowerCase())) && (reviewFilter === 'all' || item.review.state === reviewFilter));
  const current = selected ? reconcileReceivable(selected, requests, payments, scans) : undefined;
  const req = current?.request;
  const knownHashes = [...new Set([...(selected?.hashes ?? []), ...(req ? requests.find(entry => entry.request.requestId === req.requestId)?.hashes ?? [] : []), ...(req ? scans[req.requestId]?.anomalies.map(item => item.hash) ?? [] : [])])];
  const standaloneExceptions = requests.filter(entry => entry.request.domain.chainId === chainId && !records.some(item => item.requestId === entry.request.requestId) && (payments[entry.request.requestId]?.length > 1 || scans[entry.request.requestId]?.anomalies.length || scans[entry.request.requestId] && !scans[entry.request.requestId].complete));

  async function run(operation: () => Promise<void> | void) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { controller.current = undefined; running.current = false; if (active.current) { setBusy(false); reload(); } }
  }
  function select(item: Receivable) { if (!running.current) setSelectedId(item.id); }
  async function importFile(file: File) {
    setPreview(undefined);
    if (file.size > 1024 * 1024) throw new PayRefError('FILE_TOO_LARGE', 'receivables-import', 'Business import limit is 1 MiB.');
    const raw = await file.text();
    if (!active.current) return;
    setPreview(inspectReceivables(raw, file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv', chainId, file.name));
  }
  async function mergeImport() {
    if (!preview) return;
    let saved = 0;
    await locked('receivables', async () => {
      for (const item of preview.entries) {
        try { browserReceivables().save(item); saved++; }
        catch (cause) { throw new PayRefError('PARTIAL_BUSINESS_IMPORT', 'receivables-import', `Saved ${saved} of ${preview.entries.length} records. Import stopped; existing records were retained. ${errorText(cause)}`, { recordId: item.id }, { cause }); }
      }
    });
    setPreview(undefined); setNotice(`Saved ${saved} business records. Business data is not payment evidence.`);
  }
  function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    void run(async () => {
      const item = createReceivable({ chainId, reference: String(data.get('reference')), amount: String(data.get('amount')), customer: String(data.get('customer')), note: String(data.get('note')) });
      await locked('receivables', async () => browserReceivables().save(item));
      if (active.current) { setSelectedId(item.id); setNotice('Business record saved. Link or create a signed request next.'); form.reset(); }
    });
  }
  async function linkRequest() {
    if (!selected || !linkId) return;
    const target = requests.find(entry => entry.request.requestId === linkId && entry.request.domain.chainId === chainId);
    if (!target) throw new PayRefError('REQUEST_NOT_FOUND', 'reconciliation', 'Choose a saved request on this network.');
    await locked('receivables', async () => browserReceivables().linkRequest(selected.id, transactionHash(linkId)));
    setDiagnosis(undefined); setNotice('Request explicitly linked. Review any business differences before treating the record as reconciled.');
  }
  async function diagnose(value: string) {
    if (!selected || !req) return;
    const startedFor = association;
    const txHash = transactionHash(value.trim()); const operation = new AbortController(); controller.current = operation;
    await locked('receivables', async () => browserReceivables().addHash(selected.id, txHash));
    const result = await diagnosePayment(req, txHash, { signal: operation.signal });
    if (!active.current) return;
    if (associationRef.current !== startedFor) { setNotice('The business association changed during this check. Run a new check for the current request.'); return; }
    if (operation.signal.aborted) { setDiagnosis(result); setNotice('Read cancelled. No payment conclusion was recorded.'); return; }
    setDiagnosis(result);
    if (result.payment) await onPayment(req, result.payment);
    if (active.current) setNotice(result.payment ? 'Payment verified against the signed request. Business differences and duplicate checks remain separate.' : 'Diagnosis complete. No matching payment was recorded from this transaction.');
  }
  async function scan() {
    if (!req) return;
    const startedFor = association;
    const operation = new AbortController(); controller.current = operation;
    const result = await onScan(req, operation);
    if (active.current && associationRef.current !== startedFor) { setNotice('The business association changed during this check. The original request keeps its completed evidence.'); return; }
    if (active.current) setNotice(result.complete ? `Full lookup completed through block ${result.targetBlock}.` : result.error ?? 'Lookup incomplete.');
  }
  async function review(state: 'open' | 'reviewed') {
    if (!selected) return;
    await locked('receivables', async () => browserReceivables().review(selected.id, state, reviewNote, reviewBase.current));
    reviewBase.current = reviewNote;
    setNotice('Review note saved. Payment evidence and business differences were not changed.');
  }

  return <div className="reconciliation-workspace">
    <div className="work-tabs"><a className={mode === 'receivables' ? 'active' : ''} href="/receivables">Business receivables</a><a className={mode === 'exceptions' ? 'active' : ''} href="/exceptions">Exception review</a><a href="/handoff">Handoff & recheck <Icon name="arrow" size={14}/></a></div>
    {storageError && <div role="alert" className="message error">{storageError}</div>}
    {error && <div role="alert" className="message error">{error}</div>}
    {notice && <div role="status" className="message">{notice}</div>}
    {busy && <div className="message" role="status">Working… {controller.current && <button className="text-button" onClick={() => controller.current?.abort()}>Cancel read</button>}</div>}
    <section className="recon-metrics" aria-label="Business reconciliation overview">
      <article><span>Business records</span><strong>{storageError ? '—' : records.length}</strong><small>Local declarations on {network(chainId).name}</small></article>
      <article><span>Verified payment links</span><strong>{storageError ? '—' : rows.filter(row => row.result.payment.status !== 'not-verified').length}</strong><small>Does not confirm business agreement</small></article>
      <article><span>Business differences</span><strong>{storageError ? '—' : rows.filter(row => row.result.business.status === 'mismatch').length}</strong><small>Compare the bill with the signed request</small></article>
      <article><span>Needs a check</span><strong>{storageError ? '—' : exceptions.length}</strong><small>Unlinked, unverified or incomplete</small></article>
    </section>
    {mode === 'receivables' && <section className="panel business-intake">
      <div className="panel-heading"><div><p className="eyebrow">START WITH YOUR EXISTING RECORDS</p><h2>Bring the work into the payment record.</h2><p>Import a business list, then link each row to a signed request. No wallet needed to organize or verify.</p></div><Icon name="list" size={28}/></div>
      <div className="intake-grid"><label className="upload-zone"><Icon name="download"/><strong>Import business CSV or JSON</strong><span>Up to 100 rows · 1 MiB · review before merging</span><input aria-label="Import business records" type="file" accept=".csv,.json,text/csv,application/json" disabled={busy || !!storageError} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => importFile(file)); }}/></label><div><h3>A reference, an amount, a clear connection.</h3><p>CSV columns: <code>reference,amount,customer,note,request_id,tx_hash,chain_id</code>. Only reference and amount are required; the selected network is the default.</p><button className="text-button" onClick={() => download('payref-business-template.csv', 'reference,amount,customer,note,request_id,tx_hash,chain_id\r\n', 'text/csv;charset=utf-8')}>Download blank CSV template</button><p className="scope-note">Importing a “paid” label cannot establish a payment. Customer names and notes are your own records.</p></div></div>
      <details className="manual-receivable"><summary>Add a business record manually</summary><form onSubmit={addManual}><label>Business reference<input name="reference" required maxLength={128}/></label><label>Expected amount (USDC)<input name="amount" required inputMode="decimal" placeholder="100.00"/></label><label>Customer label <span className="optional">local only</span><input name="customer" maxLength={128}/></label><label>Business note<textarea name="note" maxLength={512} rows={2}/></label><button disabled={busy || !!storageError}>Add receivable</button></form></details>
    </section>}
    {preview && <section className="panel business-preview" aria-label="Business import preview"><div className="panel-heading"><div><h2>{preview.entries.length} valid · {preview.errors.length} rejected</h2><p>Unsigned business records. Review the network, amount and request ID before merging.</p></div><button className="text-button" disabled={busy} onClick={() => setPreview(undefined)}>Discard preview</button></div>
      {preview.errors.length > 0 && <ul className="import-errors">{preview.errors.map((item, index) => <li key={index}>Row {item.row}: {item.message}</li>)}</ul>}
      <div className="table-scroll"><table><thead><tr><th>Source row</th><th>Reference</th><th>Expected USDC</th><th>Network</th><th>Request association</th></tr></thead><tbody>{preview.entries.map(item => <tr key={item.id}><td>{item.source.row}</td><td>{item.reference}</td><td>{money(item.amount)}</td><td>{network(item.chainId).name}</td><td>{item.requestId ? short(item.requestId) : 'Needs an explicit link'}</td></tr>)}</tbody></table></div>
      <div className="actions"><button disabled={busy || !!storageError || !preview.entries.length} onClick={() => void run(mergeImport)}>Import validated business records</button></div></section>}
    <section className="panel business-list"><div className="panel-heading"><div><h2>{mode === 'exceptions' ? 'Records that need a closer look' : 'Your business receivables'}</h2><p>Business agreement, payment evidence and query coverage are separate. Receipt evidence is checked per session; after a page reload, recheck known transactions. Zero verified links does not mean unpaid.</p></div><a href="/handoff" className="text-link">Prepare a handoff <Icon name="arrow"/></a></div>
      <div className="business-filters"><input aria-label="Search business records" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search reference, customer or note…"/><select aria-label="Review state" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)}><option value="all">All review states</option><option value="open">Open review</option><option value="reviewed">Reviewed by you</option></select></div>
      {storageError ? <Empty title="Business records unavailable">Existing data was preserved. Resolve the storage error before editing records.</Empty> : !visible.length ? <Empty title={records.length ? 'No records in this view' : 'Start with a business record'}>Import your existing list or add a record. Verified receipts will only appear after a chain check.</Empty> : <div className="table-scroll"><table className="business-table"><thead><tr><th>Business / customer</th><th>Expected</th><th>Request comparison</th><th>Payment evidence</th><th>Review</th></tr></thead><tbody>{visible.map(({ item, result }) => <tr key={item.id} className={selectedId === item.id ? 'selected-row' : ''}><td><button className="request-name" disabled={busy} onClick={() => select(item)}><strong>{item.reference}</strong></button><small>{item.customer || 'No customer label'}</small></td><td className="number">{money(item.amount)}<small>USDC</small></td><td><span className={`recon-label ${result.business.status}`}>{result.business.status === 'match' ? 'Business matches request' : result.business.status === 'mismatch' ? 'Business differs' : 'Not linked'}</span></td><td><span className={`recon-label ${result.payment.status}`}>{result.payment.status === 'duplicate' ? 'Duplicate payments' : result.payment.status === 'verified' ? 'Payment verified' : 'Not verified'}</span><small>{result.query.status === 'complete' ? `Checked to ${result.query.checkedThroughBlock}` : 'Duplicate check incomplete'}</small></td><td><button className="secondary" disabled={busy} aria-label={`Review ${item.reference}`} onClick={() => select(item)}>{item.review.state === 'reviewed' ? 'Reviewed · open' : 'Review'} <Icon name="arrow" size={14}/></button></td></tr>)}</tbody></table></div>}
      <div className="table-footer"><span>{visible.length} of {records.length} business records</span><div className="actions"><button className="text-button" disabled={busy || !!storageError || !visible.length} onClick={() => void run(() => { download('payref-business-reconciliation.csv', exportReceivablesCsv(visible.map(row => row.item), requests, payments, scans), 'text/csv;charset=utf-8'); setNotice('CSV download initiated. It is a reconciliation report, not a complete recovery file.'); })}>Export comparison CSV</button><button className="text-button" disabled={busy || !!storageError || !records.length} onClick={() => void run(() => { download('payref-business-records.json', exportReceivablesJson(records)); setNotice('Business JSON download initiated. Keep a request backup or handoff package for the original signatures.'); })}>Export business JSON</button></div></div>
    </section>
    {selected && current && !storageError && <section className="panel business-detail" aria-label="Business record details"><div className="panel-heading"><div><p className="eyebrow">THREE PARTS OF ONE RECORD</p><h2>{selected.reference}</h2><p>{selected.customer || 'No customer label'} · {selected.source.name}, row {selected.source.row}</p></div><button className="icon-button" aria-label="Close business details" disabled={busy} onClick={() => setSelectedId('')}><Icon name="close"/></button></div>
      <div className="three-way"><article><span>01 · Your business record</span><strong>{money(selected.amount)} <small>USDC</small></strong><p>{selected.note || 'No business note'}</p><small>Unsigned local declaration</small></article><article><span>02 · Signed request</span><strong>{req ? money(req.message.amount) : 'Not linked'} {req && <small>USDC</small>}</strong><p>{req?.message.reference ?? 'Link a saved request or create one below.'}</p><small>{req ? `Signed by ${short(req.message.payee)}` : 'A matching amount alone is not a link'}</small></article><article><span>03 · Verified payment</span><strong>{current.payment.payments.length ? money(current.payment.payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n)) : 'Not verified'} {current.payment.payments.length > 0 && <small>USDC</small>}</strong><p>{current.payment.status === 'duplicate' ? 'Multiple qualifying payments found.' : current.payment.payments.length ? 'Matches the signed request.' : 'Run a read-only chain check.'}</p><small>{current.query.status === 'complete' ? `Full lookup to block ${current.query.checkedThroughBlock}` : 'Full duplicate-payment lookup not completed'}</small></article></div>
      {current.business.differences.length > 0 && <div className="difference-box"><strong>Business record differs from the signed request</strong>{current.business.differences.map((difference, index) => <p key={index}>{difference.field}: business record <b>{difference.field === 'amount' ? `${money(difference.expected)} USDC` : difference.expected}</b> · signed request <b>{difference.field === 'amount' ? `${money(difference.actual)} USDC` : difference.actual}</b></p>)}<p>A verified payment does not resolve this business difference. Confirm the agreement with the other party.</p></div>}
      <div className="business-detail-grid"><div><h3>Connect the business record</h3><p>Choose deliberately. Similar references and amounts are suggestions, not proof.</p><label>Signed request<select aria-label="Link signed request" value={linkId} disabled={busy} onChange={e => setLinkId(e.target.value)}><option value="">Choose a saved request</option>{requests.filter(entry => entry.request.domain.chainId === chainId).map(({ request }) => <option key={request.requestId} value={request.requestId}>{request.message.reference} · {money(request.message.amount)} USDC · {short(request.requestId)}</option>)}</select></label><div className="actions"><button className="secondary" disabled={busy || !linkId || selected.requestId === linkId} onClick={() => void run(linkRequest)}>Link selected request</button>{!selected.requestId && <a className="text-link" href={`/requests/new#receivable=${encodeURIComponent(selected.id)}`}>Create a signed request <Icon name="plus" size={14}/></a>}</div>{current.candidates.length > 0 && !req && <p>{current.candidates.length} similar saved request(s). Review the complete details before choosing.</p>}{selected.requestId && linkId && selected.requestId !== linkId && <p className="inline-warning">Replacing this association does not revoke the earlier signed request or its payment link.</p>}{req && <a className="text-link" href={requestLink(req, location.origin)}>Open signed request <Icon name="arrow" size={14}/></a>}</div>
      <div><h3>Check the actual payment</h3><p>Read-only checks. Hashes stay available even when a payment does not match.</p><label>Transaction to diagnose<input aria-label="Business transaction hash" disabled={busy || !req} value={hash} onChange={e => setHash(e.target.value)} placeholder="0x…"/></label><div className="actions"><button disabled={busy || !req || !hash} onClick={() => void run(() => diagnose(hash))}>Diagnose transaction</button><button className="secondary" disabled={busy || !req} onClick={() => void run(scan)}>Check full payment range</button></div>{knownHashes.length > 0 && <label>Known transactions<select aria-label="Business known transaction" value="" disabled={busy} onChange={e => setHash(e.target.value)}><option value="">Choose a hash to inspect</option>{knownHashes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}</div></div>
      {diagnosis && <DiagnosticPanel diagnosis={diagnosis}/>}
      {req && scans[req.requestId]?.anomalies.map(item => <div className="difference-box" key={item.hash}><strong>Unmatched Memo record</strong><p className="address">{item.hash}</p><p>{item.reason}</p><button className="secondary" disabled={busy} onClick={() => { setHash(item.hash); void run(() => diagnose(item.hash)); }}>Explain this transaction</button></div>)}
      <section className="manual-review"><h3>Your review note</h3><p>For example: contacted the payer, awaiting clarification. Marking reviewed does not change payment evidence or resolve a business difference.</p><label>Review note<textarea aria-label="Business review note" value={reviewNote} maxLength={512} disabled={busy} onChange={e => setReviewNote(e.target.value)} rows={3}/></label><div className="actions"><button className="secondary" disabled={busy} onClick={() => void run(() => review('open'))}>Save note · keep open</button><button className="secondary" disabled={busy || !reviewNote.trim()} onClick={() => void run(() => review('reviewed'))}>Mark reviewed</button><span>{selected.review.state === 'reviewed' ? 'Reviewed by you' : 'Open review'}</span></div></section>
    </section>}
    {mode === 'exceptions' && standaloneExceptions.length > 0 && <section className="panel"><h2>Other signed requests needing attention</h2><p>These requests have no business record linked yet. Their payment evidence is preserved.</p>{standaloneExceptions.map(({ request }) => <a key={request.requestId} className="attention-row" href={requestLink(request, location.origin)}><strong>{request.message.reference}</strong><span>{payments[request.requestId]?.length > 1 ? 'Duplicate payments' : scans[request.requestId]?.anomalies.length ? 'Unmatched Memo records' : 'Lookup incomplete'}</span><Icon name="arrow"/></a>)}</section>}
  </div>;
}
