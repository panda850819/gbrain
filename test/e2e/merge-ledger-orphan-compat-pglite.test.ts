/**
 * Merge-boundary E2E regressions, specified before remediation:
 * - legacy repos sharing a path must survive normalization and every rewrite;
 * - legacy/unattributed rows must not impersonate the explicit default source;
 * - real graph -> MCP JSON -> thin-client doctor must score knowledge only;
 * - old/partial server envelopes must retain the all-tier fallback as a pair.
 * Keyless: disposable filesystem + PGLite + loopback OAuth/MCP fixture.
 * Repeatable receipt: stdout, or GBRAIN_MERGE_COMPAT_RECEIPT for a JSON file.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { getOrphansData } from '../../src/commands/orphans.ts';
import { runOrphanRatioCheck } from '../../src/core/doctor-remote.ts';
import {
  acknowledgeFailures, autoSkipFailures, clearFailures, loadSyncFailures,
  recordFailures, resolveMissingSyncFailures, restoreFailures, syncFailuresPath,
  unacknowledgedSyncFailures,
} from '../../src/core/sync-failure-ledger.ts';
import { withEnv } from '../helpers/with-env.ts';

let root: string;
let engine: PGLiteEngine;
let server: Server;
let base: string;
let toolData: Record<string, unknown> = {};
let toolCalls = 0;
const receipt: Record<string, unknown> = {};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-merge-compat-')));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = createServer(async (req, res) => {
    const json = (value: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.url === '/.well-known/oauth-authorization-server') {
      return json({ issuer: base, token_endpoint: `${base}/token` });
    }
    if (req.url === '/token') {
      return json({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 3600, scope: 'read' });
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer fixture-token') {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'merge-compat-fixture', version: '1' },
        } });
      }
      if (body.method === 'tools/call' && body.params.name === 'find_orphans') {
        toolCalls++;
        return json({ jsonrpc: '2.0', id: body.id, result: {
          content: [{ type: 'text', text: JSON.stringify(toolData) }],
        } });
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (engine) await engine.disconnect();
  const artifact = JSON.stringify({ observations: receipt, tool_calls: toolCalls }, null, 2);
  console.log(`[merge-compat receipt] ${artifact}`);
  if (process.env.GBRAIN_MERGE_COMPAT_RECEIPT) writeFileSync(process.env.GBRAIN_MERGE_COMPAT_RECEIPT, artifact + '\n');
  if (root) rmSync(root, { recursive: true, force: true });
});

function seedLedger(dir: string) {
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'repo-a');
  const b = join(dir, 'repo-b');
  const alias = join(dir, 'repo-a-alias');
  mkdirSync(join(a, 'notes'), { recursive: true });
  mkdirSync(join(b, 'notes'), { recursive: true });
  symlinkSync(a, alias, 'dir');
  writeFileSync(join(a, 'notes/bad.md'), 'still broken');
  const common = { path: 'notes/bad.md', error: 'bad frontmatter', acknowledged: false };
  writeFileSync(syncFailuresPath(), [
    { ...common, repo: a, commit: 'a1', ts: '2026-08-01T00:00:00Z' },
    { ...common, repo: alias, commit: 'a2', ts: '2026-08-02T00:00:00Z' },
    { ...common, repo: b, commit: 'b1', ts: '2026-08-03T00:00:00Z' },
    { ...common, commit: 'unknown', ts: '2026-08-04T00:00:00Z' },
    { ...common, source_id: 'default', commit: 'explicit', ts: '2026-08-05T00:00:00Z' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  return { a, b, alias };
}

test('legacy same-path repos survive retry resolution and normalized persistence', () => {
  const dir = join(root, 'resolve');
  withEnv({ GBRAIN_SYNC_FAILURES_DIR: dir }, () => {
    const { a, b, alias } = seedLedger(dir);
    const normalized = loadSyncFailures();
    receipt.legacy_loaded = normalized.length;
    expect(normalized).toHaveLength(4); // only canonical repo-a duplicates merge
    expect(normalized.find(row => row.repo === alias)?.attempts).toBe(2);
    expect(resolveMissingSyncFailures(b, { sourceId: 'source-b' }).count).toBe(1);
    const rows = loadSyncFailures();
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.repo === b)?.state).toBe('acknowledged');
    expect(rows.find(row => row.repo === alias)?.state).toBe('open');
    expect(readFileSync(join(a, 'notes/bad.md'), 'utf8')).toBe('still broken');
    expect(unacknowledgedSyncFailures()).toHaveLength(3);
    receipt.legacy_retry = { persisted: rows.length, unresolved: 3, foreign_repo_preserved: true };
  });
});

test('source-keyed writes never clear, skip, or acknowledge legacy default lookalikes', () => {
  const dir = join(root, 'rewrites');
  withEnv({ GBRAIN_SYNC_FAILURES_DIR: dir }, () => {
    seedLedger(dir);
    const explicit = loadSyncFailures().find(row => !row.source_unattributed)!;
    recordFailures('other-source', [{ path: 'notes/other.md', error: 'bad frontmatter' }], 'other');
    clearFailures('default', ['notes/bad.md']);
    expect(loadSyncFailures().filter(row => row.source_unattributed)).toHaveLength(3);
    expect(restoreFailures('default', [explicit])).toBe(1);
    expect(autoSkipFailures('default', ['notes/bad.md']).count).toBe(1);
    expect(acknowledgeFailures('default').count).toBe(1);
    const remaining = unacknowledgedSyncFailures();
    expect(remaining).toHaveLength(4);
    expect(remaining.filter(row => row.source_unattributed && row.state === 'open')).toHaveLength(3);
    receipt.legacy_rewrites = { unresolved: remaining.length, foreign_rows_preserved: true };
  });
});

function remoteCheck() {
  return runOrphanRatioCheck({ engine: 'postgres', remote_mcp: {
    issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: 'fixture-client',
    oauth_client_secret: 'fixture-secret',
  } });
}

test('real graph counters cross HTTP/MCP without turning flow into thin-client orphan debt', async () => {
  for (let i = 0; i < 100; i++) {
    await engine.putPage(`people/example-${i}`, {
      type: 'person', title: `Example ${i}`, compiled_truth: 'fixture', timeline: '', frontmatter: {},
    });
  }
  await engine.addLinksBatch(Array.from({ length: 100 }, (_, i) => ({
    from_slug: `people/example-${i}`, to_slug: `people/example-${(i + 1) % 100}`,
    link_type: 'mentions', link_source: 'markdown', context: '',
  })));
  for (let i = 0; i < 900; i++) {
    await engine.putPage(`records/flow-${i}`, {
      type: 'session', title: `Flow ${i}`, compiled_truth: 'fixture', timeline: '', frontmatter: {},
    });
  }
  const data = await getOrphansData(engine);
  const health = await engine.getHealth();
  expect(data.knowledge_orphans).toBe(0);
  expect(data.knowledge_linkable).toBe(100);
  expect(data.flow_orphans).toBe(900);
  expect(health.orphan_pages).toBe(0);
  toolData = { ...data };
  const result = await remoteCheck();
  receipt.tiered_remote = { status: result.status, message: result.message, knowledge: 100, flow: 900 };
  expect(toolCalls).toBeGreaterThan(0); // no informational network-failure false positive
  expect(result.status).toBe('ok');
  expect(result.message).toContain('0/100');
}, 30_000);

test('old or partial remote counters fall back together; paired zero knowledge is vacuous', async () => {
  const legacy = { orphans: [], total_orphans: 900, total_linkable: 1000, total_pages: 1000, excluded: 0 };
  toolData = legacy;
  const old = await remoteCheck();
  expect(old.status).toBe('fail');
  expect(old.message).toContain('900/1000');
  expect(old.message).toContain('Ask the brain operator');
  toolData = { ...legacy, knowledge_orphans: 0 };
  expect((await remoteCheck()).status).toBe('fail');
  toolData = { ...legacy, knowledge_orphans: 0, knowledge_linkable: 0 };
  const empty = await remoteCheck();
  expect(empty.status).toBe('ok');
  expect(empty.message).toContain('Vacuous');
  receipt.legacy_remote = { fallback: old.status, zero_knowledge: empty.status };
});
