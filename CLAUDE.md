# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Proxy Switch** is a CLI tool for managing multiple Claude Code proxy/relay configurations. It lets users switch between proxy profiles (e.g., Volcano Engine Ark, Xiaomi Mimo, direct Anthropic API) by updating `~/.claude/settings.json`.

## Running the Tool

```bash
# Install dependencies and link the binary
npm install
npm link

# Or use the install script
./install.sh

# Run commands
claude-proxy --help
claude-proxy add <name> <baseUrl> [options]
claude-proxy list
claude-proxy use <name>
claude-proxy doctor
claude-proxy fix
claude-proxy clean
```

There are no build steps or test scripts. The tool runs directly as a Node.js CLI.

## Architecture

**Single-file application**: All logic lives in `bin/claude-proxy-switch.js` (~658 lines). Commander.js is the only dependency.

### Data Flow

1. User runs a command → Commander.js dispatches to a handler function
2. Handler reads `~/.claude-profiles/profiles.json` (tool's profile storage)
3. Handler reads/writes `~/.claude/settings.json` (Claude Code's global config)
4. All writes use atomic temp-file + rename to prevent corruption

### Key Paths

| Path | Purpose |
|------|---------|
| `~/.claude-profiles/profiles.json` | Tool's profile storage (current + all profiles) |
| `~/.claude/settings.json` | Claude Code global config — only the `env` field is managed |

### Managed Environment Keys (`PROFILE_ENV_KEYS`)

The tool exclusively manages these keys inside `settings.json`'s `env` object, preserving all others:

```
ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL,
API_TIMEOUT_MS, HTTP_PROXY, HTTPS_PROXY
```

### Special Behaviors

- **Xiaomi Mimo**: When base URL is `https://api.xiaomimimo.com/anthropic` or model is `mimo-v2-pro`, `syncModelEnv()` sets all three model variant keys to `mimo-v2-pro` instead of using `ANTHROPIC_MODEL`.
- **Atomic writes**: `writeJsonAtomic()` writes to a `.tmp` file then renames to prevent partial writes.
- **Backups**: `backupFile()` creates `{file}.bak.{timestamp}` before any modification.
- **Permissions**: Settings files get `0o600`, directories get `0o700`.
- **Conflict detection**: `doctor` checks shell env vars, `~/.claude/settings.json`, and shell rc files (`~/.bashrc`, `~/.zshrc`, etc.) for conflicting `ANTHROPIC_*` values.
