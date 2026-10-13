// Synthetic Arc-shaped RPC fixtures only. No wallet or live network is used.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, TransactionReceiptNotFoundError } from 'viem';
import type { Hex } from 'viem';
import type { ArcClient } from '../src/chain';
import { MEMO, USDC } from '../src/config';
import { diagnosePayment } from '../src/diagnostics';
import { DiagnosticPanel } from '../src/diagnostic-panel';
import { transfer } from '../src/protocol';
import type { SignedRequest } from '../src/protocol';
import { verifyEvidence } from '../src/verification';
import { evidence, otherHash, payer, signed, txHash } from './fixtures';

const blockHash = `0x${'44'.repeat(32)}` as Hex;
function rpc(req: SignedRequest) {
  const fixture = evidence(req);
  const tx = { ...fixture.transaction, blockHash, chainId: req.domain.chainId };
  const receipt = { ...fixture.receipt, blockHash, logs: fixture.receipt.logs.map(log => ({ ...log, blockHash, blockNumber: 101n, removed: false })) };
  const block = { number: 101n, hash: blockHash, timestamp: fixture.blockTimestamp };
  const methods = {
    getChainId: vi.fn(async () => req.domain.chainId), getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn(async () => receipt), getBlock: vi.fn(async () => block), getCode: vi.fn(async () => fixture.senderCode),
  };
  return { fixture, tx, receipt, block, methods, client: methods as unknown as ArcClient };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('read-only payment diagnosis using synthetic RPC', () => {
  it('returns the same verified payment as the shared verifier and only counts the 6-decimal transfer', async () => {
    const req = await signed(), mock = rpc(req);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('verified');
    expect(result.payment).toEqual(verifyEvidence(req, mock.fixture));
    expect(result.checks.every(check => check.state === 'match')).toBe(true);
    expect(result.checks.find(check => check.key === 'amount')?.observed).toBe('0.010000 USDC');
    expect(mock.methods.getCode).toHaveBeenCalledWith({ address: payer, blockNumber: 101n });
  });
  it('compares the exact received amount without rounding or promoting mismatched evidence', async () => {
    const req = await signed(), mock = rpc(req);
    mock.receipt.logs[1].data = encodeAbiParameters([{ type: 'uint256' }], [9999n]);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result).toMatchObject({ status: 'amount-mismatch', error: { context: { requestId: req.requestId, txHash, evidenceStage: 'transfer' }, cause: { code: 'EVIDENCE_MISMATCH' } } });
    expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'amount')).toMatchObject({ expected: '0.010000 USDC', observed: '0.009999 USDC', state: 'mismatch' });
  });
  it('shows a different observed recipient and preserves both issues when amount also differs', async () => {
    const req = await signed(), mock = rpc(req);
    mock.receipt.logs[1].topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: payer, to: payer } }) as Hex[];
    mock.receipt.logs[1].data = encodeAbiParameters([{ type: 'uint256' }], [1n]);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('recipient-mismatch'); expect(result.payment).toBeUndefined();
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['RECIPIENT_MISMATCH', 'AMOUNT_MISMATCH']));
    expect(result.checks.find(check => check.key === 'recipient')?.observed).toBe(payer);
  });
  it('diagnoses a direct USDC transfer as missing the request binding, even when money and recipient match', async () => {
    const req = await signed(), mock = rpc(req);
    mock.tx.to = USDC; mock.tx.input = transfer(req);
    mock.receipt.logs = mock.receipt.logs.filter(log => log.address !== MEMO);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('missing-memo'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'amount')?.state).toBe('match');
    expect(result.checks.find(check => check.key === 'memo')?.state).toBe('mismatch');
  });
  it('does not accept a Memo event emitted by another contract', async () => {
    const req = await signed(), mock = rpc(req); mock.receipt.logs[3].address = payer;
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('missing-memo'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'memo')?.observed).toBe('No trusted Memo event found');
  });
  it('does not report a fake USDC emitter or the 18-decimal system transfer as received principal', async () => {
    const req = await signed(), mock = rpc(req); mock.receipt.logs[1].address = payer;
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('evidence-mismatch'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'amount')?.observed).toBe('No trusted ERC-20 USDC Transfer found');
  });
  it.each(['call', 'sender'] as const)('keeps an unknown %s shape unsupported even if individual logged fields match', async (kind) => {
    const req = await signed(), mock = rpc(req);
    if (kind === 'call') mock.tx.input = '0xdeadbeef'; else mock.methods.getCode.mockResolvedValue('0xef010001');
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('unsupported'); expect(result.payment).toBeUndefined();
  });
  it('does not equate a different Memo request ID with the selected request', async () => {
    const req = await signed(), mock = rpc(req); mock.receipt.logs[3].topics = [...mock.receipt.logs[3].topics.slice(0, 3), otherHash];
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('evidence-mismatch'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'memo')).toMatchObject({ observed: otherHash, state: 'mismatch' });
  });
  it('reports additional Memo frames as an unsupported shape instead of inferring payment from one matching event', async () => {
    const req = await signed(), mock = rpc(req);
    mock.receipt.logs.push({ ...mock.receipt.logs[3], logIndex: 4 });
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('unsupported'); expect(result.payment).toBeUndefined();
    expect(result.issues.some(issue => issue.code === 'UNSUPPORTED_CALL')).toBe(true);
  });
  it('reports an included revert without claiming the transaction pays or updates a local attempt', async () => {
    const req = await signed(), mock = rpc(req); mock.receipt.status = 'reverted'; mock.receipt.logs = [];
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('reverted'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'recipient')?.state).toBe('unavailable');
    expect(result.issues[0].message).toContain('does not establish payment');
  });
  it.each(['transaction hash', 'receipt hash', 'transaction chain', 'transaction block', 'receipt block hash', 'block hash', 'block number', 'log hash', 'log block', 'removed log'] as const)('rejects %s identity conflicts before exposing payment observations', async (kind) => {
    const req = await signed(), mock = rpc(req);
    switch (kind) {
      case 'transaction hash': mock.tx.hash = otherHash; break;
      case 'receipt hash': mock.receipt.transactionHash = otherHash; break;
      case 'transaction chain': mock.tx.chainId = 1; break;
      case 'transaction block': mock.tx.blockNumber = 102n; break;
      case 'receipt block hash': mock.receipt.blockHash = otherHash; break;
      case 'block hash': mock.block.hash = otherHash; break;
      case 'block number': mock.block.number = 102n; break;
      case 'log hash': mock.receipt.logs[1].transactionHash = otherHash; break;
      case 'log block': mock.receipt.logs[1].blockNumber = 102n; break;
      case 'removed log': mock.receipt.logs[1].removed = true; break;
    }
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('evidence-mismatch'); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'amount')?.state).toBe('unavailable');
  });
  it('stops on the wrong RPC network and shows the observed chain without looking up the transaction', async () => {
    const req = await signed(), mock = rpc(req); mock.methods.getChainId.mockResolvedValue(1);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('wrong-network');
    expect(result.checks.find(check => check.key === 'network')).toMatchObject({ observed: 'Chain ID 1', state: 'mismatch' });
    expect(mock.methods.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it('treats a missing receipt as unresolved and does not make extra queries', async () => {
    const req = await signed(), mock = rpc(req), cause = new TransactionReceiptNotFoundError({ hash: txHash });
    mock.methods.getTransactionReceipt.mockRejectedValue(cause);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result.status).toBe('pending'); expect(result.payment).toBeUndefined();
    expect(result.error?.cause).toMatchObject({ cause });
    expect(mock.methods.getTransaction).not.toHaveBeenCalled(); expect(mock.methods.getBlock).not.toHaveBeenCalled();
  });
  it.each(['receipt', 'transaction', 'block', 'sender'] as const)('preserves the raw cause and failure stage for a failed %s query', async (stage) => {
    const req = await signed(), mock = rpc(req), cause = new Error('access forbidden');
    const method = { receipt: mock.methods.getTransactionReceipt, transaction: mock.methods.getTransaction, block: mock.methods.getBlock, sender: mock.methods.getCode }[stage];
    method.mockRejectedValue(cause);
    const result = await diagnosePayment(req, txHash, { client: mock.client });
    expect(result).toMatchObject({ status: 'rpc-error', error: { context: { requestId: req.requestId, txHash, evidenceStage: stage }, cause: { stage, cause } } });
    expect(result.payment).toBeUndefined();
  });
  it('does not begin reads when already cancelled', async () => {
    const req = await signed(), mock = rpc(req), controller = new AbortController(); controller.abort();
    expect((await diagnosePayment(req, txHash, { client: mock.client, signal: controller.signal })).status).toBe('cancelled');
    expect(mock.methods.getChainId).not.toHaveBeenCalled();
  });
  it('immediately cancels a slow read and ignores its eventual result', async () => {
    const req = await signed(), mock = rpc(req), controller = new AbortController(); vi.useFakeTimers();
    let finish!: (value: typeof mock.receipt) => void;
    mock.methods.getTransactionReceipt.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const waiting = diagnosePayment(req, txHash, { client: mock.client, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    const result = await waiting; expect(result.status).toBe('cancelled');
    finish(mock.receipt); await vi.advanceTimersByTimeAsync(100_000);
    expect(mock.methods.getTransaction).not.toHaveBeenCalled(); expect(result.payment).toBeUndefined();
    expect(result.checks.find(check => check.key === 'amount')?.state).toBe('unavailable');
  });
  it('does not resume shared RPC retries after cancellation', async () => {
    const req = await signed(), mock = rpc(req), controller = new AbortController(); vi.useFakeTimers();
    mock.methods.getTransactionReceipt.mockRejectedValue(new Error('fetch failed'));
    const waiting = diagnosePayment(req, txHash, { client: mock.client, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); expect((await waiting).status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(100_000); expect(mock.methods.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it('presents mismatched facts without any success, resend, or state-changing action', async () => {
    const req = await signed(), mock = rpc(req); mock.receipt.logs[1].data = encodeAbiParameters([{ type: 'uint256' }], [9999n]);
    const diagnosis = await diagnosePayment(req, txHash, { client: mock.client });
    const html = renderToStaticMarkup(createElement(DiagnosticPanel, { diagnosis }));
    expect(html).toContain('Amount does not match'); expect(html).toContain('0.010000 USDC'); expect(html).toContain('0.009999 USDC');
    expect(html).toContain('This read-only diagnosis does not send a transaction.'); expect(html).not.toContain('<button'); expect(html).not.toContain('Payment verified');
  });
});
