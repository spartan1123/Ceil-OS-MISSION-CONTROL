# HEARTBEAT.md

Heartbeats are currently disabled by the user.

On any heartbeat poll, do not perform checks or background work.
Reply exactly:
HEARTBEAT_OK

Only resume heartbeat tasks after the user explicitly asks to re-enable them.
