import { useEffect, useRef, useState } from 'react';
import { network } from './config';
import { errorText, PayRefError } from './errors';
import { buildHandoff, compareHandoff, HANDOFF_LIMITS, HANDOFF_VERIFIER_VERSION, previewHandoff, summarizeHandoff, verifyHandoff } from './handoff';
import type { HandoffPackage, HandoffRecordInput, HandoffRecordResult, HandoffVerification } from './handoff';
import { download } from './storage';
import { Icon, money, short } from './ui';
import { mergePayments } from './verification';

export interface HandoffPanelProps {
  records?: HandoffRecordInput[];
  onVerified?: (result: HandoffVerification) => void;
}

export function HandoffPanel({ records = [], onVerified }: HandoffPanelProps) {
  const [packet, setPacket] = useState<HandoffPackage | null>(null);
  const [results, setResults] = useState<HandoffRecordResult[]>([]);
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [progress, setProgress] = useState('');
  const control = useRef<AbortController | null>(null), generation = useRef(0);
  const liveResults = useRef<HandoffRecordResult[]>([]);
  useEffect(() => () => { generation.current++; control.current?.abort(); }, []);

  function selectPacket(next: HandoffPackage) {
    control.current?.abort(); liveResults.current = []; setResults([]); setPacket(next); setProgress('');
  }
  async function load(file: File | undefined) {
    if (!file) return;
    const run = ++generation.current;
    control.current?.abort(); setBusy(true); setError(''); setMessage(''); setPacket(null); setResults([]); liveResults.current = [];
    try {
      if (file.size > HANDOFF_LIMITS.bytes) throw new PayRefError('HANDOFF_TOO_LARGE', 'handoff', 'Choose a handoff JSON file no larger than 2 MiB.');
      const next = await previewHandoff(await file.text());
      if (generation.current !== run) return;
      selectPacket(next); setMessage('File structure and request signatures checked. Historical payment claims have not been reverified. Nothing was imported into browser storage.');
    } catch (cause) { if (generation.current === run) setError(errorText(cause)); }
    finally { if (generation.current === run) setBusy(false); }
  }
  async function exportWorkspace() {
    const run = ++generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await buildHandoff(records);
      if (generation.current !== run) return;
      download(`payref-handoff-${next.createdAt.slice(0, 10)}.json`, JSON.stringify(next, null, 2));
      selectPacket(next); setMessage('Handoff download initiated. Check that the file was saved. It includes business notes and full signed requests; share it only with the intended recipient.');
    } catch (cause) { if (generation.current === run) setError(errorText(cause)); }
    finally { if (generation.current === run) setBusy(false); }
  }
  async function check(mode: 'hashes' | 'scan') {
    if (!packet || busy) return;
    const run = ++generation.current, controller = new AbortController(); control.current = controller;
    setBusy(true); setChecking(true); setError(''); setMessage('');
    const preceding = new Map(liveResults.current.map(item => [item.recordKey, item]));
    const merged = new Map<string, HandoffRecordResult>();
    const retain = (next: HandoffRecordResult): HandoffRecordResult => {
      const previous = preceding.get(next.recordKey), item = packet.records.find(record => record.recordKey === next.recordKey)!;
      const payments = mergePayments(previous?.payments ?? [], next.payments);
      return { ...next, payments, comparison: compareHandoff(item, payments, next.scan), verifiedAt: next.verifiedAt ?? previous?.verifiedAt ?? null };
    };
    try {
      const result = await verifyHandoff(packet, { mode, signal: controller.signal,
        onProgress: update => { if (generation.current === run) setProgress(`Record ${update.index + 1}/${update.total}: ${update.message}`); },
        onResult: update => {
          if (generation.current !== run) return;
          merged.set(update.recordKey, retain(update));
          liveResults.current = packet.records.flatMap(item => {
            const current = merged.get(item.recordKey) ?? preceding.get(item.recordKey); return current ? [current] : [];
          });
          setResults(liveResults.current);
        },
      });
      if (generation.current !== run) return;
      const completed = { ...result, records: result.records.map(retain) };
      liveResults.current = completed.records; setResults(completed.records); onVerified?.(completed);
      setMessage(result.cancelled ? 'Verification stopped. Completed checks remain visible; remaining records and ranges are unverified.' : mode === 'hashes' ? 'Known-transaction checks finished. Review each result below. Full-range duplicate lookup has not run.' : 'Read operations finished. Review coverage and failures for every record; incomplete ranges remain unverified.');
    } catch (cause) { if (generation.current === run) setError(errorText(cause)); }
    finally { if (generation.current === run) { setBusy(false); setChecking(false); setProgress(''); control.current = null; } }
  }

  const summaries = packet ? summarizeHandoff(packet, results) : [];
  const sharedRequests = packet ? packet.records.filter(item => item.request).length - new Set(packet.records.filter(item => item.request).map(item => `${item.request!.domain.chainId}:${item.request!.requestId}`)).size : 0;
  return <section className="handoff-panel" aria-label="Independent handoff verification">
    <div className="panel handoff-controls">
      <div className="panel-title"><Icon name="archive"/><div><h2>Verify a handoff</h2><p>Open a package in any browser and check its signed requests and chain evidence independently.</p></div></div>
      <p>No wallet connection or local import is needed. Business rows, review notes and exported payment results are historical claims. The JSON is not an offline proof of payment.</p>
      <div className="actions">
        <label className="upload-zone"><Icon name="archive"/><strong>Open handoff JSON</strong><span>Preview signatures, then independently recheck receipts</span><input aria-label="Open handoff JSON" type="file" accept=".json,application/json" disabled={busy} onChange={event => { void load(event.target.files?.[0]); event.target.value = ''; }}/></label>
        {!!records.length && <button className="secondary" disabled={busy || records.length > HANDOFF_LIMITS.records} onClick={() => void exportWorkspace()}><Icon name="download"/>Download workspace handoff ({records.length})</button>}
      </div>
      <small>Maximum 100 records, 100 transaction hashes per record and 2 MiB. Full business notes and signatures are included. The package is not encrypted.</small>
      {records.length > HANDOFF_LIMITS.records && <p className="inline-warning">This selection exceeds 100 records. Narrow the workspace selection before downloading.</p>}
      {packet && <><div className="actions handoff-verification-actions">
        <button disabled={busy} onClick={() => void check('hashes')}><Icon name="shield"/>Verify known transactions</button>
        <button className="secondary" disabled={busy} onClick={() => void check('scan')}><Icon name="search"/>Run full-range lookup</button>
        <button className="secondary" disabled={busy} onClick={() => window.print()}>Print readable summary</button>
        {checking && <button className="secondary" onClick={() => { control.current?.abort(); setProgress('Stopping after the active read settles. Completed evidence will remain visible.'); }}>Stop verification</button>}
      </div><p>Known-transaction verification does not search for other payments. Full-range lookup starts again at each signed request’s creation block, may take time, and can be stopped. All reads use the app’s fixed Arc RPC configuration.</p></>}
      {progress && <p role="status">{progress}</p>}
      {message && <p role="status">{message}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>

    {packet && <div className="handoff-summary">
      <header className="panel"><p className="eyebrow">PORTABLE HANDOFF · VERSION {packet.version}</p><h2>Business records · signed requests · chain receipts</h2>
        <p>Package created {packet.createdAt}. Exporter: {packet.verifierVersion}. Current verifier: {HANDOFF_VERIFIER_VERSION}.</p>
        <p>Request signatures were checked in this browser. The totals below use only chain evidence independently verified during this session. They do not certify identity, service delivery, tax treatment or the accuracy of business notes.</p>
        {sharedRequests > 0 && <p className="inline-warning">{sharedRequests} additional business association(s) share a signed request. Request and receipt totals are counted once, not once per business row.</p>}
      </header>
      {summaries.map(summary => <section className="panel" key={summary.chainId} aria-label={`${network(summary.chainId).name} handoff totals`}>
        <h3>{network(summary.chainId).name}{network(summary.chainId).testnet ? ' · test funds' : ''}</h3>
        <dl className="handoff-totals"><dt>Business amount ({summary.businessCount} rows · human declaration)</dt><dd>{money(summary.businessAmount)} USDC</dd><dt>Signed amount ({summary.requestCount} unique requests · not income)</dt><dd>{money(summary.signedAmount)} USDC</dd><dt>Verified receipts ({summary.paymentCount} unique payments)</dt><dd>{money(summary.verifiedAmount)} USDC</dd></dl>
        {!results.length && <p>Chain verification has not run. Zero verified receipts means no evidence has been checked in this session.</p>}
      </section>)}
      {packet.records.map((item, index) => {
        const result = results.find(value => value.recordKey === item.recordKey), comparison = result?.comparison ?? compareHandoff(item, [], null);
        const chainId = item.request?.domain.chainId ?? item.receivable!.chainId;
        const mismatches = [['Reference', comparison.referenceMatches], ['Amount', comparison.amountMatches], ['Network', comparison.networkMatches], ['Request association', comparison.requestMatches]].filter(([, matches]) => matches === false);
        return <article className="panel handoff-record" key={item.recordKey}>
          <div className="panel-title"><h3>{index + 1}. {item.receivable?.reference ?? item.request!.message.reference}</h3><span className="badge neutral">{network(chainId).name}</span></div>
          <p className="address">Record {item.recordKey}</p>
          <div className="handoff-three-way">
            <section><h4>Business declaration</h4>{item.receivable ? <><p>{money(item.receivable.amount)} USDC · {item.receivable.customer || 'No customer label'}</p><p>{item.receivable.note || 'No business note'}</p><p>Source: {item.receivable.source.name}, row {item.receivable.source.row}</p><p>Human review: {item.receivable.review.state}. {item.receivable.review.note || 'No review note'}</p></> : <p>No business receivable attached.</p>}</section>
            <section><h4>Signed request</h4>{item.request ? <><p>{money(item.request.message.amount)} USDC · {item.request.message.reference}</p><p>{item.request.message.description || 'No request description'}</p><p className="address">Payee: {item.request.message.payee}</p><p className="address">Request: {item.request.requestId}</p><p>Wallet signature valid. This does not confirm the business declaration.</p></> : <p className="inline-warning">Missing signed request. Transaction hashes alone cannot be verified as a PayRef payment.</p>}</section>
            <section><h4>Chain receipts</h4><p>{result ? `${result.payments.length} matching receipt(s), ${money(comparison.verifiedAmount)} USDC` : 'Not verified in this session.'}</p><p>Known hashes: {result?.hashChecks.length ?? 0}/{item.hashes.length} checked.</p><p>Range lookup: {result?.scan ? result.scan.complete ? `complete through block ${result.scan.checkedThroughBlock}` : 'incomplete' : 'not run'}.</p>{result?.verifiedAt && <p>Evidence last read: {result.verifiedAt}. Previous successful receipts remain visible if a later read fails.</p>}</section>
          </div>
          {!!mismatches.length && <p className="inline-warning">Business/request mismatch: {mismatches.map(([label]) => label).join(', ')}. A valid request signature does not resolve this discrepancy.</p>}
          {result?.state === 'not-run' && <p>Not run. This record was not reached.</p>}
          {result?.state === 'checking' && <p role="status">Checking this record…</p>}
          {result?.state === 'cancelled' && <p className="inline-warning">Cancelled. Completed evidence is retained; remaining checks are incomplete.</p>}
          {result && result.payments.length > 1 && <p className="inline-warning">Duplicate payment detected: {result.payments.length} independently verified receipts match this request. No refund has been initiated.</p>}
          {result?.payments.map(payment => <p key={`${payment.chainId}:${payment.hash}:${payment.logIndex}`}><a className="address" href={`${network(payment.chainId).blockExplorers.default.url}/tx/${payment.hash}`} target="_blank" rel="noreferrer">{short(payment.hash)} ↗</a> · {money(payment.amount)} USDC · block {payment.block}{payment.late ? ' · paid after the deadline' : ''}</p>)}
          {result?.scan && <p>Requested blocks {result.scan.fromBlock}–{result.scan.targetBlock}; checked through {result.scan.checkedThroughBlock ?? 'no complete segment'}. {result.scan.complete ? 'Coverage ends at the stated block; future payments are outside this result.' : 'The remaining range must be checked before excluding another payment.'}</p>}
          {!result?.scan?.complete && <p>Duplicate-payment lookup is incomplete. A matching receipt proves that payment, without ruling out another payment.</p>}
          {!!result?.scan?.anomalies.length && <details open><summary>Unmatched Memo records ({result.scan.anomalies.length})</summary>{result.scan.anomalies.map(anomaly => <p key={anomaly.hash}><span className="address">{anomaly.hash}</span>: {anomaly.reason}</p>)}</details>}
          {!!result?.errors.length && <div className="handoff-errors" role="note"><h4>Checks needing attention</h4>{result.errors.map((failure, failureIndex) => <p className="field-error" key={failureIndex}>{failure.message}{failure.hash && <> · <span className="address">{failure.hash}</span></>}</p>)}</div>}
          {item.snapshot && <details className="handoff-history"><summary>Historical snapshot · untrusted until rechecked</summary><p>Captured {item.snapshot.capturedAt}. The exporter claimed {item.comparison.paymentCount} receipt(s), {money(item.comparison.verifiedAmount)} USDC and “{item.comparison.coverage}” coverage. These values were not used in current verification.</p><p>Exporter note: {item.snapshot.note || 'None'}</p>{item.snapshot.scan && <p>Claimed blocks {item.snapshot.scan.fromBlock}–{item.snapshot.scan.targetBlock}; claimed checked-through {item.snapshot.scan.checkedThroughBlock ?? 'none'}.</p>}{item.snapshot.scan?.anomalies.map((anomaly, anomalyIndex) => <p key={anomalyIndex}>Historical exception: {anomaly.hash} · {anomaly.reason}</p>)}</details>}
        </article>;
      })}
      <p className="handoff-boundary">This summary distinguishes human business declarations, valid wallet signatures and independently queried chain evidence. An exported snapshot or a printed page cannot replace a fresh chain check. Arc Testnet evidence uses test funds.</p>
    </div>}
  </section>;
}
