import { describe, expect, test } from 'bun:test';
import { PostgresEngine, sanitizePostgresText } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput, TimelineBatchInput } from '../src/core/engine.ts';

function makeFakeSql() {
  const calls: unknown[][] = [];
  const fake = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve([]);
  }) as any;
  fake.array = (value: unknown[], type: number) => ({ __pgArray: true, value, type });
  return { fake, calls };
}

function expectTypedTextArrays(values: unknown[], count: number) {
  expect(values).toHaveLength(count);
  for (const value of values) {
    expect(Array.isArray(value)).toBe(false);
    expect(value).toMatchObject({ __pgArray: true, type: 1009 });
  }
}

describe('PostgresEngine batch SQL array binding', () => {
  test('sanitizes unpaired UTF-16 surrogates before writing text to Postgres', () => {
    expect(sanitizePostgresText('\uDD01 / 1 💬')).toBe('� / 1 💬');
    expect(sanitizePostgresText('keeps valid pair 💬')).toBe('keeps valid pair 💬');
    expect(sanitizePostgresText('bad high \uD83D x')).toBe('bad high � x');
    expect(sanitizePostgresText(null)).toBeNull();
  });

  test('binds link batch columns with postgres.js typed array parameters', async () => {
    const { fake, calls } = makeFakeSql();
    const engine = new PostgresEngine() as any;
    engine._sql = fake;

    const links: LinkBatchInput[] = [
      {
        from_slug: 'media/articles/source-page',
        to_slug: 'people/dotey',
        link_type: 'mentions',
        context: '中文 context, braces {x}, quote "x", wikilink [[people/dotey\\|dotey @dotey]]',
        link_source: 'wikilink-resolved',
        from_source_id: 'default',
        to_source_id: 'default',
        origin_source_id: 'default',
      },
    ];

    await engine._addLinksBatchOnce(links);

    expect(calls).toHaveLength(1);
    expectTypedTextArrays(calls[0], 11);
  });

  test('binds timeline batch columns with postgres.js typed array parameters', async () => {
    const { fake, calls } = makeFakeSql();
    const engine = new PostgresEngine() as any;
    engine._sql = fake;

    const entries: TimelineBatchInput[] = [
      {
        slug: 'media/articles/yanhua-agentic-design-patterns-review-personalized',
        date: '2026-05-28',
        source: 'timeline',
        summary: '中文 summary, braces {x}, quote "x", wikilink [[people/yanhua\\|Yanhua]]',
        detail: 'long detail with [[concepts/agentic-memory]] and comma, backslash \\',
        source_id: 'default',
      },
    ];

    await engine._addTimelineEntriesBatchOnce(entries);

    expect(calls).toHaveLength(1);
    expectTypedTextArrays(calls[0], 6);
  });
});
