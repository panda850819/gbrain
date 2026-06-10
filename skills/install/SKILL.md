---
name: install
description: Deprecated GBrain install skill. Use the setup skill instead.
triggers:
  - "install gbrain"
  - "setup gbrain"
  - "gbrain install"
mutating: false
---

# Install GBrain (Deprecated)

This skill has been replaced by the **setup** skill. See `skills/setup/SKILL.md`.

The setup skill provides:
- Auto-provision Supabase via CLI (< 2 min TTHW)
- Manual fallback with non-interactive init
- AGENTS.md auto-injection (upgrade-safe)
- First import and health verification
