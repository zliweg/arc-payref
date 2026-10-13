# Arc PayRef

**Know what each USDC payment settles.**

Arc PayRef helps freelancers and small teams compare **business receivables, signed payment requests, and actual USDC payments** on Arc mainnet—and hand over records another person can independently recheck.

[Open the app](https://arc-payref.pages.dev/) · [Recheck a real mainnet payment](https://arc-payref.pages.dev/receipt#demo=mainnet) · [Submission description](SUBMISSION.md) · [Builder](https://github.com/zliweg)

## The problem

A wallet transaction shows that funds moved. It does not, by itself, explain which service fee they settle, whether the signed request matches the business agreement, or whether a colleague can reproduce the reconciliation later. Small teams often match spreadsheets, messages and transaction hashes by hand.

PayRef brings those records together while keeping their meanings separate. **Illustrative example:** a business expects 100 USDC, the signed request says 80, and the actual payment is 80. The payment can verify correctly while the business record still shows a 20 USDC difference. This example is not a claim about a real customer or transaction.

## Three core capabilities

- **Reconcile:** import or enter business receivables, explicitly associate a signed request, and compare the business amount, signed amount and verified transfers. Similar amounts never silently establish a match.
- **Review exceptions:** inspect discrepancies, duplicate payments, missing Memo evidence and incomplete checks. Human review notes do not rewrite onchain facts.
- **Hand over and recheck:** export original signed requests, business records and transaction references. Another browser or the read-only CLI can query the chain again without the original user's account or database.

Supporting features include payment links and locally generated QR codes, a payer inbox, CSV exports, JSON backups, and recovery of unresolved wallet attempts.

## Why Arc

PayRef uses Arc's existing Memo contract to associate the EIP-712 request digest with the USDC payment call. The application verifies the request signature, transaction input, Memo evidence and matching USDC Transfer together. A transaction hash or success status alone does not prove a matching payment.

Arc also uses USDC for network fees. PayRef checks the shared USDC balance against the payment plus estimated gas, without adding native and ERC-20 balance representations together. Funds move directly from the payer's EOA; PayRef has no custody, custom payment contract, token approvals or backend database. Request signatures are checked by the application, not by the Memo contract.

Mainnet chain ID: **5042**. Configuration is centralized in `src/config.ts`; testnet is explicitly selectable and kept separate. A fresh workspace defaults to mainnet, and an original signed link selects its own validated network.

## Real mainnet evidence

On **13 October 2026**, two distinct wallets controlled by the builder completed this payment:

| Item | Historical evidence |
| --- | --- |
| Business reference | `PAYREF-MAINNET-001` |
| Amount | **0.01 USDC** |
| Network fee | **0.001352240077889024 USDC** |
| Block | `25703820` |
| Transaction | [`0x4632b21a…f0086e00`](https://explorer.arc.io/tx/0x4632b21af3fdbaad5c3f89599fcf6bc2e2a82bc93b24ba346c354badf0086e00) |
| Original signed request and hash | [`public/mainnet-proof.json`](public/mainnet-proof.json) |

The original acceptance covered the actual wallet payment, Memo and USDC event verification, finding the payment by request, and restoring its backup in a clean browser. A historical full lookup found one matching payment through block **25704154**. That is a bounded historical result, not a claim that no later payment exists.

**Try it without funds or a wallet:**

1. Open [the mainnet receipt demonstration](https://arc-payref.pages.dev/receipt#demo=mainnet).
2. Select **Verify receipt**. The ordinary verifier queries Arc again; the demonstration contains no cached `PAID` result.
3. Inspect the signature, Memo binding and actual transfer evidence. **Check payment** separately scans the request range to look for additional payments.
4. To reproduce recovery, download [the original evidence JSON](https://arc-payref.pages.dev/mainnet-proof.json), open Backups & exports in another browser, preview and import it, then recheck the payment.

This is a real integration test between the builder's own wallets. It does not demonstrate customer adoption, identity, delivery of services or independently validated market demand. No new payment is needed to review it.

## Run locally

Requires **Node.js 24** and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The default workspace is Arc mainnet: signing and sending remain explicit wallet actions. Reading a receipt does not require a wallet. Do not use public fixture keys with real funds.

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Unit tests and the `synthetic` browser suite use explicitly identified test fixtures. They do not prove a real chain write. The `live-readonly` project uses actual RPC reads; `mainnet-presentation.spec.ts` rechecks the published historical mainnet payment and never submits a transaction.

For a package exported from **Handoff & recheck**:

```sh
npm run verify:handoff -- handoff.json --json
# Optional complete request-range scan; may take longer:
npm run verify:handoff -- handoff.json --scan --json
```

The request backup and handoff package are different formats. Import `mainnet-proof.json` through Backups & exports; use a Handoff & recheck export for the CLI.

## Scope and limitations

- Built for ordinary EOA browser wallets. No smart-contract wallets, custody, subscriptions, partial-payment workflow, cross-chain payments or cloud synchronization.
- Local records belong to the browser and site origin. The same wallet does not restore another device's records; keep full JSON backups.
- Single-receipt verification does not exclude another payment. Full scans only establish coverage through the reported block; interrupted scans stay incomplete.
- Signed links and exported business notes are readable by recipients. Signatures prove what a wallet signed, not identity, trustworthiness or delivery.
- MetaMask has displayed a domain risk warning for this deployment. The last investigation found a `BLOCK` response from its URL-scanning service, but no matching public static-list entry or confirmed trigger. The warning is **unresolved**; no claim of clearance or instructions to disable protection are made.

Source is currently private at the owner's request. Arc Microgrants requires a public repository before submission.
