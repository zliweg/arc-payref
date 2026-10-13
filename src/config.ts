import { defineChain, parseAbi, stringToHex } from 'viem';
import { PayRefError } from './errors';

export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const MEMO = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as const;
export const MARKER = stringToHex('arc-payref:v1');
export const TESTNET = 5042002;
export const MAINNET = 5042;
export const networks = {
  [TESTNET]: defineChain({ id: TESTNET, name: 'Arc Testnet', testnet: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } } }),
  [MAINNET]: defineChain({ id: MAINNET, name: 'Arc Mainnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } } }),
} as const;
export type NetworkId = keyof typeof networks;
export function network(id: number) {
  if (id !== TESTNET && id !== MAINNET) throw new PayRefError('UNSUPPORTED_NETWORK','network','Unsupported Arc network.');
  return networks[id];
}
export const memoAbi = parseAbi([
  'function memo(address target, bytes data, bytes32 memoId, bytes memoData)',
  'event BeforeMemo(uint256 indexed memoIndex)',
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
]);
