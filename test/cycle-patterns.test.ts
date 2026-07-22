/**
 * Unit tests for the patterns phase (v0.21).
 *
 * The phase invokes a subagent and queues real Minions work, so this
 * file leans on structural assertions over the source + a single
 * end-to-end driver run that exercises the skip-paths.
 *
 * Full LLM behavior is exercised by E2E tests in test/e2e/.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { defaultDreamWriteTargets } from '../src/core/cycle/synthesize.ts';

const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf-8',
);

describe('patterns phase wiring', () => {
  test('imports queue + waitForCompletion + types', () => {
    expect(patternsSrc).toContain("import { MinionQueue }");
    expect(patternsSrc).toContain('waitForCompletion');
    expect(patternsSrc).toContain('SubagentHandlerData');
  });

  test('threads allowed_slug_prefixes from filing-rules JSON', () => {
    expect(patternsSrc).toContain('allowed_slug_prefixes');
    expect(patternsSrc).toContain('_brain-filing-rules.json');
    expect(patternsSrc).toContain('dream_synthesize_paths');
  });

  test('reads min_evidence + lookback_days config', () => {
    expect(patternsSrc).toContain('dream.patterns.min_evidence');
    expect(patternsSrc).toContain('dream.patterns.lookback_days');
  });

  test('uses subagent_tool_executions for slug provenance (Codex #2 fix)', () => {
    expect(patternsSrc).toContain('subagent_tool_executions');
    expect(patternsSrc).toContain("tool_name = 'brain_put_page'");
  });

  test('gates on gateway provider reachability, not ANTHROPIC_API_KEY (PR #2279)', () => {
    // The gate must probe the RESOLVED patterns model through the gateway
    // (any configured provider can run patterns), not hardcode the Anthropic
    // env var — that misclassified non-Anthropic stacks as "no upstream".
    expect(patternsSrc).toContain('probeChatModel');
    expect(patternsSrc).toContain('normalizeModelId');
    expect(patternsSrc).toContain('no_provider');
    expect(patternsSrc).not.toContain('process.env.ANTHROPIC_API_KEY');
  });

  test('skips when reflections below min_evidence', () => {
    expect(patternsSrc).toContain('insufficient_evidence');
  });

  test('reverse-writes pages to disk via serializeMarkdown', () => {
    expect(patternsSrc).toContain('serializeMarkdown');
    expect(patternsSrc).toContain('writeFileSync');
  });

  test('runs after extract — queries fresh graph', () => {
    // Documented invariant: pattern phase MUST run after extract.
    // The cycle.ts dispatcher enforces order; this just confirms the
    // patterns module doesn't try to compute its own auto-link layer
    // (which would be a subtle regression).
    expect(patternsSrc).not.toContain('runAutoLink');
    expect(patternsSrc).not.toContain('extractPageLinks(');
  });

  test('does NOT use raw_data table (Codex #3 fix)', () => {
    expect(patternsSrc).not.toContain('putRawData');
    expect(patternsSrc).not.toContain('getRawData');
  });
});

describe('patterns scope filter', () => {
  test('filters reflections by a bound slug-prefix parameter', () => {
    // #2415 made the namespace ROOT configurable; dream_write_targets makes
    // the whole reflections prefix configurable. What stays pinned: the scope
    // filter is a BOUND parameter (never interpolated), and the prefix comes
    // from the resolved write target rather than a literal.
    expect(patternsSrc).toContain('slug LIKE $2');
    expect(patternsSrc).toContain('`${targets.reflections}/%`');
    expect(patternsSrc).not.toContain("slug LIKE '");
  });

  test('undeclared targets keep the pre-existing upstream reflection path', () => {
    // Behavioural guard for the default path the literal used to pin.
    expect(defaultDreamWriteTargets('wiki').reflections).toBe('wiki/personal/reflections');
    expect(defaultDreamWriteTargets('notes').reflections).toBe('notes/personal/reflections');
  });

  // Behavioural coverage for the soft-delete guard and for a configured
  // write target relocating the gather scope lives in
  // test/cycle-dream-output-root.test.ts (PGLite-backed). A source-string
  // grep here would go green on a refactor that dropped the guard.

  test('orders by updated_at DESC for recency-bias', () => {
    expect(patternsSrc).toContain('ORDER BY updated_at DESC');
  });

  test('caps gather to 100 reflections (cost control)', () => {
    expect(patternsSrc).toContain('LIMIT 100');
  });
});
