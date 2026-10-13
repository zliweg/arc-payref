import proof from '../public/mainnet-proof.json';
import { requestLink } from './protocol';
import type { SignedRequest } from './protocol';
import type { Hex } from 'viem';
import { Icon } from './ui';
import './mainnet-showcase.css';

// Published historical evidence, never a cached PAID result. App decodes and
// verifies this request through the same path as any user-supplied receipt.
export function mainnetDemoParams() {
  const entry = proof.requests[0];
  return new URLSearchParams(requestLink(entry.request as SignedRequest, '', entry.hashes[0] as Hex).split('#')[1]);
}

export function MainnetShowcase() {
  return <section className="mainnet-showcase" aria-label="What PayRef does and mainnet evidence">
    <div className="proof-card">
      <div className="proof-copy"><p className="eyebrow">REAL MAINNET PAYMENT · 13 OCT 2026</p>
        <h2>See the payment. Recheck the evidence.</h2>
        <p>A real <strong>0.01 USDC</strong> payment between the builder’s own wallets, with a network fee of <strong>0.001352240077889024 USDC</strong>. Open the original signed request and query the receipt yourself.</p>
        <div className="actions"><a className="button" href="/receipt#demo=mainnet"><Icon name="shield"/>Recheck mainnet payment</a><a className="text-link" href={`https://explorer.arc.io/tx/${proof.requests[0].hashes[0]}`} target="_blank" rel="noreferrer">View on Arc Explorer ↗</a></div>
        <p className="proof-scope">No wallet connection or payment needed. This is historical test evidence, not customer adoption or a live balance.</p>
      </div>
      <aside className="proof-arc"><p className="eyebrow">WHY ARC</p><h3>A business reference tied to the transfer.</h3><p>Arc Memo links the signed request digest to the payment call. PayRef checks that link and the actual USDC transfer together. Payments and network fees use USDC.</p><a className="text-link" href="/mainnet-proof.json" download>Download original evidence <Icon name="download" size={14}/></a></aside>
    </div>
    <div className="value-grid">
      <article><span className="value-number">01 / RECONCILE</span><h3>Expected. Signed. Received.</h3><p>Compare business receivables, wallet-signed requests and verified transfers without collapsing them into one “paid” label.</p><a href="/receivables">Compare business records <Icon name="arrow" size={14}/></a></article>
      <article><span className="value-number">02 / RESOLVE</span><h3>Make the difference visible.</h3><p>Review amount mismatches, duplicate payments and incomplete checks. A human review note never changes the onchain facts.</p><a href="/exceptions">Review exceptions <Icon name="arrow" size={14}/></a></article>
      <article><span className="value-number">03 / HAND OVER</span><h3>Let someone else recheck.</h3><p>Share full signed requests and transaction references. Reverify in another browser or with the CLI, without the original workspace account.</p><a href="/handoff">Open independent handoff <Icon name="arrow" size={14}/></a></article>
    </div>
    <details className="value-example"><summary>Why a verified payment may still leave a business difference</summary><p><strong>Illustrative example, not a live transaction:</strong> expected 100 USDC, signed request 80 USDC, verified payment 80 USDC. The request is paid, but the business record still has a 20 USDC difference. PayRef keeps both facts visible; it does not infer settlement or delivery.</p></details>
  </section>;
}
