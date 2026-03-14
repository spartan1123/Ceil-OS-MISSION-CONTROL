(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  }
  root.CeilDashboardUtils = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeAgentName(name) {
    return String(name || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function hyphenateName(name) {
    return normalizeAgentName(name)
      .replace(/[\s/]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function agentSlugFromName(name, runtimeConfig) {
    const direct = runtimeConfig?.participantToSlug?.[String(name || "").trim()];
    if (direct) return direct;
    const normalized = hyphenateName(name);
    if (runtimeConfig?.canonicalSlugs?.includes(normalized)) return normalized;
    return null;
  }

  function sessionLabelForName(name, runtimeConfig) {
    return agentSlugFromName(name, runtimeConfig) || hyphenateName(name);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function hexToRgba(hex, alpha) {
    const normalized = String(hex || "").replace("#", "");
    if (normalized.length !== 6) return `rgba(124,58,237,${alpha})`;
    const r = Number.parseInt(normalized.slice(0, 2), 16);
    const g = Number.parseInt(normalized.slice(2, 4), 16);
    const b = Number.parseInt(normalized.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function formatTimestamp(value) {
    if (!value) return "No data yet";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "No data yet";
    return date.toLocaleString();
  }

  function createAgentResolver(agents) {
    const safeAgents = Array.isArray(agents) ? agents : [];
    const lookup = new Map(safeAgents.map((agent) => [normalizeAgentName(agent.name), agent]));
    const aliasIndex = safeAgents.map((agent) => ({
      agent,
      aliases: [...new Set([agent.name, ...(agent.aliases || [])].map((item) => normalizeAgentName(item)).filter(Boolean))],
    }));

    function resolveAgentFromLogName(name) {
      const normalized = normalizeAgentName(name);
      if (!normalized) return null;

      if (lookup.has(normalized)) {
        return lookup.get(normalized);
      }

      let bestMatch = null;
      let bestScore = 0;

      for (const item of aliasIndex) {
        for (const alias of item.aliases) {
          if (!alias) continue;

          let score = 0;
          if (normalized === alias) {
            score = 100 + alias.length;
          } else if (normalized.includes(alias)) {
            score = alias.length;
          } else if (alias.includes(normalized) && normalized.length >= 4) {
            score = normalized.length - 1;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = item.agent;
          }
        }
      }

      return bestMatch;
    }

    function getAgentMeta(name) {
      return resolveAgentFromLogName(name);
    }

    return {
      lookup,
      aliasIndex,
      resolveAgentFromLogName,
      getAgentMeta,
    };
  }

  function getStatusBadge(status) {
    const raw = String(status || "").trim();
    const normalized = raw.toLowerCase();

    if (normalized.includes("fail")) {
      return {
        label: raw || "Failed",
        klass: "border border-red-400/45 bg-red-500/20 text-red-200",
      };
    }

    if (isCompletedLikeStatus(raw)) {
      return {
        label: raw || "Completed",
        klass: "border border-emerald-400/45 bg-emerald-500/20 text-emerald-200",
      };
    }

    return {
      label: raw || "N/A",
      klass: "border border-slate-400/45 bg-slate-500/20 text-slate-200",
    };
  }

  function startOfTodayISO(now = new Date()) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }

  function isHousekeepingTask(entry) {
    const task = normalizeAgentName(entry?.task_description || "");
    if (!task) return true;

    return [
      "responding to user greeting",
      "supabase logging smoke test",
      "heartbeat",
      "health check response to user",
      "no reply",
      "ping",
    ].some((needle) => task.includes(needle));
  }

  const COMPLETED_LIKE_STATUS_TOKENS = Object.freeze([
    "complete",
    "success",
    "done",
    "resolved",
    "pass",
  ]);

  function getCompletedLikeStatusTokens() {
    return [...COMPLETED_LIKE_STATUS_TOKENS];
  }

  function getCompletedLikeStatusOrClause(column = "status") {
    return COMPLETED_LIKE_STATUS_TOKENS
      .map((token) => `${column}.ilike.%${token}%`)
      .join(",");
  }

  function isCompletedLikeStatus(status) {
    const value = normalizeAgentName(status || "");
    if (!value) return false;
    return COMPLETED_LIKE_STATUS_TOKENS.some((token) => value.includes(token));
  }

  function isCountableTask(entry) {
    if (!entry) return false;
    if (isHousekeepingTask(entry)) return false;
    return isCompletedLikeStatus(entry.status);
  }

  function startOfWeekISO(now = new Date()) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    date.setDate(date.getDate() - mondayOffset);
    return date.toISOString();
  }

  return {
    normalizeAgentName,
    agentSlugFromName,
    sessionLabelForName,
    escapeHtml,
    hexToRgba,
    formatTimestamp,
    createAgentResolver,
    getStatusBadge,
    startOfTodayISO,
    isHousekeepingTask,
    getCompletedLikeStatusTokens,
    getCompletedLikeStatusOrClause,
    isCompletedLikeStatus,
    isCountableTask,
    startOfWeekISO,
  };
});
