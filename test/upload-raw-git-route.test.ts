import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { uploadRaw } from '../src/commands/files.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// The deployed git route resolves a source target and banks a real files row.
const SOURCE_ID = 'upload-raw-example';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

let repo: string;
let outside: string;
let logSpy: ReturnType<typeof spyOn>;

function lastJson(): Record<string, unknown> {
  const calls = logSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1][0]));
}

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var); product
  // output is canonical, so the registered source fixture must be too.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'upload-raw-repo-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'upload-raw-src-')));
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(join(repo, 'people', 'test-page.md'), '# Test Page');
  writeFileSync(join(outside, 'notes.txt'), 'raw tweet text');
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [SOURCE_ID, repo],
  );
  await engine.executeRaw('DELETE FROM files WHERE source_id = $1', [SOURCE_ID]);
  await engine.putPage('people/test-page', {
    title: 'Test Page', type: 'person', frontmatter: {},
    compiled_truth: 'Example page', timeline: '',
  }, { sourceId: SOURCE_ID });
  logSpy = spyOn(console, 'log');
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('upload-raw git route (small text file)', () => {
  test('out-of-repo source is copied into the page .raw/ sidecar', async () => {
    await uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/test-page', '--source', SOURCE_ID]);

    const dest = join(repo, 'people', '.raw', 'test-page', 'notes.txt');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('raw tweet text');

    const out = lastJson();
    expect(out.success).toBe(true);
    expect(out.storage).toBe('git');
    expect(out.copied).toBe(true);
    // path must point at the materialized destination, not echo the input
    expect(out.path).toBe(dest);
    expect(out.repo_path).toBe(join('people', '.raw', 'test-page', 'notes.txt'));
  });

  test('re-uploading identical content dedupes instead of duplicating', async () => {
    await uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/test-page', '--source', SOURCE_ID]);
    await uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/test-page', '--source', SOURCE_ID]);

    const sidecar = join(repo, 'people', '.raw', 'test-page');
    expect(readdirSync(sidecar)).toEqual(['notes.txt']);

    const out = lastJson();
    expect(out.success).toBe(true);
    expect(out.deduped).toBe(true);
    expect(out.copied).toBe(false);
  });

  test('same filename with different content lands as hash-suffixed sibling', async () => {
    await uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/test-page', '--source', SOURCE_ID]);
    writeFileSync(join(outside, 'notes.txt'), 'different content');
    await uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/test-page', '--source', SOURCE_ID]);

    const sidecar = join(repo, 'people', '.raw', 'test-page');
    const entries = readdirSync(sidecar).sort();
    expect(entries.length).toBe(2);
    expect(entries).toContain('notes.txt');
    const suffixed = entries.find(e => e !== 'notes.txt')!;
    expect(suffixed).toMatch(/^notes-[0-9a-f]{8}\.txt$/);
    expect(readFileSync(join(sidecar, suffixed), 'utf-8')).toBe('different content');
  });

  test('source already inside the repo is banked in the canonical sidecar and DB', async () => {
    const inRepo = join(repo, 'people', 'inline-note.txt');
    writeFileSync(inRepo, 'already tracked');
    await uploadRaw(engine, [inRepo, '--page', 'people/test-page', '--source', SOURCE_ID]);

    const dest = join(repo, 'people', '.raw', 'test-page', 'inline-note.txt');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('already tracked');
    const out = lastJson();
    expect(out.success).toBe(true);
    expect(out.copied).toBe(true);
    expect(out.path).toBe(dest);
    const rows = await engine.executeRaw<{
      source_id: string; page_slug: string; storage_path: string; metadata: { storage: string };
    }>('SELECT source_id, page_slug, storage_path, metadata FROM files WHERE source_id = $1', [SOURCE_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(SOURCE_ID);
    expect(rows[0].page_slug).toBe('people/test-page');
    expect(rows[0].storage_path).toBe(join('people', '.raw', 'test-page', 'inline-note.txt'));
    expect(rows[0].metadata.storage).toBe('git');
  });

  test('unknown page slug is an honest error, not a silent success', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(
        uploadRaw(engine, [join(outside, 'notes.txt'), '--page', 'people/no-such-page', '--source', SOURCE_ID])
      ).rejects.toThrow('exit:1');
      expect(existsSync(join(repo, 'people', '.raw', 'no-such-page'))).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
