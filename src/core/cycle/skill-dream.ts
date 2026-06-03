/**
 * skill-dream phase — agent self-improvement loop (the "YC dream cycle").
 *
 * Reads recent RAW agent conversation transcripts (captured by
 * ~/.gbrain/capture-transcripts.py from Claude Code / Hermes), asks Sonnet
 * what skill / config / memory changes would have made the agent better,
 * and writes the proposals as a DRAFT to inbox/skill-proposals/<date>.md
 * for the user to review and apply. Never auto-applies (solo operator: the
 * user is the review gate; there is no team-broadcast social control).
 *
 * Distinct from `synthesize` (transcripts → brain knowledge pages) — this
 * phase improves the AGENT (skills/harness), not the brain's knowledge.
 *
 * Gated by `dream.skill_dream.enabled` (opt-in) + a cooldown so it does not
 * burn tokens every autopilot tick.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseStatus } from '../cycle.ts';

const TRANSCRIPT_DIR = join(homedir(), '.gbrain', 'transcripts');
const CAPTURE_SCRIPT = join(homedir(), '.gbrain', 'capture-transcripts.py');
const DEFAULT_DAYS = 2;
const DEFAULT_COOLDOWN_HOURS = 20;
const MAX_TOTAL_CHARS = 120_000; // keep prompt inside Sonnet's 200K window with headroom
const DEFAULT_MODEL = 'sonnet';

const SYSTEM_PROMPT = `You audit an AI agent's own recent conversation transcripts to make the agent better next time.

Propose concrete, HIGH-CONFIDENCE patches to one of these targets. Use the EXACT path:
  - pandastack-private skill  → ~/site/skills/pandastack-private/skills/<name>/SKILL.md
  - gbrain built-in skill     → ~/gbrain/skills/<name>/SKILL.md
  - substrate operating rule  → ~/.agents/AGENTS.md
  - cross-CLI memory (feedback/preference/project) → ~/.agents/memory/<name>.md
  - Claude-project memory     → ~/.claude/projects/-Users-panda-site-knowledge-brain/memory/<name>.md
  - Claude runtime shim       → ~/.claude/CLAUDE.md
If you are NOT certain which file a skill lives in, write "path uncertain — verify" in the Target line instead of guessing a path. Public pandastack skills live under ~/site/skills/pandastack/ but the exact file is not always a plain SKILL.md — flag uncertainty rather than inventing.

Only propose where a transcript shows a REAL recurring friction, a user correction, or context the agent clearly lacked. Do not invent improvements. "Recurring" means it appears in MORE THAN ONE transcript or session — if you see it once, say "single occurrence" and lower confidence. Quality over quantity: 0-5 proposals is normal.

Output GitHub-flavored markdown. For each proposal use this exact shape:

## Proposal: <one-line title>
- **Target**: <file path or skill name>
- **Signal**: <the transcript moment that justifies this — quote or paraphrase>
- **Change**: <the concrete edit/addition, specific enough to apply>

If nothing is worth proposing, output a single line: "No high-confidence proposals this cycle."`;

interface SkillDreamOpts {
  brainDir: string;
  dryRun?: boolean;
}

function recentTranscripts(days: number): { path: string; text: string }[] {
  if (!existsSync(TRANSCRIPT_DIR)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const out: { path: string; mtime: number; text: string }[] = [];
  for (const name of readdirSync(TRANSCRIPT_DIR)) {
    if (!name.endsWith('.txt')) continue;
    const p = join(TRANSCRIPT_DIR, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    out.push({ path: name, mtime: st.mtimeMs, text: readFileSync(p, 'utf-8') });
  }
  // newest first, then cap total chars
  out.sort((a, b) => b.mtime - a.mtime);
  const kept: { path: string; text: string }[] = [];
  let total = 0;
  for (const t of out) {
    if (total + t.text.length > MAX_TOTAL_CHARS) break;
    kept.push({ path: t.path, text: t.text });
    total += t.text.length;
  }
  return kept;
}

/**
 * Run one LLM backend. Throws on failure so the caller can fall through to
 * the next backend in the chain.
 *   'gateway'    — gbrain multi-provider chat() (DeepSeek/DS4, OpenAI, …) via API key.
 *   'claude-cli' — Claude subscription via `claude -p` (no API key).
 */
