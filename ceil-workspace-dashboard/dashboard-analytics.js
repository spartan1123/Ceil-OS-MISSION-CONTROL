(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  }
  root.CeilDashboardAnalytics = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function buildDefaultAgentSummaries(agents) {
    return (Array.isArray(agents) ? agents : []).map((agent) => ({
      ...agent,
      latest: null,
      tasksToday: 0,
    }));
  }

  function chooseLatestMeaningfulEntry(currentEntry, candidateEntry, isHousekeepingTask) {
    if (!currentEntry) return candidateEntry;
    if (typeof isHousekeepingTask !== "function") return currentEntry;
    if (isHousekeepingTask(currentEntry) && !isHousekeepingTask(candidateEntry)) {
      return candidateEntry;
    }
    return currentEntry;
  }

  function computeSuccessRate(totalWeek, successfulWeek) {
    const total = Number(totalWeek || 0);
    const successful = Number(successfulWeek || 0);
    return total > 0 ? `${((successful / total) * 100).toFixed(1)}%` : "N/A";
  }

  function formatMostActive(agentSummaries) {
    const mostActiveEntry = (Array.isArray(agentSummaries) ? agentSummaries : []).reduce(
      (max, current) => (current.tasksToday > max.tasksToday ? current : max),
      { name: "N/A", tasksToday: 0 },
    );

    return mostActiveEntry && mostActiveEntry.tasksToday > 0
      ? `${mostActiveEntry.name} (${mostActiveEntry.tasksToday})`
      : "N/A";
  }

  function summarizeAgentLogsForAgents({
    agents,
    latestEntries,
    todayEntries,
    todayTotalRows = 0,
    weekTotalCount = 0,
    weekSuccessCount = 0,
    resolveAgentFromLogName,
    isCountableTask,
    isHousekeepingTask,
    normalizeAgentName,
  }) {
    const agentSummaries = buildDefaultAgentSummaries(agents);
    const summaryByName = new Map(agentSummaries.map((agent) => [agent.name, agent]));

    for (const entry of latestEntries || []) {
      const meta = resolveAgentFromLogName?.(entry.agent_name);
      if (!meta) continue;

      const summary = summaryByName.get(meta.name);
      if (!summary) continue;
      summary.latest = chooseLatestMeaningfulEntry(summary.latest, entry, isHousekeepingTask);
    }

    for (const entry of todayEntries || []) {
      const meta = resolveAgentFromLogName?.(entry.agent_name);
      if (!meta) continue;

      const summary = summaryByName.get(meta.name);
      if (summary && isCountableTask?.(entry)) {
        summary.tasksToday += 1;
      }
    }

    const totalToday = agentSummaries.reduce((sum, agent) => sum + Number(agent.tasksToday || 0), 0);
    const unmatchedTodayNames = todayTotalRows > 0 && totalToday === 0
      ? [...new Set((todayEntries || []).map((row) => normalizeAgentName?.(row.agent_name)).filter(Boolean))]
      : [];

    return {
      agentSummaries,
      totalToday,
      totalWeek: Number(weekTotalCount || 0),
      successfulWeek: Number(weekSuccessCount || 0),
      successRate: computeSuccessRate(weekTotalCount, weekSuccessCount),
      mostActive: formatMostActive(agentSummaries),
      unmatchedTodayNames,
    };
  }

  function buildOrgChartStats({
    agents,
    latestEntries,
    todayEntries,
    weekTotalCount = 0,
    weekSuccessCount = 0,
    resolveAgentFromLogName,
  }) {
    const statsByName = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.name, { tasksToday: 0, latest: null }]));

    for (const row of latestEntries || []) {
      const meta = resolveAgentFromLogName?.(row.agent_name);
      if (!meta) continue;
      const stats = statsByName.get(meta.name);
      if (stats && !stats.latest) stats.latest = row;
    }

    for (const row of todayEntries || []) {
      const meta = resolveAgentFromLogName?.(row.agent_name);
      if (!meta) continue;
      const stats = statsByName.get(meta.name);
      if (stats) stats.tasksToday += 1;
    }

    const activeToday = [...statsByName.values()].filter((stats) => stats.tasksToday > 0).length;
    const totalToday = (todayEntries || []).length;

    return {
      statsByName,
      metrics: {
        activeToday,
        totalToday,
        totalWeek: Number(weekTotalCount || 0),
        successRate: computeSuccessRate(weekTotalCount, weekSuccessCount),
      },
    };
  }

  return {
    buildDefaultAgentSummaries,
    chooseLatestMeaningfulEntry,
    computeSuccessRate,
    formatMostActive,
    summarizeAgentLogsForAgents,
    buildOrgChartStats,
  };
});
