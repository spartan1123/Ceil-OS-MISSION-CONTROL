# TOOLS
allow:
- read
- write
- edit
- memory_search
- memory_get
- cron

deny:
- sending outbound email without approval
- sharing secrets/tokens

notes:
- Keep mailbox operations auditable.
- Use least privilege for any email integration credentials.
