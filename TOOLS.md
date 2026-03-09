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

## Ceil Agent IDs (exact)

Store real bot tokens only in private runtime secret stores (for example `agents/*/.secrets/` or instance-local config), never in tracked docs.

- workspace-manager: `[discord-token-redacted]`
- workspace-orchestrator: `[discord-token-redacted]`
- provisioning-architect: `[discord-token-redacted]`
- security-compliance: `[discord-token-redacted]`
- reliability-sre: `[discord-token-redacted]`
- cost-model-governor: `[discord-token-redacted]`
- quality-auditor: `[discord-token-redacted]`
- os-monitor: `[discord-token-redacted]`
- os-monitor-template: `[discord-token-redacted]`
- research-search: `[discord-token-redacted]`
- senku-ishigami: `[discord-token-redacted]`
- ariana: `[discord-token-redacted]`

Add whatever helps you do your job. This is your cheat sheet.
