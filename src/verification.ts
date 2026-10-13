import { decodeEventLog, erc20Abi, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { MEMO, USDC, MARKER, memoAbi } from './config';
import { callHash, expired, paymentData } from './protocol';
import type { SignedRequest } from './protocol';
import { PayRefError } from './errors';

export interface EvidenceLog { address: Address; data: Hex; topics: readonly Hex[]; logIndex: number | null; transactionHash: Hex | null }
export interface PaymentEvidence {
  chainId: number;
  transaction: { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint; blockNumber: bigint | null };
  receipt: { transactionHash: Hex; blockNumber: bigint; status: 'success' | 'reverted'; logs: EvidenceLog[]; gasUsed: bigint; effectiveGasPrice: bigint };
  blockTimestamp: bigint;
  senderCode: Hex;
}
export interface VerifiedPayment {
  chainId: number; requestId: Hex; hash: Hex; logIndex: number; block: string; payer: Address; payee: Address;
  amount: string; timestamp: string; gasCostNative: string; late: boolean;
}
export type EvidenceStage = 'network' | 'transaction' | 'memo' | 'transfer';
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
export function verifyEvidence(req: SignedRequest, evidence: PaymentEvidence): VerifiedPayment {
  const { transaction: tx, receipt } = evidence;
  let evidenceStage: EvidenceStage = 'network';
  function check(ok: unknown, detail: string): asserts ok {
    if (!ok) throw new PayRefError('EVIDENCE_MISMATCH', 'receipt', detail, { requestId: req.requestId, txHash: tx.hash, evidenceStage });
  }
  check(evidence.chainId === req.domain.chainId, 'Receipt belongs to a different network.');
  evidenceStage = 'transaction';
  check(receipt.status === 'success', 'Transaction reverted.');
  check(tx.blockNumber !== null && tx.blockNumber === receipt.blockNumber && same(tx.hash, receipt.transactionHash), 'Transaction and receipt do not describe the same included transaction.');
  check(tx.blockNumber >= BigInt(req.message.createdAtBlock), 'Payment predates the request lookup boundary.');
  check(same(tx.to, MEMO) && tx.value === 0n && tx.input.toLowerCase() === paymentData(req).toLowerCase(), 'Unsupported transaction target, value or input.');
  check(evidence.senderCode === '0x' && !same(tx.from, req.message.payee), 'Only direct payments from a different ordinary EOA are supported.');
  evidenceStage = 'memo';
  const memoLogs = receipt.logs.filter(l => same(l.address, MEMO));
  const decoded = memoLogs.map(l => {
    try { return { log: l, event: decodeEventLog({ abi: memoAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true }) }; }
    catch { return null; }
  });
  check(memoLogs.length === 2 && decoded.every(Boolean), 'Expected exactly the direct BeforeMemo and Memo events.');
  const before = decoded.find(l => l?.event.eventName === 'BeforeMemo');
  const memo = decoded.find(l => l?.event.eventName === 'Memo');
  check(before && before.event.eventName === 'BeforeMemo' && memo && memo.event.eventName === 'Memo', 'Memo event pair missing.');
  const args = memo.event.args;
  check(same(args.sender, tx.from) && same(args.target, USDC), 'Memo sender or target mismatch.');
  check(same(args.memoId, req.requestId) && same(args.callDataHash, callHash(req)) && same(args.memo, MARKER), 'Memo request binding mismatch.');
  check(args.memoIndex === before.event.args.memoIndex && before.log.logIndex !== null && memo.log.logIndex !== null && before.log.logIndex < memo.log.logIndex, 'Memo frame mismatch.');
  check(same(memo.log.transactionHash, tx.hash) && same(before.log.transactionHash, tx.hash), 'Memo log transaction mismatch.');
  evidenceStage = 'transfer';
  const transfers = receipt.logs.filter(l => same(l.address, USDC)).flatMap(l => {
    try { const event = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
      return event.eventName === 'Transfer' ? [{ log: l, args: event.args }] : []; }
    catch { return []; }
  });
  check(transfers.length === 1, 'Expected one ERC-20 USDC Transfer.');
  const transfer = transfers[0];
  check(same(transfer.args.from, tx.from) && same(transfer.args.to, req.message.payee) && transfer.args.value === BigInt(req.message.amount), 'USDC transfer does not match the requested payment.');
  check(transfer.log.logIndex !== null && transfer.log.logIndex > before.log.logIndex && transfer.log.logIndex < memo.log.logIndex && same(transfer.log.transactionHash, tx.hash), 'USDC transfer is outside the verified Memo frame.');
  return { chainId: req.domain.chainId, requestId: req.requestId, hash: tx.hash, logIndex: memo.log.logIndex, block: receipt.blockNumber.toString(),
    payer: getAddress(tx.from), payee: req.message.payee, amount: req.message.amount,
    timestamp: evidence.blockTimestamp.toString(), gasCostNative: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), late: expired(req, evidence.blockTimestamp) };
}
export function mergePayments(...groups: VerifiedPayment[][]): VerifiedPayment[] {
  return [...new Map(groups.flat().map(p => [`${p.chainId}:${p.hash.toLowerCase()}:${p.logIndex}`, p])).values()];
}
