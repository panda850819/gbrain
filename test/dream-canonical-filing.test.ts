import { describe, expect, test } from 'bun:test';
import {
  defaultDreamWriteTargets,
  normalizeDreamTarget,
  loadDreamWriteTargets,
  unionAllowList,
  loadAllowedSlugPrefixes,
} from '../src/core/cycle/synthesize.ts';

/** Minimal getConfig stand-in — the loader only needs that one method. */
function fakeEngine(config: Record<string, string | null>) {
  return { getConfig: async (key: string) => config[key] ?? null };
}

describe('dream write targets — upstream defaults preserved', () => {
  test('a brain that configures nothing keeps the output_root-derived paths', async () => {
    await expect(loadDreamWriteTargets(fakeEngine({}), 'wiki')).resolves.toEqual({
      reflections: 'wiki/personal/reflections',
      originals: 'wiki/originals/ideas',
      patterns: 'wiki/personal/patterns',
    });
  });

  test('output_root still remaps the first segment', () => {
    expect(defaultDreamWriteTargets('notes')).toEqual({
      reflections: 'notes/personal/reflections',
      originals: 'notes/originals/ideas',
      patterns: 'notes/personal/patterns',
    });
  });

  test('a getConfig failure degrades to defaults instead of throwing', async () => {
    const engine = { getConfig: async () => { throw new Error('db down'); } };
    await expect(loadDreamWriteTargets(engine, 'wiki')).resolves
      .toEqual(defaultDreamWriteTargets('wiki'));
  });
});

describe('dream write targets — per-brain configuration', () => {
  test('config overrides only the keys it sets', async () => {
    const engine = fakeEngine({ 'dream.write_targets.patterns': 'learnings/patterns' });
    await expect(loadDreamWriteTargets(engine, 'wiki')).resolves.toEqual({
      reflections: 'wiki/personal/reflections',
      originals: 'wiki/originals/ideas',
      patterns: 'learnings/patterns',
    });
  });

  test('this brain’s taxonomy resolves end to end', async () => {
    const engine = fakeEngine({
      'dream.write_targets.reflections': 'reflections/dreams',
      'dream.write_targets.originals': 'originals',
      'dream.write_targets.patterns': 'learnings/patterns',
    });
    await expect(loadDreamWriteTargets(engine, 'wiki')).resolves.toEqual({
      reflections: 'reflections/dreams',
      originals: 'originals',
      patterns: 'learnings/patterns',
    });
  });

  test('empty or malformed values fall back rather than yielding a bare prefix', async () => {
    const engine = fakeEngine({
      'dream.write_targets.reflections': '',
      'dream.write_targets.originals': '/',
    });
    const resolved = await loadDreamWriteTargets(engine, 'wiki');
    expect(resolved.reflections).toBe('wiki/personal/reflections');
    expect(resolved.originals).toBe('wiki/originals/ideas');
  });

  test('trailing /* and / are normalized so callers append their own separator', () => {
    expect(normalizeDreamTarget('learnings/patterns/*')).toBe('learnings/patterns');
    expect(normalizeDreamTarget('learnings/patterns/')).toBe('learnings/patterns');
    expect(normalizeDreamTarget('')).toBeNull();
    expect(normalizeDreamTarget(42)).toBeNull();
  });
});

describe('config values are held to the slug grammar', () => {
  // A target becomes a put_page allow-list glob, and matchesSlugAllowList
  // treats `foo/*` as a PREFIX — an unvalidated `wiki` would widen the
  // patterns subagent from one folder to the whole namespace.
  test.each([
    ['learnings/patterns'],
    ['originals'],            // a single segment is legal — this brain uses it
  ])('accepts a well-formed prefix: %s', (value) => {
    expect(normalizeDreamTarget(value)).toBe(value);
  });

  test('the output root itself is refused even though its grammar is valid', async () => {
    // `wiki` passes SUMMARY_SLUG_RE, but as a glob it reads `wiki/*` — write
    // access to the entire namespace. Plausible typo: the sibling key
    // dream.synthesize.output_root takes exactly this value.
    expect(normalizeDreamTarget('wiki')).toBe('wiki');
    const engine = fakeEngine({ 'dream.write_targets.patterns': 'wiki' });
    await expect(loadDreamWriteTargets(engine, 'wiki')).resolves
      .toEqual(defaultDreamWriteTargets('wiki'));
  });

  test.each([
    ['Learnings/Patterns', 'uppercase'],
    ['learnings//patterns', 'empty segment'],
    ['../../etc', 'traversal'],
    ['learnings/pat%erns', 'SQL LIKE wildcard'],
    ['learnings/pat_erns', 'SQL LIKE single-char wildcard'],
    ['learnings patterns', 'whitespace'],
  ])('rejects %s (%s) and falls back', (value) => {
    expect(normalizeDreamTarget(value)).toBeNull();
  });

  test('a rejected value leaves the default in place end to end', async () => {
    const engine = fakeEngine({ 'dream.write_targets.patterns': '../../etc' });
    const resolved = await loadDreamWriteTargets(engine, 'wiki');
    expect(resolved.patterns).toBe('wiki/personal/patterns');
  });
});

describe('allow-list union', () => {
  test('configured targets become writable without editing the shipped globs', () => {
    const globs = unionAllowList(
      ['wiki/personal/reflections/*', 'dream-cycle-summaries/*'],
      { reflections: 'reflections/dreams', originals: 'originals', patterns: 'learnings/patterns' },
    );
    expect(globs).toContain('reflections/dreams/*');
    expect(globs).toContain('learnings/patterns/*');
    // the shipped entries survive — the union never narrows the allow-list
    expect(globs).toContain('dream-cycle-summaries/*');
    expect(globs).toContain('wiki/personal/reflections/*');
  });

  test('an unconfigured brain gets the SHIPPED globs unchanged', async () => {
    // Reads the real skills/_brain-filing-rules.json, not a fabricated array —
    // the previous version of this test constructed its own `shipped` list and
    // therefore could not detect that the default originals target
    // (wiki/originals/ideas) is subsumed by the shipped wiki/originals/*.
    const shipped = await loadAllowedSlugPrefixes('wiki');
    expect(shipped.length).toBeGreaterThan(0);
    expect(unionAllowList(shipped, defaultDreamWriteTargets('wiki'))).toEqual(shipped);
  });

  test('a target already covered by a shipped glob is not appended again', () => {
    const shipped = ['wiki/originals/*'];
    const targets = { ...defaultDreamWriteTargets('wiki'), reflections: 'wiki/originals/ideas' };
    expect(unionAllowList(shipped, targets)).not.toContain('wiki/originals/ideas/*');
  });
});
