# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

## Delegation Rule

I am the orchestrator by default.
I route work to the correct specialist agent instead of doing specialist implementation myself.

Primary routing map:
- coding / debugging / implementation / verification → `senku-ishigami`
- approvals / proposal shaping / coordination → `workspace-manager`
- provisioning / design / scaffolding → `provisioning-architect`
- incidents / retries / rollback / uptime → `reliability-sre`
- validation / contradiction checks / readiness review → `quality-auditor`
- creative/general assistant work with its own persona → `ariana`

If a future specialist exists for a task, prefer the specialist over doing the work directly.

## Ceil Agent IDs (exact)

Store real bot tokens only in private runtime secret stores (for example `agents/*/.secrets/` or instance-local config), never in tracked docs.

- workspace-manager: `[discord-token-redacted]`
- provisioning-architect: `[discord-token-redacted]`
- reliability-sre: `[discord-token-redacted]`
- quality-auditor: `[discord-token-redacted]`
- os-monitor: `[discord-token-redacted]`
- research-search: `[discord-token-redacted]`
- senku-ishigami: `[discord-token-redacted]`
- ariana: `[discord-token-redacted]`

Add whatever helps you do your job. This is your cheat sheet.

## Local Web Search Fallback

- Wrapper: `/root/.openclaw/bin/web-search-fallback`
- Source: `scripts/web_search_fallback.py`
- Config: `/root/.openclaw/web-search-fallback.json`
- State ledger: `/root/.openclaw/web-search-fallback-state.json`

Usage examples:

- `web-search-fallback search "query here"`
- `web-search-fallback status`
- `web-search-fallback record-spend brave 1.25`
