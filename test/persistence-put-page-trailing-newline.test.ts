import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

// parseMarkdown trims a body's trailing newline, but a stored body can keep one:
// restoring a privacy-hidden Facts fence appends `## Facts …-->\n`. The file
// mirror of that row must still match its snapshot, or the next put_page is
// refused as an uncoordinated local edit.
async function repeatedRemotePut(databaseUrl?: string) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-put-newline-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'content'); mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const local: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const remote: OperationContext = { ...local, remote: true };
        const slug = 'people/alice-example';
        const content = '---\ntype: person\ntitle: Alice\n---\n\nAlice prefers short meetings.\n';
        const revision = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
        await operationsByName.put_page.handler(local, { slug, content });
        await operationsByName.remember.handler(local, { fact: 'Alice is planning a move', entity: slug,
          provenance: 'test conversation', visibility: 'private' });
        for (let i = 0; i < 2; i++) {
          await operationsByName.put_page.handler(remote, { slug, content, expected_revision: await revision() });
          const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
          expect(page.compiled_truth).toContain('Alice is planning a move');
          expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Alice is planning a move');
        }
        const edited = content.replace('short', 'brief');
        await operationsByName.put_page.handler(remote, { slug, content: edited, expected_revision: await revision() });
        expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('Alice prefers brief meetings.');
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('repeated remote put_page keeps a restored hidden Facts fence publishable', () => repeatedRemotePut(), 120_000);
test.skipIf(!process.env.DATABASE_URL)('Postgres repeated remote put_page keeps a restored hidden Facts fence publishable',
  () => repeatedRemotePut(process.env.DATABASE_URL), 120_000);

let engine: PGLiteEngine;
let home: string;
let root: string;
let worktreeId: string;
const sourceId = 'trailing-newline';
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-newline-target-'));
  root = join(home, 'source'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  worktreeId = (await claimWorktree(engine, sourceId, root)).worktree_id;
});
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function mirrored(slug: string, compiled_truth: string, timeline = '') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth, timeline }, { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  return { snapshot, row: { source_id: sourceId, worktree_id: worktreeId, slug } };
}

test('a stored body ending in LF matches its own file mirror', async () => {
  const { snapshot, row } = await mirrored('lf', 'Body ending in a newline.\n');
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toEndWith('/source/lf.md');
});

test('a stored body ending in CRLF and a timeline ending in LF match their file mirror', async () => {
  const { snapshot, row } = await mirrored('crlf', 'Body ending in CRLF.\r\n', '- 2026-10-22: drafted\n');
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toEndWith('/source/crlf.md');
});

test('trailing spaces are still a local edit', async () => {
  const { snapshot, row } = await mirrored('spaces', 'Body.');
  const file = join(root, 'spaces.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body changed.'));
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
});