async function callBackend(backend: string, model: string, corpus: string): Promise<string> {
  if (backend === 'gateway') {
    const { chat } = await import('../ai/gateway.ts');
    const res = await chat({
      model: model || undefined,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Recent agent transcripts:\n${corpus}` }],
      maxTokens: 4096,
    });
    const text = (res.text || '').trim();
    if (!text) throw new Error('gateway returned empty');
    return text;
  }
  // claude-cli (default)
  const m = model || DEFAULT_MODEL;
  const prompt = `${SYSTEM_PROMPT}\n\n---\nRecent agent transcripts:\n${corpus}`;
  const res = spawnSync('claude', ['-p', '--model', m], {
    input: prompt,
    encoding: 'utf-8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CLAUDECODE: '' }, // avoid nested-session conflicts
  });
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) {
    const why = res.error ? res.error.message : `status ${res.status}: ${(res.stderr || '').slice(0, 200)}`;
    throw new Error(`claude -p failed (${why})`);
  }
  return res.stdout.trim();
}

export async function runPhaseSkillDream(engine: BrainEngine, opts: SkillDreamOpts): Promise<PhaseResult> {
  const phase = 'skill-dream' as const;
  const base = (status: PhaseStatus, summary: string, details: Record<string, unknown> = {}): PhaseResult =>
    ({ phase, status, duration_ms: 0, summary, details });

  const enabled = await engine.getConfig('dream.skill_dream.enabled');
  if (enabled !== 'true') {
    return base('skipped', 'disabled (set dream.skill_dream.enabled=true)', { reason: 'disabled' });
  }

  // Cooldown: avoid burning tokens every autopilot tick.
  const cooldownHours = Number(await engine.getConfig('dream.skill_dream.cooldown_hours')) || DEFAULT_COOLDOWN_HOURS;
  const last = await engine.getConfig('dream.skill_dream.last_completion_ts');
  if (last) {
    const ageH = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (ageH < cooldownHours) {
      return base('skipped', `cooldown (${ageH.toFixed(1)}h < ${cooldownHours}h)`, { reason: 'cooldown' });
    }
  }

  const days = Number(await engine.getConfig('dream.skill_dream.days')) || DEFAULT_DAYS;

  // Refresh the raw transcript corpus (best-effort; continue on failure).
  // Skipped on dry-run to keep dry-run side-effect-free.
  if (!opts.dryRun && existsSync(CAPTURE_SCRIPT)) {
    try {
      spawnSync('python3', [CAPTURE_SCRIPT, '--days', String(days)], { timeout: 60_000 });
    } catch { /* best-effort */ }
  }

  const transcripts = recentTranscripts(days);
  if (transcripts.length === 0) {
    return base('ok', 'no recent transcripts to analyze', { transcripts: 0 });
  }

  if (opts.dryRun) {
    return base('ok', `dry-run: would analyze ${transcripts.length} transcript(s)`, {
      transcripts: transcripts.length,
      files: transcripts.map((t) => t.path),
    });
  }

  // LLM backend chain (primary → fallback). Default: claude-cli (Claude
  // subscription, no API key) primary; configure a gateway/DeepSeek fallback
  // for when `claude -p` is down. Each entry: {backend, model}.
  //   dream.skill_dream.llm_backend     primary backend  (default 'claude-cli')
  //   dream.skill_dream.model           primary model    ('sonnet' default for cli)
  //   dream.skill_dream.fallback_backend optional 2nd try ('gateway')
  //   dream.skill_dream.fallback_model   fallback model  ('deepseek:deepseek-chat')
  const chain: { backend: string; model: string }[] = [{
    backend: (await engine.getConfig('dream.skill_dream.llm_backend')) || 'claude-cli',
    model: (await engine.getConfig('dream.skill_dream.model')) || '',
  }];
  const fbBackend = await engine.getConfig('dream.skill_dream.fallback_backend');
  if (fbBackend) {
    chain.push({ backend: fbBackend, model: (await engine.getConfig('dream.skill_dream.fallback_model')) || '' });
  }

  const corpus = transcripts
    .map((t) => `\n===== transcript: ${t.path} =====\n${t.text}`)
    .join('\n');

  let proposals = '';
  let usedBackend = '';
  let usedModel = '';
  const errors: string[] = [];
  for (const step of chain) {
    try {
      proposals = await callBackend(step.backend, step.model, corpus);
      usedBackend = step.backend;
      usedModel = step.model || (step.backend === 'claude-cli' ? DEFAULT_MODEL : '(gateway default)');
      break;
    } catch (e) {
      errors.push(`${step.backend}: ${(e as Error).message}`);
    }
  }
  if (!proposals) {
    return base('fail', `all backends failed: ${errors.join(' | ')}`, { transcripts: transcripts.length });
  }

  // Write the draft for the user to review (never auto-apply).
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(opts.brainDir, 'inbox', 'skill-proposals');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${date}.md`);
  const body = [
    '---',
    'type: brief',
    `created: ${date}`,
    `title: Skill-dream proposals ${date}`,
    'status: draft',
    '---',
    '',
    `> Auto-generated by the skill-dream cycle phase from ${transcripts.length} recent transcript(s).`,
    '> Review and apply by hand — nothing here is auto-applied.',
    '',
    `**Transcripts analyzed:** ${transcripts.map((t) => t.path).join(', ')}`,
    '',
    proposals,
    '',
  ].join('\n');
  writeFileSync(outPath, body, 'utf-8');

  await engine.setConfig('dream.skill_dream.last_completion_ts', new Date().toISOString());

  return base('ok', `wrote proposals from ${transcripts.length} transcript(s)`, {
    transcripts: transcripts.length,
    out: outPath,
    backend: usedBackend,
    model: usedModel,
  });
}
