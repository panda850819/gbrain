/**
 * Runtime-mode dream phase E2E.
 *
 * Exercises the real PGLite + MinionQueue + MinionWorker path with a real
 * child-process runtime. The child returns one tool call, GBrain executes the
 * allow-listed brain write, and the child then returns its final text.
 *
 * No provider SDK or cloud request is used. The test proves the phase contract
 * and runtime metadata survive the gateway-native tool loop.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { loadDreamWriteTargets, loadOutputRoot } from '../../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { withEnv } from '../helpers/with-env.ts';

function fakeRuntimeScript(): string {
  return [
    "import fs from 'node:fs';",
    "let body = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => {",
    '  const request = JSON.parse(body);',
    "  const logPath = process.env.GBRAIN_RUNTIME_TEST_REQUEST_LOG;",
    "  if (logPath) fs.appendFileSync(logPath, body.trim() + String.fromCharCode(10));",
    '  const payload = request.payload ?? {};',
    '  const messages = Array.isArray(payload.messages) ? payload.messages : [];',
    "  const hasToolResult = messages.some(message => Array.isArray(message.content) && message.content.some(block => block && block.type === 'tool-result'));",
    '  const slug = process.env.GBRAIN_RUNTIME_TEST_PATTERN_SLUG;',
    '  const evidence = process.env.GBRAIN_RUNTIME_TEST_EVIDENCE_SLUG;',
    "  const content = ['---', 'title: Runtime bridge pattern', 'type: note', '---', '', 'This pattern was written by the external runtime.', '', `Evidence: [[${evidence}]]`, ''].join(String.fromCharCode(10));",
    '  const input = { slug, content };',
    "  const result = hasToolResult"
      + " ? { text: 'pattern written', blocks: [{ type: 'text', text: 'pattern written' }], stopReason: 'end', usage: { input_tokens: 4, output_tokens: 2 }, model: 'external:pattern-model' }"
      + " : { text: '', blocks: [{ type: 'tool-call', toolCallId: 'runtime-put-page', toolName: 'brain_put_page', input }], stopReason: 'tool_calls', usage: { input_tokens: 5, output_tokens: 3 }, model: 'external:pattern-model' };",
    '  process.stdout.write(JSON.stringify({ protocol: request.protocol, request_id: request.request_id, operation: request.operation, status: \'completed\', result }));',
    '});',
  ].join(String.fromCharCode(10));
}

async function setupRig(): Promise<{ engine: PGLiteEngine; brainDir: string; cleanup: () => Promise<void> }> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-runtime-phase-brain-'));
  return {
    engine,
    brainDir,
    cleanup: async () => {
      resetGateway();
      try { await engine.disconnect(); } catch { /* best effort */ }
      rmSync(brainDir, { recursive: true, force: true });
    },
  };
}

async function seedReflections(engine: PGLiteEngine, count: number): Promise<string> {
  const targets = await loadDreamWriteTargets(engine, await loadOutputRoot(engine));
  for (let i = 0; i < count; i++) {
    await engine.putPage(`${targets.reflections}/2026-04-${String(15 + i).padStart(2, '0')}-runtime-e2e-${i}`, {
      type: 'note',
      title: `Reflection ${i}`,
      compiled_truth: `Reflection ${i} records a recurring runtime integration theme.`,
      timeline: '',
      frontmatter: { type: 'note', title: `Reflection ${i}` },
    });
  }
  return targets.reflections;
}

