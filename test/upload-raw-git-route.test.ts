import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { uploadRaw } from '../src/commands/files.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// The git route of upload-raw never touches the engine; a bare object is enough.
const dummyEngine = {} as BrainEngine;

let repo: string;
let outside: string;
let originalCwd: string;
let logSpy: ReturnType<typeof spyOn>;

function lastJson(): Record<string, unknown> {
  const calls = logSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1][0]));
}

beforeEach(() => {
  originalCwd = process.cwd();
  // realpath: macOS tmpdir is a symlink (/var -> /private/var); cwd and
  // product output are realpaths, so the fixtures must be too.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'upload-raw-repo-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'upload-raw-src-')));
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(join(repo, 'people', 'test-page.md'), '# Test Page');
  writeFileSync(join(outside, 'notes.txt'), 'raw tweet text');
  process.chdir(repo);
  logSpy = spyOn(console, 'log');
});

afterEach(() => {
  process.chdir(originalCwd);
  logSpy.mockRestore();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('upload-raw git route (small text file)', () => {
  test('out-of-repo source is copied into the page .raw/ sidecar', async () => {
    await uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/test-page']);

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
    await uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/test-page']);
    await uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/test-page']);

    const sidecar = join(repo, 'people', '.raw', 'test-page');
    expect(readdirSync(sidecar)).toEqual(['notes.txt']);

    const out = lastJson();
    expect(out.success).toBe(true);
    expect(out.deduped).toBe(true);
    expect(out.copied).toBe(false);
  });

  test('same filename with different content lands as hash-suffixed sibling', async () => {
    await uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/test-page']);
    writeFileSync(join(outside, 'notes.txt'), 'different content');
    await uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/test-page']);

    const sidecar = join(repo, 'people', '.raw', 'test-page');
    const entries = readdirSync(sidecar).sort();
    expect(entries.length).toBe(2);
    expect(entries).toContain('notes.txt');
    const suffixed = entries.find(e => e !== 'notes.txt')!;
    expect(suffixed).toMatch(/^notes-[0-9a-f]{8}\.txt$/);
    expect(readFileSync(join(sidecar, suffixed), 'utf-8')).toBe('different content');
  });

  test('source already inside the repo is a genuine no-op', async () => {
    const inRepo = join(repo, 'people', 'inline-note.txt');
    writeFileSync(inRepo, 'already tracked');
    await uploadRaw(dummyEngine, [inRepo, '--page', 'people/test-page']);

    expect(existsSync(join(repo, 'people', '.raw', 'test-page', 'inline-note.txt'))).toBe(false);
    const out = lastJson();
    expect(out.success).toBe(true);
    expect(out.copied).toBe(false);
    expect(out.path).toBe(inRepo);
  });

  test('unknown page slug is an honest error, not a silent success', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(
        uploadRaw(dummyEngine, [join(outside, 'notes.txt'), '--page', 'people/no-such-page'])
      ).rejects.toThrow('exit:1');
      expect(existsSync(join(repo, 'people', '.raw', 'no-such-page'))).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
