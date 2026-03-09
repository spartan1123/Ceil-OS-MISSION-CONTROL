# TOOLS — Capabilities

Allowed: check_os_health, monitor_agents, track_metrics, emit_alert.

---
## Legacy Preserved Notes

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

Add whatever helps you do your job. This is your cheat sheet.


## Imported Tool Policy Addendum (2026-03-03)
- check_os_health, monitor_agents, track_metrics, emit_alert.

## Web Search Access Policy (2026-03-04)
- Direct internet/API-key web search is disabled for this role.
- Use internal monitor metrics and health endpoints only.
- If external research is needed, escalate to Workspace Manager.

