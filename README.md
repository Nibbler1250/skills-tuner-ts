# skills-tuner-ts

TypeScript port of [skills-tuner](https://github.com/Nibbler1250/skills-tuner) — a modular, gateway-agnostic human-in-loop tuner for ClaudeClaw-Plus (#14).

Core engine + native LLM-driven subjects (skills, voice, archiviste, MCP, tools) in pure TypeScript. ML subjects (Optuna hyperparam tuning, sklearn feature engineering) plug in via the `ExternalProcessSubject` adapter — language-agnostic stdio JSON-RPC contract.

**Status:** in active port. The Python reference implementation at https://github.com/Nibbler1250/skills-tuner has 3 stacked draft PRs covering core engine, Plus integration, and SkillsSubject.

## Architecture

- `src/core/` — engine, types, security primitives, config, LLM backends
- `src/storage/` — JSONL proposals, refused signatures, schema migrations
- `src/git_ops/` — branch isolation per proposal
- `src/adapters/` — Telegram, Plus event bus, CLI adapters
- `src/subjects/` — SkillsSubject (canonical example), ExternalProcessSubject (pluggable)

See https://github.com/Nibbler1250/skills-tuner/blob/feat/pr1-core/DESIGN.md for full architecture.
