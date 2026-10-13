import { getAddress, hashTypedData, isAddress, isHex, recoverTypedDataAddress, toHex, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import { MARKER, MEMO, USDC, memoAbi, network } from './config';
import { fail } from './errors';

export const requestTypes = { PaymentRequest: [
  { name: 'payee', type: 'address' }, { name: 'token', type: 'address' },
  { name: 'memoContract', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'reference', type: 'string' }, { name: 'description', type: 'string' },
  { name: 'expiresAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  { name: 'createdAtBlock', type: 'uint256' },
] } as const;
export interface RequestMessage {
  payee: Address; token: Address; memoContract: Address; amount: string;
  reference: string; description: string; expiresAt: string; nonce: Hex; createdAtBlock: string;
}
export interface UnsignedRequest {
  schemaVersion: 1;
  domain: { name: 'Arc PayRef'; version: '1'; chainId: number };
  message: RequestMessage;
}
export interface SignedRequest extends UnsignedRequest { signature: Hex; requestId: Hex }
const MAX_UINT = (1n << 256n) - 1n;
export const byteLength = (s: string) => new TextEncoder().encode(s).length;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_FORMAT', 'request', 'Expected an object.');
  return value as Record<string, unknown>;
}
function keys(obj: Record<string, unknown>, expected: string[]) {
  if (Object.keys(obj).sort().join(',') !== [...expected].sort().join(',')) fail('INVALID_FIELDS', 'request', 'Unexpected or missing fields.');
}
export function uint(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 78) fail('INVALID_INTEGER', 'request', 'Expected a canonical unsigned integer.');
  const result = BigInt(value);
  if (result > MAX_UINT || (positive && result === 0n)) fail('INVALID_INTEGER', 'request', 'Integer is outside the allowed range.');
  return value;
}
export function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: true }) || /^0x0{40}$/i.test(value)) fail('INVALID_ADDRESS', 'request', 'Invalid address, checksum or zero address.');
  return getAddress(value);
}
function hex(value: unknown, bytes: number): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== bytes * 2 + 2) fail('INVALID_HEX', 'request', `Expected ${bytes} bytes of hexadecimal data.`);
  return value as Hex;
}
function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value !== value.normalize('NFC').trim() || byteLength(value) < min || byteLength(value) > max || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_TEXT', 'request', `Text must be normalized and contain ${min}–${max} UTF-8 bytes without control characters.`);
  return value;
}
export function parseAmount(input: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input)) fail('INVALID_AMOUNT', 'amount', 'Use a positive amount with at most 6 decimal places.');
  const [whole, part = ''] = input.split('.');
  if (whole.length > 78) fail('INVALID_AMOUNT', 'amount', 'Amount is too large.');
  return uint((BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0'))).toString(), true);
}
export function parseUnsigned(value: unknown): UnsignedRequest {
  const obj = record(value);
  keys(obj, ['schemaVersion','domain','message']);
  if (obj.schemaVersion !== 1) fail('UNSUPPORTED_VERSION', 'request', 'Only request version 1 is supported.');
  const domain = record(obj.domain);
  keys(domain, ['name','version','chainId']);
  if (domain.name !== 'Arc PayRef' || domain.version !== '1' || typeof domain.chainId !== 'number') fail('INVALID_DOMAIN', 'request', 'Invalid signing domain.');
  network(domain.chainId);
  const msg = record(obj.message);
  keys(msg, requestTypes.PaymentRequest.map(f => f.name));
  const parsed: RequestMessage = {
    payee: address(msg.payee), token: address(msg.token), memoContract: address(msg.memoContract),
    amount: uint(msg.amount, true), reference: text(msg.reference, 1, 128), description: text(msg.description, 0, 512),
    expiresAt: uint(msg.expiresAt), nonce: hex(msg.nonce, 32), createdAtBlock: uint(msg.createdAtBlock),
  };
  if (parsed.token !== getAddress(USDC) || parsed.memoContract !== getAddress(MEMO)) fail('INVALID_CONTRACT', 'request', 'Only the configured Arc USDC and Memo contracts are allowed.');
  if (BigInt(parsed.expiresAt) > 8640000000000n) fail('INVALID_EXPIRY', 'request', 'Expiry cannot be displayed as a date.');
  return { schemaVersion: 1, domain: { name: 'Arc PayRef', version: '1', chainId: domain.chainId }, message: parsed };
}
export function typedData(req: UnsignedRequest) {
  return { domain: req.domain, types: requestTypes, primaryType: 'PaymentRequest' as const,
    message: { ...req.message, amount: BigInt(req.message.amount), expiresAt: BigInt(req.message.expiresAt), createdAtBlock: BigInt(req.message.createdAtBlock) } };
}
export const requestHash = (req: UnsignedRequest): Hex => hashTypedData(typedData(req));
export async function verifyRequest(value: unknown): Promise<SignedRequest> {
  const obj = record(value);
  keys(obj, ['schemaVersion','domain','message','signature','requestId']);
  const req = parseUnsigned({ schemaVersion: obj.schemaVersion, domain: obj.domain, message: obj.message });
  const signature = hex(obj.signature, 65);
  const requestId = hex(obj.requestId, 32);
  if (requestHash(req).toLowerCase() !== requestId.toLowerCase()) fail('HASH_MISMATCH', 'signature', 'The request fields do not match its ID.');
  let recovered: Address;
  try { recovered = await recoverTypedDataAddress({ ...typedData(req), signature }); }
  catch { return fail('INVALID_SIGNATURE', 'signature', 'Cannot recover the request signature.'); }
  if (getAddress(recovered) !== req.message.payee) fail('WRONG_SIGNER', 'signature', 'The request was not signed by the payee.');
  return { ...req, requestId: requestHash(req), signature };
}
export function createRequest(input: { chainId: number; payee: string; amount: string; reference: string; description: string; expiresAt: string; block: bigint }): UnsignedRequest {
  return parseUnsigned({ schemaVersion: 1, domain: { name: 'Arc PayRef', version: '1', chainId: input.chainId }, message: {
    payee: input.payee, token: USDC, memoContract: MEMO, amount: parseAmount(input.amount),
    reference: input.reference.normalize('NFC').trim(), description: input.description.normalize('NFC').trim(),
    expiresAt: input.expiresAt, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))), createdAtBlock: input.block.toString(),
  } });
}
export function transfer(req: UnsignedRequest) {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [req.message.payee, BigInt(req.message.amount)] });
}
export function paymentData(req: SignedRequest) {
  return encodeFunctionData({ abi: memoAbi, functionName: 'memo', args: [USDC, transfer(req), req.requestId, MARKER] });
}
export const callHash = (req: UnsignedRequest) => keccak256(transfer(req));
export function encodeRequest(req: SignedRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  if (bytes.length > 16384) fail('TOO_LARGE', 'link', 'Request exceeds 16 KiB.');
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
}
export async function decodeRequest(input: string): Promise<SignedRequest> {
  if (!input || input.length > 21846 || !/^[A-Za-z0-9_-]+$/.test(input)) fail('INVALID_LINK', 'link', 'Malformed or oversized request link.');
  try {
    const bytes = Uint8Array.from(atob(input.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
    if (bytes.length > 16384) fail('TOO_LARGE', 'link', 'Request exceeds 16 KiB.');
    return await verifyRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (e) { if (e instanceof Error && e.name === 'PayRefError') throw e; return fail('INVALID_LINK', 'link', 'Cannot decode this request.'); }
}
export function requestLink(req: SignedRequest, origin: string, receiptHash?: Hex) {
  return `${origin}/${receiptHash ? 'receipt' : 'pay'}#request=${encodeRequest(req)}${receiptHash ? `&tx=${receiptHash}` : ''}`;
}
export function expired(req: UnsignedRequest, timestamp: bigint) {
  return req.message.expiresAt !== '0' && timestamp >= BigInt(req.message.expiresAt);
}
