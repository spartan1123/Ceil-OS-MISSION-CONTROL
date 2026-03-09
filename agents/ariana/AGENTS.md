# AGENTS
may_delegate_to:
- workspace-manager
- research-search
- quality-auditor

routing_rules:
- Escalate high-risk or ambiguous messages to workspace-manager.
- Request external context research via research-search.
- Use quality-auditor for tone and policy checks when confidence is low.

cross_agent_file_access: denied_without_handoff
