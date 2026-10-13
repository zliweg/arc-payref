// Read-only verifier. Run with Node 24: node scripts/verify-handoff.ts package.json [--scan] [--json]
// Vite loads the same TypeScript modules as the browser; no server listens and no wallet is used.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import type { HandoffVerification } from '../src/handoff';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/verify-handoff.ts <handoff.json> [--scan] [--json]\nDefault: verify only known transaction hashes. --scan additionally queries every signed request range.\nOnly the application’s fixed Arc networks, contracts and RPC endpoints are used. No transactions are sent.';
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
} else if (args.filter(arg => !arg.startsWith('--')).length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--scan' && arg !== '--json')) {
  console.error(usage); process.exitCode = 2;
} else {
  const controller = new AbortController();
  const stop = () => { controller.abort(); console.error('Stop requested. Waiting for the active read; completed checks will remain in the output.'); };
  process.once('SIGINT', stop);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let stage = 'file-read';
  try {
    const path = resolve(args.find(arg => !arg.startsWith('--'))!);
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Object.assign(new Error('Choose a regular handoff JSON file no larger than 2 MiB.'), { name: 'HandoffInputError' });
    const content = await readFile(path, 'utf8');
    stage = 'runtime';
    server = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
    const handoff = await server.ssrLoadModule('/src/handoff.ts') as typeof import('../src/handoff');
    const config = await server.ssrLoadModule('/src/config.ts') as typeof import('../src/config');
    stage = 'validation';
    const packet = await handoff.previewHandoff(content);
    console.error(`Validated ${packet.records.length} records. Exported snapshots and human review flags are untrusted. No local browser storage is used.`);
    console.error(`Networks: ${[...new Set(packet.records.map(record => config.network(record.request?.domain.chainId ?? record.receivable!.chainId).name))].join(', ')}. Testnet uses test funds.`);
    stage = 'verification';
    const result: HandoffVerification = await handoff.verifyHandoff(packet, { mode: args.includes('--scan') ? 'scan' : 'hashes', signal: controller.signal,
      onProgress: update => console.error(`[${update.index + 1}/${update.total}] ${update.message}`),
    });
    if (args.includes('--json')) console.log(JSON.stringify({ verifierVersion: handoff.HANDOFF_VERIFIER_VERSION, summary: handoff.summarizeHandoff(packet, result.records), verification: result }, null, 2));
    else {
      console.log(`Arc PayRef independent read-only verification · ${handoff.HANDOFF_VERIFIER_VERSION}`);
      for (const record of result.records) {
        console.log(`${record.recordKey}: ${record.state}; ${record.hashChecks.length} known hashes checked; ${record.payments.length} matching receipts; range ${record.scan?.complete ? `complete through ${record.scan.checkedThroughBlock}` : record.scan ? 'incomplete' : 'NOT RUN'}`);
        const differences = [['reference', record.comparison.referenceMatches], ['amount', record.comparison.amountMatches], ['network', record.comparison.networkMatches], ['request association', record.comparison.requestMatches]].filter(([, matches]) => matches === false).map(([label]) => label);
        if (differences.length) console.log(`  Business/request mismatch: ${differences.join(', ')}. Verified receipts do not resolve this discrepancy.`);
        if (record.payments.length > 1) console.log(`  Duplicate payment: ${record.payments.length} qualifying receipts. Review before any further payment.`);
        for (const error of record.errors) console.log(`  ${error.code}: ${error.message}${error.hash ? ` (${error.hash})` : ''}`);
        for (const anomaly of record.scan?.anomalies ?? []) console.log(`  Unmatched Memo: ${anomaly.hash} · ${anomaly.reason}`);
      }
      console.log('Known hashes do not rule out another payment. Complete scans cover only their stated block range. Business declarations are not verified delivery, identity or accounting advice.');
    }
    const needsAttention = result.records.some(record => record.state !== 'finished' || record.errors.length > 0 || record.payments.length > 1 || [record.comparison.referenceMatches, record.comparison.amountMatches, record.comparison.networkMatches, record.comparison.requestMatches].includes(false) || (record.scan?.anomalies.length ?? 0) > 0 || (result.mode === 'scan' ? !record.scan?.complete : record.hashChecks.length === 0));
    process.exitCode = result.cancelled ? 130 : needsAttention ? 2 : 0;
  } catch (error) {
    // Provider errors may contain sensitive request data; only structured application errors are printed.
    const known = error instanceof Error && (error.name === 'PayRefError' || error.name === 'HandoffInputError');
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'HANDOFF_FAILED';
    const fileReasons: Record<string, string> = { ENOENT: 'The input file does not exist.', EACCES: 'The input file could not be read due to its permissions.', EPERM: 'The input file operation was not permitted.' };
    console.error(`${stage} · ${code}: ${known ? error.message : fileReasons[code] ?? 'Handoff verification could not complete. Check the package and local runtime. No successful result was recorded.'}`);
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop);
    await server?.close();
  }
}
