# TOOLS — Capabilities

Allowed: scan_secrets, check_permissions, audit_file_changes, threat_detection.
Forbidden: modify_permissions directly, access secret values.

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
- Allowed: scan_secrets, check_permissions, audit_file_changes, threat_detection.\n- Forbidden: modify_permissions directly, access secrets directly.

## Web Search Provider Access (2026-03-04)
- Direct internet research allowed for this role.
- Credentials are stored in `.secrets/web_search.env` (never print, never commit).
- Provider caps:
  - Brave: $5/month max
  - Tavily: $0/month (free tier only)
  - Serper: $0/month (free tier only)
  - SerpAPI: $0/month (free tier only)
- Failover order on cap/error: Brave -> Tavily -> Serper -> SerpAPI.
- Hard rule: Never expose API keys in logs, replies, or commits.

