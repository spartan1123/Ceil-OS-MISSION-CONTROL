# TOOLS
allow: read, write, edit, memory_search, memory_get, external-search (Brave/Tavily/Serper/SerpAPI)
deny: unrelated file traversal, direct cross-agent writes
secrets: .secrets/web_search.env (read-only)

provider_policy:
- failover_order: brave -> tavily -> serper -> serpapi
- caps:
  - brave: $5/month max
  - tavily: free-tier only ($0 paid)
  - serper: free-tier only ($0 paid)
  - serpapi: free-tier only ($0 paid)
