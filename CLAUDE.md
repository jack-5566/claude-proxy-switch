# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Proxy Switch** is a Go CLI tool for managing multiple Claude/Codex proxy profiles.
It switches profile configuration across:
- `~/.claude/settings.json` (Claude Code env settings)
- `~/.codex/config.toml` (Codex base URL/model/api key)
- `~/.codex/auth.json` (Codex auth mode + API key)
- `~/.claude-profiles/profiles.json` (tool-managed profile storage)

## Running the Tool

```bash
# Run directly
go run . --help

# Build binary
go build -o claude-proxy

# Example commands
claude-proxy --help
claude-proxy add <name> <baseUrl> [options]
claude-proxy list
claude-proxy use <name>
claude-proxy show
claude-proxy doctor
claude-proxy fix
claude-proxy clean
claude-proxy codex-reset
```

Minimal module:
- `go.mod` (Go 1.21)
- `main.go` (all core logic)

## Architecture

**Single-file application**: all logic is in `main.go`.

### Data Flow

1. `main()` dispatches subcommands (`add`, `use`, `doctor`, etc.)
2. Profiles are loaded/saved via `loadProfiles()` / `saveProfiles()`
3. Claude settings are read/merged with `loadClaudeSettings()` / `saveClaudeSettings()`
4. Codex config is synced via `applyCodexProfile()` and `applyCodexAuth()`
5. Writes use atomic temp-file + rename (`writeJSONAtomic()`, `saveCodexToml()`)

### Key Paths

| Path | Purpose |
|------|---------|
| `~/.claude-profiles/profiles.json` | Profile storage (`current` + named profiles) |
| `~/.claude/settings.json` | Claude global config (`env` is partially managed) |
| `~/.claude/settings.local.json` | Legacy file scanned/fixed/cleaned by maintenance commands |
| `~/.codex/config.toml` | Codex top-level keys managed: `openai_base_url`, `api_key`, `model` |
| `~/.codex/auth.json` | Codex auth file set to API key mode |

### Managed Environment Keys (`profileEnvKeys`)

The tool exclusively manages these keys inside `settings.json`'s `env` object, preserving all others:

```
ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL,
API_TIMEOUT_MS, HTTP_PROXY, HTTPS_PROXY
```

### Special Behaviors

- **Mimo model mapping**: `syncModelEnv()` maps Mimo profiles to `ANTHROPIC_DEFAULT_*_MODEL` keys and removes `ANTHROPIC_MODEL`.
- **Atomic writes**: config writes use temp file + rename.
- **Backups**: target files are backed up before mutation (`*.bak.<timestamp>`).
- **Permissions**: config files are written with `0600`, directories with `0700`.
- **Conflict detection/repair**:
  - `doctor` scans shell env, Claude settings, Codex config, and rc files.
  - `fix` performs safe cleanup (including auth ambiguity cleanup).
  - `clean` removes all managed proxy keys from writable locations.
