// Synthetic transport evidence only: these tests do not call an Arc RPC.
import { describe, expect, it, vi } from 'vitest';
import { scanRequest, verifyPayment } from '../src/chain';
import type { ArcClient } from '../src/chain';
import type { SignedRequest } from '../src/protocol';
import { otherHash, rpcEvidence, signed, txHash } from './fixtures';

function source(req: SignedRequest, hash = txHash) {
  const input = rpcEvidence(req, hash);
  const block = { number: input.receipt.blockNumber, hash: input.receipt.blockHash, timestamp: input.blockTimestamp };
  const methods = {
    getChainId: vi.fn(async () => req.domain.chainId),
    getTransaction: vi.fn(async () => input.transaction),
    getTransactionReceipt: vi.fn(async () => input.receipt),
    getBlock: vi.fn(async () => block),
    getCode: vi.fn(async () => input.senderCode),
    getBlockNumber: vi.fn(async () => 101n),
    getLogs: vi.fn(async () => [{ transactionHash: hash }]),
  };
  return { input, block, methods, client: methods as unknown as ArcClient };
}
type Source = ReturnType<typeof source>;

describe('binding RPC evidence to the exact hash and included block', () => {
  it('accepts consistent evidence and reads the receipt block and historical sender code', async () => {
    const request = await signed(), rpc = source(request);
    await expect(verifyPayment(request, txHash, rpc.client)).resolves.toMatchObject({ hash: txHash, requestId: request.requestId, block: '101' });
    expect(rpc.methods.getBlock).toHaveBeenCalledWith({ blockNumber: 101n });
    expect(rpc.methods.getCode).toHaveBeenCalledWith({ address: rpc.input.transaction.from, blockNumber: 101n });
  });
  it('rejects an internally valid transaction/receipt pair returned for a different queried hash', async () => {
    const request = await signed(), rpc = source(request, otherHash);
    await expect(verifyPayment(request, txHash, rpc.client)).rejects.toMatchObject({ code: 'EVIDENCE_MISMATCH', context: { txHash, evidenceStage: 'transaction' } });
    expect(rpc.methods.getTransaction).toHaveBeenCalledWith({ hash: txHash });
    expect(rpc.methods.getBlock).not.toHaveBeenCalled();
  });
  const mismatches: { name: string; stage: string; mutate: (rpc: Source) => void }[] = [
    { name: 'transaction network', stage: 'network', mutate: rpc => { rpc.input.transaction.chainId = 1; } },
    { name: 'transaction/receipt fork', stage: 'transaction', mutate: rpc => { rpc.input.transaction.blockHash = otherHash; } },
    { name: 'actual block number', stage: 'block', mutate: rpc => { rpc.block.number = 102n; } },
    { name: 'actual block hash', stage: 'block', mutate: rpc => { rpc.block.hash = otherHash; } },
    { name: 'negative block timestamp', stage: 'block', mutate: rpc => { rpc.block.timestamp = -1n; } },
    { name: 'USDC log block number', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[1].blockNumber = 102n; } },
    { name: 'USDC log block hash', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[1].blockHash = otherHash; } },
    { name: 'removed Memo event', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[3].removed = true; } },
    { name: 'fractional log position', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[1].logIndex = 1.5; } },
    { name: 'negative log position', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[0].logIndex = -1; } },
    { name: 'duplicated relevant log position', stage: 'receipt', mutate: rpc => { rpc.input.receipt.logs[1].logIndex = rpc.input.receipt.logs[0].logIndex; } },
  ];
  it.each(mismatches)('rejects mismatched $name', async ({ mutate, stage }) => {
    const request = await signed(), rpc = source(request); mutate(rpc);
    await expect(verifyPayment(request, txHash, rpc.client)).rejects.toMatchObject({ code: 'EVIDENCE_MISMATCH', context: { requestId: request.requestId, txHash, evidenceStage: stage } });
  });
  it('isolates a scan hash whose RPC response silently points at another transaction', async () => {
    const request = await signed(), rpc = source(request);
    rpc.methods.getLogs.mockResolvedValue([{ transactionHash: otherHash }]);
    const result = await scanRequest(request, { client: rpc.client });
    expect(result.complete).toBe(true); expect(result.payments).toEqual([]);
    expect(result.anomalies).toEqual([{ hash: otherHash, reason: 'RPC transaction and receipt must match the requested hash.' }]);
  });
});
