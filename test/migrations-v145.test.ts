/**
 * Migration v145 (facts_kind_idea_alter) — F5.
 *
 * Widens the facts.kind CHECK with 'idea'. The constraint shipped INLINE in
 * v45's CREATE TABLE, so pre-v145 brains carry the 5-kind predicate and reject
 * kind='idea'. v145 first installs a widened NOT VALID replacement, validates
 * it outside the migration transaction, then swaps names in a short final
 * transaction. Partial runs converge idempotently without holding the strong
 * validation lock across the whole migration.
 *
 * Pinned contracts:
 * 1. v145 has the canonical name/idempotent flag plus the probe and widened
 *    6-kind predicate.
 * 2. Fresh init admits 'idea'.
 * 3. A v144 brain rejects 'idea', upgrades to the widened constraint, admits
 *    the row, and applies nothing on re-run.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

const V145 = MIGRATIONS.find(m => m.version === 145);
const V145_SQL = V145?.sql ?? '';
const V145_HANDLER = String(V145?.handler ?? '');
const WIDENED_LIST = "'event','preference','commitment','belief','fact','idea'";
const NARROW_LIST = "'event','preference','commitment','belief','fact'";

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** All facts_kind_check constraint definitions currently on facts. */
async function kindCheckDefs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'facts_kind_check' AND conrelid = 'facts'::regclass`,
  );
  return rows.map(r => r.def);
}

async function insertIdeaFact(fact: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (fact, kind, source) VALUES ($1, 'idea', 'test:v145')`,
    [fact],
  );
}

describe('migration v145 — structure', () => {
  test('exists with canonical name, idempotent flag, probe + widened predicate', () => {
    expect(V145).toBeDefined();
    expect(V145?.name).toBe('facts_kind_idea_alter');
    expect(V145?.idempotent).toBe(true);
    expect(V145_SQL).toContain(`conname = 'facts_kind_check_v145'`);
    expect(V145_SQL).toContain(`CHECK (kind IN (${WIDENED_LIST})) NOT VALID`);
    expect(V145_SQL).not.toContain('VALIDATE CONSTRAINT');
    expect(V145_HANDLER).toContain('VALIDATE CONSTRAINT facts_kind_check_v145');
    expect(V145_HANDLER).toContain('RENAME CONSTRAINT facts_kind_check_v145 TO facts_kind_check');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(145);
  });
});

describe('migration v145 — fresh init (PGLite)', () => {
  test("fresh schema's kind CHECK admits 'idea'; INSERT succeeds", async () => {
    const defs = await kindCheckDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain('idea');

    await insertIdeaFact('fresh-init idea row');
    const rows = await engine.executeRaw<{ kind: string }>(
      `SELECT kind FROM facts WHERE fact = 'fresh-init idea row'`,
    );
    expect(rows.map(r => r.kind)).toEqual(['idea']);
  });
});

describe('migration v145 — upgrade from a pre-v145 brain (PGLite)', () => {
  test('swaps the 5-kind constraint for the widened one; re-run applies nothing', async () => {
    // Simulate a pre-v145 brain: clear idea rows (they'd violate the narrow
    // CHECK on re-add), then restore the 5-kind constraint under the autogen
    // name v45's inline DDL produced.
    await engine.executeRaw(`DELETE FROM facts WHERE kind = 'idea'`);
    await engine.executeRaw('ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_kind_check');
    await engine.executeRaw(
      `ALTER TABLE facts ADD CONSTRAINT facts_kind_check CHECK (kind IN (${NARROW_LIST}))`,
    );

    // Positive control: the pre-v145 shape verifiably rejects kind='idea'.
    await expect(insertIdeaFact('blocked idea row')).rejects.toThrow();

    // Apply v145 via the real migration runner (ledger rewind below 145).
    await engine.setConfig('version', '144');
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const defs = await kindCheckDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain('idea');
    await insertIdeaFact('post-upgrade idea row');

    // Ledger idempotency: re-run applies nothing.
    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);

    // SQL-level idempotency: re-executing the v145 block on an up-to-date
    // brain converges (conditional drop + re-add of the identical predicate)
    // — no error, still exactly one constraint, still widened.
    await engine.runMigration(145, V145_SQL);
    const after = await kindCheckDefs();
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('idea');
    await insertIdeaFact('post-rerun idea row');
  });
});
