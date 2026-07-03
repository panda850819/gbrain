/**
 * Tests for `gbrain extract --source db` (v0.10.3 graph layer).
 *
 * Verifies the DB-source path of the unified `gbrain extract <subcommand>`
 * command. Companion to test/extract.test.ts which covers the fs-source path.
 *
 * Runs against in-memory PGLite. Idempotency, --type filtering, --dry-run
 * JSON output, and reconciliation correctness.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { backfillAtomSourceLinks, runExtract } from '../src/commands/extract.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000); // OAuth v25 + full migration chain needs breathing room

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

const personPage = (title: string, body = ''): PageInput => ({
  type: 'person', title, compiled_truth: body, timeline: '',
});

const companyPage = (title: string, body = ''): PageInput => ({
  type: 'company', title, compiled_truth: body, timeline: '',
});

const meetingPage = (title: string, body = ''): PageInput => ({
  type: 'meeting', title, compiled_truth: body, timeline: '',
});

describe('gbrain extract links --source db', () => {
  beforeEach(truncateAll);

  test('extracts links from meeting page with attendee refs', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage('meetings/standup', meetingPage(
      'Standup',
      'Attendees: [Alice](people/alice), [Bob](people/bob).',
    ));

    await runExtract(engine, ['links', '--source', 'db']);

    const links = await engine.getLinks('meetings/standup');
    expect(links.length).toBe(2);
    expect(new Set(links.map(l => l.to_slug))).toEqual(new Set(['people/alice', 'people/bob']));
    expect(links.every(l => l.link_type === 'attended')).toBe(true);
  });

  test('infers works_at type from CEO context', async () => {
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('people/alice', personPage(
      'Alice',
      '[Alice](people/alice) is the CEO of [Acme](companies/acme).',
    ));

    await runExtract(engine, ['links', '--source', 'db']);
    const links = await engine.getLinks('people/alice');
    const acmeLink = links.find(l => l.to_slug === 'companies/acme');
    expect(acmeLink?.link_type).toBe('works_at');
  });

  test('idempotent: running twice produces same link count', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises us.'));

    await runExtract(engine, ['links', '--source', 'db']);
    const after1 = await engine.getLinks('companies/acme');

    await runExtract(engine, ['links', '--source', 'db']);
    const after2 = await engine.getLinks('companies/acme');
    expect(after2.length).toBe(after1.length);
  });

  test('source_slug frontmatter creates idempotent source-to-atom edge', async () => {
    await engine.putPage('reflections/daily/2026-07-03', {
      type: 'note',
      title: 'Daily',
      compiled_truth: 'Source page',
      timeline: '',
    });
    await engine.putPage('atoms/2026-07-03-source-page-a1', {
      type: 'concept',
      title: 'Atom',
      compiled_truth: 'Distilled atom',
      timeline: '',
      frontmatter: { source_slug: 'reflections/daily/2026-07-03' },
    });

    await runExtract(engine, ['links', '--source', 'db']);
    await runExtract(engine, ['links', '--source', 'db']);

    const links = await engine.getLinks('reflections/daily/2026-07-03');
    const atomLinks = links.filter(l => l.to_slug === 'atoms/2026-07-03-source-page-a1');
    expect(atomLinks).toHaveLength(1);
    expect(atomLinks[0]).toMatchObject({
      link_type: 'source',
      link_source: 'frontmatter',
      origin_slug: 'atoms/2026-07-03-source-page-a1',
      origin_field: 'source_slug',
    });
  });

  test('atom source backfill chunks by cursor and reports created count', async () => {
    await engine.putPage('notes/source', {
      type: 'note',
      title: 'Source',
      compiled_truth: '',
      timeline: '',
    });
    await engine.putPage('atoms/a', {
      type: 'concept',
      title: 'A',
      compiled_truth: '',
      timeline: '',
      frontmatter: { source_slug: 'notes/source' },
    });
    await engine.putPage('atoms/b', {
      type: 'concept',
      title: 'B',
      compiled_truth: '',
      timeline: '',
      frontmatter: { source_slug: 'notes/source' },
    });

    const first = await backfillAtomSourceLinks(engine, { limit: 1 });
    expect(first.pages_processed).toBe(1);
    expect(first.created).toBe(1);
    expect(first.has_more).toBe(true);

    const second = await backfillAtomSourceLinks(engine, { afterSlug: first.last_slug ?? undefined, limit: 10 });
    expect(second.created).toBe(1);
    expect(second.has_more).toBe(false);

    const third = await backfillAtomSourceLinks(engine, { limit: 10 });
    expect(third.created).toBe(0);
  });

  test('skips refs to non-existent target pages', async () => {
    await engine.putPage('people/alice', personPage(
      'Alice',
      'Met [Phantom](people/phantom-ghost) at the event.',
    ));
    await runExtract(engine, ['links', '--source', 'db']);
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('--dry-run --json outputs JSON lines and writes nothing', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage(
      'Acme',
      '[Alice](people/alice) joined as CEO.',
    ));

    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      lines.push(str);
      return true;
    }) as any;

    try {
      await runExtract(engine, ['links', '--source', 'db', '--dry-run', '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLines = lines.filter(l => l.trim().startsWith('{'));
    expect(jsonLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(jsonLines[0].trim());
    expect(parsed.action).toBe('add_link');
    expect(parsed.from).toBeTruthy();
    expect(parsed.to).toBeTruthy();
    expect(parsed.type).toBeTruthy();

    const links = await engine.getLinks('companies/acme');
    expect(links.length).toBe(0);
  });

  test('--type filter only processes matching pages', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob', '[Alice](people/alice) is great.'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) joined.'));

    await runExtract(engine, ['links', '--source', 'db', '--type', 'person']);

    const bobLinks = await engine.getLinks('people/bob');
    expect(bobLinks.length).toBe(1);
    const acmeLinks = await engine.getLinks('companies/acme');
    expect(acmeLinks.length).toBe(0);
  });
});

describe('gbrain extract timeline --source db', () => {
  beforeEach(truncateAll);

  test('extracts dated timeline entries from page content', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice',
      compiled_truth: 'Alice is the CEO.',
      timeline: `## Timeline
- **2026-01-15** | Joined as CEO
- **2026-02-20** | Closed Series A`,
    });

    await runExtract(engine, ['timeline', '--source', 'db']);

    const entries = await engine.getTimeline('people/alice');
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.summary).sort()).toEqual(['Closed Series A', 'Joined as CEO']);
  });

  test('idempotent via DB constraint', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: '',
      timeline: '- **2026-01-15** | Same event',
    });
    await runExtract(engine, ['timeline', '--source', 'db']);
    await runExtract(engine, ['timeline', '--source', 'db']);
    const entries = await engine.getTimeline('people/alice');
    expect(entries.length).toBe(1);
  });

  test('skips invalid dates', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: '',
      timeline: `- **2026-01-15** | Valid
- **2026-13-45** | Invalid month/day
- **2026-02-30** | Feb 30 doesnt exist`,
    });
    await runExtract(engine, ['timeline', '--source', 'db']);
    const entries = await engine.getTimeline('people/alice');
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('Valid');
  });

  test('handles multiple date format variants', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: '',
      timeline: `- **2026-01-15** | Pipe variant
- **2026-02-20** -- Double dash variant
- **2026-03-10** - Single dash variant`,
    });
    await runExtract(engine, ['timeline', '--source', 'db']);
    const entries = await engine.getTimeline('people/alice');
    expect(entries.length).toBe(3);
  });

  test('--dry-run --json emits JSON, no DB writes', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: '',
      timeline: '- **2026-01-15** | Test event',
    });

    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      lines.push(str);
      return true;
    }) as any;
    try {
      await runExtract(engine, ['timeline', '--source', 'db', '--dry-run', '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLines = lines.filter(l => l.trim().startsWith('{'));
    expect(jsonLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(jsonLines[0].trim());
    expect(parsed.action).toBe('add_timeline');
    expect(parsed.date).toBe('2026-01-15');
    expect(parsed.summary).toBe('Test event');

    const entries = await engine.getTimeline('people/alice');
    expect(entries.length).toBe(0);
  });
});

describe('gbrain extract all --source db', () => {
  beforeEach(truncateAll);

  test('runs both links and timeline in one command', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme',
      compiled_truth: '[Alice](people/alice) joined as CEO.',
      timeline: '- **2026-01-15** | Hired Alice',
    });

    await runExtract(engine, ['all', '--source', 'db']);

    const links = await engine.getLinks('companies/acme');
    expect(links.length).toBe(1);
    const entries = await engine.getTimeline('companies/acme');
    expect(entries.length).toBe(1);
  });
});
