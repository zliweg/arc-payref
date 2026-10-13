# Arc Microgrants submission material

## Project name

Arc PayRef

## Tagline

Know what each USDC payment settles.

## Short description

Arc PayRef helps freelancers and small teams reconcile business receivables, signed requests and actual USDC payments on Arc mainnet. It makes discrepancies visible and lets another person independently recheck the original evidence—without an account on the original workspace.

## Project description

Receiving USDC is only part of getting paid. A freelancer or small service team also needs to know which business record the transfer belongs to, whether the requested amount matches the agreement, and whether someone else can verify the reconciliation later.

Arc PayRef connects three separate records: what the business expects, what the receiving wallet signed, and what actually arrived onchain. It exposes differences instead of compressing all three into a single “paid” status. For example, an 80 USDC payment can correctly settle an 80 USDC signed request while leaving a 20 USDC difference against a 100 USDC business record. This is an illustrative scenario, not a customer result.

The product combines business CSV/JSON import, signed payment links, exception review and portable evidence handoff. A reviewer can open the original signed request and query the transaction again, or use the independent read-only CLI on a handoff package. Human notes and imported historical statuses never replace chain verification.

## How the project uses Arc

Payments call Arc's existing Memo contract with a fixed USDC transfer and a request digest. The application checks the receiving wallet's EIP-712 signature, transaction input, Memo event and actual USDC Transfer. Arc's USDC gas model allows payment and network fees to be reviewed in the same asset, with an explicit balance and fee check before sending.

PayRef is a static React/TypeScript application using viem. It introduces no custom payment contract, custody or backend database. The Memo contract does not verify the application signature; that check is part of PayRef's verifier.

## What is working on mainnet

A real 0.01 USDC payment between two distinct builder-controlled wallets completed on 13 October 2026. The network fee was 0.001352240077889024 USDC. Acceptance included the real wallet transaction, Memo and Transfer checks, finding the payment by request, and backup restoration in a clean browser. The public demonstration allows fresh read-only verification through the same verifier used for ordinary requests.

This demonstrates a working mainnet integration. Target-user demand, customer adoption and time saved have not yet been validated.

## Reviewer links

- Live application: https://arc-payref.pages.dev/
- No-wallet mainnet demonstration: https://arc-payref.pages.dev/receipt#demo=mainnet
- Mainnet transaction: https://explorer.arc.io/tx/0x4632b21af3fdbaad5c3f89599fcf6bc2e2a82bc93b24ba346c354badf0086e00
- Original signed evidence: https://arc-payref.pages.dev/mainnet-proof.json
- Source: https://github.com/zliweg/arc-payref
- Public builder profile: https://github.com/zliweg

## Suggested 60–90 second walkthrough

1. Explain the user problem and the expected / signed / received distinction.
2. Open the real mainnet demonstration and select Verify receipt. Show the actual amount, parties, fee and Memo/Transfer evidence.
3. Show Business receivables and the three-way comparison. Label illustrative examples clearly; do not present invented records as customer activity.
4. Show Handoff & recheck and explain how the next person queries the chain independently.

## Public builder bio

Building Arc PayRef: helping small teams reconcile USDC receivables and independently verify payment evidence on Arc mainnet.

## Before final submission

- The repository is **Public**, as authorized by the owner, and available for reviewer access.
- Project material is being entered into the authenticated DoraHacks Build submission form. Final submission requires the owner's confirmation. This file is not a submitted application.
- On 13 October 2026, the owner confirmed that the work has not received Circle/Arc program funding and that they have the right to submit it.
- The MetaMask domain risk warning remains unresolved. Do not claim it is cleared. The no-wallet evidence review does not require a new payment.
- Official deadline, last checked 13 October 2026: **14 October 2026, 23:59 ET / 15 October 2026, 11:59 Beijing**. Recheck for changes before submitting.
- Rules: https://dorahacks.io/hackathon/arc-microgrants/detail
