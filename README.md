# cache-keeper

A Claude Code mod that compacts a big session just before its ~60-minute prompt cache expires, so coming back to it later doesn't re-read the whole context at full price.

- **Idle compaction:** once a minute it checks the main session. If no turn is running, the last turn ended at least 55 minutes ago and the context is at least 80k tokens, it compacts once per idle stretch.
- **Task-end compaction:** right after a turn, if the context is at least 500k tokens and no subagent or background task is running, it compacts straight away. When it can't tell whether background work is running, it doesn't.
- **Status line:** `ctx 123k | cache warm 42m left`.
- **`/cacheboard`:** context size, idle time, cache minutes left, last compaction (time, tokens before -> after), including compactions started by Claude Code or by you.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-keeper --marketplace YOUR-GITHUB-USERNAME/cache-keeper
```

Answer `y` to add the marketplace, then choose the user scope.

From a shell:

```bash
claude plugin install cache-keeper --marketplace YOUR-GITHUB-USERNAME/cache-keeper
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `YOUR-GITHUB-USERNAME/cache-keeper`, then Add plugin.

This repository is private: it installs only on machines that already hold a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Settings

`~/.claude/cache-keeper.json` (or `$CLAUDE_CONFIG_DIR/cache-keeper.json`), created with these defaults at the first session start and re-read every minute:

```json
{ "idleMinutes": 55, "minTokens": 80000, "taskEndTokens": 500000, "taskEndEnabled": true, "cacheMinutes": 60 }
```

## Development

The decision logic is the pure function `compactReason(state, config)` in `hooks/decide.ts`; the Claude Code wiring is `hooks/register.ts`. Run the tests with `claude plugin test .`.
