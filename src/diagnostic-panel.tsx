import { errorText } from './errors';
import type { DiagnosisStatus, PaymentDiagnosis } from './diagnostics';

const titles: Record<DiagnosisStatus, string> = {
  verified: 'Payment verified', 'missing-memo': 'Request binding is missing', 'amount-mismatch': 'Amount does not match',
  'recipient-mismatch': 'Recipient does not match', unsupported: 'Unsupported transaction shape', reverted: 'Transaction reverted',
  pending: 'Payment is unresolved', 'rpc-error': 'Chain reads could not complete', 'evidence-mismatch': 'Evidence does not match',
  'wrong-network': 'RPC network does not match', cancelled: 'Diagnosis stopped',
};

export function DiagnosticPanel({ diagnosis }: { diagnosis: PaymentDiagnosis }) {
  return <section className="diagnostic-panel evidence-panel" aria-label="Read-only payment diagnosis">
    <div className="evidence-heading"><div><p className="eyebrow">READ-ONLY DIAGNOSIS</p><h3>{titles[diagnosis.status]}</h3></div></div>
    <p className="evidence-intro">Compare the signed request with chain observations. Matching individual fields does not establish payment; only the complete shared verifier can do that. This read-only diagnosis does not send a transaction.</p>
    <dl><dt>Transaction</dt><dd className="address">{diagnosis.hash}</dd><dt>Signed request</dt><dd className="address">{diagnosis.requestId}</dd></dl>
    <div className="table-wrap"><table className="diagnostic-table"><thead><tr><th scope="col">Check</th><th scope="col">Expected</th><th scope="col">Observed</th><th scope="col">Comparison</th></tr></thead><tbody>
      {diagnosis.checks.map(check => <tr key={check.key}><th scope="row">{check.label}</th><td className="address">{check.expected}</td><td className="address">{check.observed}</td><td>{check.state === 'match' ? 'Matches this field' : check.state === 'mismatch' ? 'Does not match' : 'Not established'}</td></tr>)}
    </tbody></table></div>
    {diagnosis.issues.length > 0 && <ul className="diagnostic-issues">{diagnosis.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
    {diagnosis.status === 'verified' && diagnosis.payment && <p className="evidence-coverage complete">The complete payment evidence passed verification at block {diagnosis.payment.block}. This single-transaction check does not rule out another payment.</p>}
    {diagnosis.status !== 'verified' && <p className="evidence-boundary">This result does not confirm payment for the signed request. Do not resend or change a payment record based only on these observations.</p>}
    {diagnosis.error && <details className="diagnostic-error"><summary>Diagnostic details</summary><p>{errorText(diagnosis.error)}</p></details>}
  </section>;
}
