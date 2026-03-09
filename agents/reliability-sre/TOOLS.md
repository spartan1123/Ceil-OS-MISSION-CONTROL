# TOOLS — Capabilities

Allowed: detect_stuck_tasks, retry_with_backoff, initiate_rollback, health_dashboard.

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
- detect_stuck_tasks, retry_with_backoff, initiate_rollback, health_dashboard.

## Web Search Access Policy (2026-03-04)
- Direct internet/API-key web search is disabled for this role.
- Use internal telemetry and platform signals only.
- If external research is needed, route request to Workspace Manager or Security/Provisioning as appropriate.