describe('E2E runtime mode — patterns phase', () => {
  test('runs the phase through a child runtime and preserves metadata and writes', async () => {
    const rig = await setupRig();
    const requestLog = mkdtempSync(join(tmpdir(), 'gbrain-runtime-request-log-'));
    const requestLogPath = join(requestLog, 'requests.ndjson');
    writeFileSync(requestLogPath, '');
    let worker: MinionWorker | undefined;
    let workerPromise: Promise<void> | undefined;
    try {
      const reflectionsPrefix = await seedReflections(rig.engine, 3);
      const targets = await loadDreamWriteTargets(rig.engine, await loadOutputRoot(rig.engine));
      const patternSlug = `${targets.patterns}/runtime-bridge-e2e`;
      const runId = 'runtime-pattern-e2e';
      const deadlineAtMs = Date.now() + 10 * 60 * 1000;

      await rig.engine.setConfig('dream.patterns.enabled', 'true');
      await rig.engine.setConfig('dream.patterns.min_evidence', '3');
      await rig.engine.setConfig('models.dream.patterns', 'external:pattern-model');
      await rig.engine.setConfig('facts.extraction_enabled', 'false');

      await withEnv({
        GBRAIN_RUNTIME_TEST_REQUEST_LOG: requestLogPath,
        GBRAIN_RUNTIME_TEST_PATTERN_SLUG: patternSlug,
        GBRAIN_RUNTIME_TEST_EVIDENCE_SLUG: `${reflectionsPrefix}/2026-04-15-runtime-e2e-0`,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      }, async () => {
        configureGateway({
          chat_model: 'external:pattern-model',
          env: {},
          runtime: {
            command: process.execPath,
            args: ['-e', fakeRuntimeScript()],
            capabilities: ['chat'],
            timeout_ms: 10_000,
          },
        });

        worker = new MinionWorker(rig.engine, {
          pollInterval: 25,
          healthCheckInterval: 0,
          stalledInterval: 1_000,
        });
        await registerBuiltinHandlers(worker, rig.engine, { quiet: true });
        workerPromise = worker.start();

        const phase = await runPhasePatterns(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          runId,
          deadlineAtMs,
        });
        expect(phase.status).toBe('ok');
        const details = phase.details as {
          reflections_considered: number;
          patterns_written: number;
          child_outcome: string;
          job_id: number;
        };
        expect(details.reflections_considered).toBe(3);
        expect(details.patterns_written).toBe(1);
        expect(details.child_outcome).toBe('completed');

        const page = await rig.engine.getPage(patternSlug);
        expect(page).not.toBeNull();
        expect(page!.title).toBe('Runtime bridge pattern');
        const renderedPath = join(rig.brainDir, `${patternSlug}.md`);
        expect(existsSync(renderedPath)).toBe(true);
        expect(readFileSync(renderedPath, 'utf8')).toContain('Runtime bridge pattern');

        const toolRows = await rig.engine.executeRaw<{ tool_name: string; status: string; input: unknown }>(
          `SELECT tool_name, status, input FROM subagent_tool_executions WHERE job_id = $1 ORDER BY id`,
          [details.job_id],
        );
        expect(toolRows).toHaveLength(1);
        expect(toolRows[0]!.tool_name).toBe('brain_put_page');
        expect(toolRows[0]!.status).toBe('complete');
        const toolInput = typeof toolRows[0]!.input === 'string'
          ? JSON.parse(toolRows[0]!.input)
          : toolRows[0]!.input as { slug?: string };
        expect(toolInput.slug).toBe(patternSlug);

        const requests = readFileSync(requestLogPath, 'utf8')
          .trim()
          .split(String.fromCharCode(10))
          .filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, any>);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        for (const request of requests) {
          expect(request.protocol).toBe('gbrain-runtime-v1');
          expect(request.operation).toBe('chat');
          expect(request.model).toBe('external:pattern-model');
          expect(request.run_id).toBe(runId);
          expect(request.phase).toBe('patterns');
          expect(request.idempotency_key).toBe(`dream:patterns:${runId}`);
          expect(request.deadline_at_ms).toBe(deadlineAtMs);
          expect(request.write_policy).toEqual({ mode: 'canonical', allow: [`${targets.patterns}/*`] });
        }

        const replay = await runPhasePatterns(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          runId,
          deadlineAtMs,
        });
        expect(replay.status).toBe('ok');
        const replayDetails = replay.details as {
          patterns_written: number;
          child_outcome: string;
          job_id: number;
        };
        expect(replayDetails.patterns_written).toBe(1);
        expect(replayDetails.child_outcome).toBe('completed');
        expect(replayDetails.job_id).toBe(details.job_id);

        const replayRequests = readFileSync(requestLogPath, 'utf8')
          .trim()
          .split(String.fromCharCode(10))
          .filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, any>);
        expect(replayRequests).toHaveLength(requests.length);

        const replayJobs = await rig.engine.executeRaw<{ id: number; idempotency_key: string }>(
          `SELECT id, idempotency_key FROM minion_jobs WHERE idempotency_key = $1`,
          [`dream:patterns:${runId}`],
        );
        expect(replayJobs).toHaveLength(1);
        expect(replayJobs[0]!.id).toBe(details.job_id);

        const replayToolRows = await rig.engine.executeRaw<{ id: number; status: string }>(
          `SELECT id, status FROM subagent_tool_executions WHERE job_id = $1 ORDER BY id`,
          [details.job_id],
        );
        expect(replayToolRows).toHaveLength(1);
        expect(replayToolRows[0]!.status).toBe('complete');
      });
    } finally {
      worker?.stop();
      if (workerPromise) await workerPromise;
      await rig.cleanup();
      rmSync(requestLog, { recursive: true, force: true });
    }
  }, 60_000);

  test('skips without chat capability and does not enqueue a job', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 3);
      await rig.engine.setConfig('dream.patterns.enabled', 'true');
      await rig.engine.setConfig('dream.patterns.min_evidence', '3');
      await rig.engine.setConfig('models.dream.patterns', 'external:pattern-model');
      configureGateway({
        chat_model: 'external:pattern-model',
        env: {},
        runtime: {
          command: process.execPath,
          capabilities: ['embedding'],
        },
      });

      const phase = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        runId: 'runtime-pattern-no-chat',
      });
      expect(phase.status).toBe('skipped');
      expect(phase.summary).toContain('configured external runtime does not expose the chat capability');

      const jobs = await rig.engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count FROM minion_jobs`,
        [],
      );
      expect(jobs[0]!.count).toBe('0');
    } finally {
      await rig.cleanup();
    }
  });
});
