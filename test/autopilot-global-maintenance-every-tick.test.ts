/**
 * Brain-wide maintenance cadence is gated ONLY by `autopilot.last_global_at`
 * (60-min floor), checked on every autopilot tick — never by the process-local
 * full-cycle clock. Regression shape: the stamp lands mid-window, the next
 * full-cycle tick sees it 59m39s old and skips, and a full-cycle-only check
 * then waits another ~60 minutes, leaving maintenance ~2h stale.
 */
import { describe, test, expect, afterEach, setSystemTime } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dispatchGlobalMaintenanceTick } from '../src/commands/autopilot.ts';
import {
  shouldRunAutopilotFullCycle,
  shouldSleepHealthyAutopilot,
} from '../src/commands/autopilot-remediation-policy.ts';
import { LAST_GLOBAL_AT_KEY } from '../src/core/cycle.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TICK_MS = 300_000;
const STAMP = Date.UTC(2026, 10, 9, 12, 55, 55);

function harness(sources: Array<{ id: string }>) {
  const config = new Map<string, string>();
  const added: Array<{ name: string; opts: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const engine = {
    kind: 'postgres' as const,
    listAllSources: async () => sources,
    getConfig: async (k: string) => config.get(k) ?? null,
  } as unknown as BrainEngine;
  const queue = {
    add: async (name: string, _data: unknown, opts: Record<string, unknown>) => {
      added.push({ name, opts });
      return { id: added.length };
    },
  } as any;
  const tick = (slot: string) =>
    dispatchGlobalMaintenanceTick(engine, queue, {
      repoPath: '/tmp/brain', slot, timeoutMs: 1_800_000, jsonMode: false,
      log: (l) => logs.push(l), emit: (l) => logs.push(l),
    });
  return { config, added, logs, tick };
}

afterEach(() => { setSystemTime(); });

describe('dispatchGlobalMaintenanceTick — every tick, last_global_at floor only', () => {
  test('(a) a shouldFullCycle=false tick still dispatches once maintenance is stale', async () => {
    const h = harness([{ id: 'repo-a' }]);
    h.config.set(LAST_GLOBAL_AT_KEY, new Date(STAMP).toISOString());

    const now = STAMP + 59 * 60_000 + 39_000 + TICK_MS;
    setSystemTime(new Date(now));
    const minutesSinceLastFull = TICK_MS / 60_000;
    expect(shouldRunAutopilotFullCycle({ score: 85, planLength: 0, estimatedSeconds: 0, minutesSinceLastFull })).toBe(false);
    expect(shouldSleepHealthyAutopilot(85, 0, minutesSinceLastFull)).toBe(false);

    const r = await h.tick('slot-b');
    expect(r.dispatched).toBe(true);
    expect(h.added.map((a) => a.name)).toEqual(['autopilot-global-maintenance']);
    expect(h.added[0].opts.timeout_ms).toBe(1_800_000);
  });

  test('(a) a healthy-sleep tick still dispatches once maintenance is stale', async () => {
    const h = harness([{ id: 'repo-a' }]);
    h.config.set(LAST_GLOBAL_AT_KEY, new Date(STAMP).toISOString());
    setSystemTime(new Date(STAMP + 61 * 60_000));
    expect(shouldSleepHealthyAutopilot(98, 0, 10)).toBe(true);

    const r = await h.tick('slot-c');
    expect(r.dispatched).toBe(true);
    expect(h.added.length).toBe(1);
  });

  test('(b) no re-dispatch within 60 minutes of last_global_at; each skip logs the age in minutes', async () => {
    const h = harness([{ id: 'repo-a' }]);
    h.config.set(LAST_GLOBAL_AT_KEY, new Date(STAMP).toISOString());

    for (const offsetMs of [5 * 60_000, 30 * 60_000, 59 * 60_000 + 39_000]) {
      setSystemTime(new Date(STAMP + offsetMs));
      const r = await h.tick(`slot-${offsetMs}`);
      expect(r.dispatched).toBe(false);
      expect(r.reason).toBe('fresh');
    }
    expect(h.added.length).toBe(0);
    expect(h.logs).toEqual([
      '[dispatch] global maintenance skipped: last_global_at 5 min ago (< 60 min floor)',
      '[dispatch] global maintenance skipped: last_global_at 30 min ago (< 60 min floor)',
      '[dispatch] global maintenance skipped: last_global_at 59 min ago (< 60 min floor)',
    ]);

    setSystemTime(new Date(STAMP + 60 * 60_000));
    expect((await h.tick('slot-60')).dispatched).toBe(true);
    expect(h.added.length).toBe(1);
  });

  test('(b) after a dispatch stamps last_global_at, consecutive ticks do not dispatch again inside the floor', async () => {
    const h = harness([{ id: 'repo-a' }]);
    setSystemTime(new Date(STAMP));
    expect((await h.tick('slot-0')).dispatched).toBe(true);
    h.config.set(LAST_GLOBAL_AT_KEY, new Date(STAMP + 4 * 60_000).toISOString());

    for (let i = 1; i <= 12; i++) {
      setSystemTime(new Date(STAMP + i * TICK_MS));
      await h.tick(`slot-${i}`);
    }
    expect(h.added.length).toBe(1);

    setSystemTime(new Date(STAMP + 13 * TICK_MS));
    expect((await h.tick('slot-13')).dispatched).toBe(true);
    expect(h.added.length).toBe(2);
  });

  test('JSON mode emits a structured skip event carrying age_min', async () => {
    const h = harness([{ id: 'repo-a' }]);
    h.config.set(LAST_GLOBAL_AT_KEY, new Date(STAMP).toISOString());
    setSystemTime(new Date(STAMP + 42 * 60_000 + 10_000));
    const events: string[] = [];
    const engine = {
      listAllSources: async () => [{ id: 'repo-a' }],
      getConfig: async (k: string) => h.config.get(k) ?? null,
    } as unknown as BrainEngine;
    const r = await dispatchGlobalMaintenanceTick(engine, { add: async () => { throw new Error('must not submit'); } } as any, {
      repoPath: '/tmp/brain', slot: 's', timeoutMs: 1, jsonMode: true, emit: (l) => events.push(l), log: () => {},
    });
    expect(r.age_min).toBe(42);
    expect(events.map((e) => JSON.parse(e))).toEqual([
      { event: 'global_maintenance_skipped_fresh', last_global_at: new Date(STAMP).toISOString(), age_min: 42, floor_min: 60 },
    ]);
  });

  test('brains with no local-path sources stay on the legacy single cycle (no separate maintenance job)', async () => {
    const h = harness([]);
    setSystemTime(new Date(STAMP));
    const r = await h.tick('slot-legacy');
    expect(r).toEqual({ dispatched: false, reason: 'legacy_single_source' });
    expect(h.added.length).toBe(0);
  });
});

describe('autopilot.ts wiring — maintenance dispatch is not gated by shouldFullCycle', () => {
  const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');

  test('the per-tick call sits after the sleep/full-cycle/targeted chain, not inside the full-cycle branch', () => {
    const callIdx = SRC.indexOf('await dispatchGlobalMaintenanceTick(engine, queue, {');
    expect(callIdx).toBeGreaterThan(-1);
    expect(SRC.indexOf('await dispatchGlobalMaintenanceTick(', callIdx + 1)).toBe(-1);
    const fullCycleBranchIdx = SRC.indexOf('} else if (shouldFullCycle) {');
    const targetedBranchIdx = SRC.indexOf('for (const step of plan) {', fullCycleBranchIdx);
    expect(fullCycleBranchIdx).toBeGreaterThan(-1);
    expect(targetedBranchIdx).toBeGreaterThan(fullCycleBranchIdx);
    expect(callIdx).toBeGreaterThan(targetedBranchIdx);
    const fullCycleBranch = SRC.slice(fullCycleBranchIdx, targetedBranchIdx);
    expect(fullCycleBranch).not.toContain('dispatchGlobalMaintenance');
    expect(SRC.slice(callIdx, callIdx + 200)).toContain('timeoutMs: fullCycleTimeoutMs');
  });
});
