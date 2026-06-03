# SkillOpt before/after routing experiments

Use this reference when Panda wants to try SkillOpt or any skill optimizer on PangPang/Hermes skills and explicitly cares about before/after data.

## Goal

Do not let SkillOpt mutate production skills directly. First build a bounded offline benchmark so the change has measurable deltas.

Good first benchmark class: PangPang routing quality.

Each example should include:

- `question`: user message
- `ground_truth.expected_skills`: skills historically loaded
- `ground_truth.expected_tools`: tools historically used
- `ground_truth.brain_first`: whether historical execution used `gbrain query/search/get`
- `ground_truth.had_tool_action`: whether tools were used
- `ground_truth.had_final_answer`: whether the assistant produced a final answer
- `task_type`: coarse label, e.g. `brain`, `github`, `health`, `link_ingest`, `tool_ops`, `general`

## Dataset pattern

Source historical conversations from Hermes session DB, then split into:

```text
data/<eval_name>/
├── train/items.json
├── val/items.json
└── test/items.json
```

The baseline report should include both distribution metrics and SkillOpt scores:

- dataset size and split sizes
- task type counts
- top expected skills
- top expected tools
- rates: tool action, brain-first, loaded-any-skill, final-answer
- SkillOpt baseline selection hard/soft
- SkillOpt baseline test hard/soft
- SkillOpt best skill test hard/soft
- delta hard/soft
- accepted/rejected/skipped edits

Distribution metrics are not quality scores. They prevent comparing before/after runs on silently different data.

## SkillOpt custom env shape

For a custom Hermes/PangPang routing env, implement:

- `dataloader.py`: subclass `SplitDataLoader`, load `.json` / `.jsonl` examples
- `rollout.py`: call `chat_target`, parse strict JSON, score against `ground_truth`
- `adapter.py`: subclass `EnvAdapter`, wire loader, rollout, and `run_minibatch_reflect`
- `skills/initial.md`: seed routing skill
- `configs/<eval_name>/default.yaml`: config with `env.name`, `skill_init`, `split_dir`
- register adapter in `scripts/train.py` `_register_builtins()`

Scoring for routing evals can use weighted components:

- skill F1
- tool F1
- brain-first boolean match
- had-tool-action boolean match
- should-answer/final-answer boolean match

## Safe operating rule

After SkillOpt produces `best_skill.md`, do not copy it wholesale into PangPang or real Hermes skills. Review it manually, then transplant only durable routing rules or pitfalls into the relevant class-level skill.

## Common setup notes

SkillOpt requires Python 3.10+. If macOS system `python3` is 3.9, create the venv with Homebrew Python, e.g. `/opt/homebrew/bin/python3.11 -m venv .venv`.

SkillOpt's OpenAI-compatible mode currently reuses Azure-style env var names:

```bash
export AZURE_OPENAI_ENDPOINT="https://api.openai.com/v1"
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_AUTH_MODE="openai_compatible"
```

For Azure OpenAI:

```bash
export AZURE_OPENAI_ENDPOINT="https://..."
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_AUTH_MODE="api_key"
```

Treat missing credentials as a run blocker, not as a quality result.
