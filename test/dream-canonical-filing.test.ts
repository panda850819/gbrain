import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const synthesizeSrc = readFileSync(
  new URL('../src/core/cycle/synthesize.ts', import.meta.url),
  'utf8',
);
const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf8',
);
const filingRules = JSON.parse(readFileSync(
  new URL('../skills/_brain-filing-rules.json', import.meta.url),
  'utf8',
));
const filingRulesMd = readFileSync(
  new URL('../skills/_brain-filing-rules.md', import.meta.url),
  'utf8',
);

describe('dream canonical filing contract', () => {
  test('synthesize writes only canonical reflection and original paths', () => {
    expect(synthesizeSrc).toContain('reflections/dreams/${dateHint}-<topic-slug>-${hashSuffix}');
    expect(synthesizeSrc).toContain('originals/${dateHint}-<idea-slug>-${hashSuffix}');
    expect(synthesizeSrc).not.toContain('wiki/personal/reflections/${dateHint}');
    expect(synthesizeSrc).not.toContain('wiki/originals/ideas/${dateHint}');
  });

  test('filing rules and patterns phase contain no active wiki writer path', () => {
    expect(filingRules.dream_synthesize_paths.globs).toEqual([
      'reflections/dreams/*',
      'originals/*',
    ]);
    expect(filingRules.dream_patterns_path).toEqual({
      description: filingRules.dream_patterns_path.description,
      glob: 'learnings/patterns/*',
      slug_format: 'learnings/patterns/<topic-slug>',
    });
    expect(patternsSrc).not.toContain('wiki/personal/patterns/');
    expect(patternsSrc).not.toContain("slug LIKE 'wiki/personal/reflections/%'");
    expect(filingRulesMd).toContain('| People mentions | N/A (no direct write) |');
    expect(filingRulesMd).not.toContain('| People enrichment |');
  });
});
