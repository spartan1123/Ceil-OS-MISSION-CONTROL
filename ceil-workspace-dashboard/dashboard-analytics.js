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
    isCountableTask,
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
      if (stats && (!isCountableTask || isCountableTask(row))) stats.tasksToday += 1;
    }

    const activeToday = [...statsByName.values()].filter((stats) => stats.tasksToday > 0).length;
    const totalToday = [...statsByName.values()].reduce((sum, stats) => sum + Number(stats.tasksToday || 0), 0);

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

  function summarizeMissionControlSnapshot({
    agents,
    tasks,
    events,
    now = new Date(),
  }) {
    const safeAgents = Array.isArray(agents) ? agents : [];
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    const safeEvents = Array.isArray(events) ? events : [];
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart);
    const day = weekStart.getDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    weekStart.setDate(weekStart.getDate() - mondayOffset);

    const agentSummaries = safeAgents.map((agent, index) => ({
      ...agent,
      emoji: agent.emoji || agent.avatar_emoji || "🤖",
      color: agent.color || ["#4F46E5", "#EC4899", "#06B6D4", "#10B981", "#7C3AED", "#F59E0B", "#3B82F6"][index % 7],
      subtitle: agent.subtitle || agent.role || agent.description || "Mission specialist",
      latest: null,
      tasksToday: 0,
    }));
    const summaryById = new Map(agentSummaries.map((agent) => [String(agent.id || ""), agent]));

    for (const task of safeTasks) {
      const assignedId = String(task && task.assigned_agent_id ? task.assigned_agent_id : "");
      if (!assignedId) continue;
      const summary = summaryById.get(assignedId);
      if (!summary) continue;
      const updatedAt = new Date(task.updated_at || task.created_at || 0);
      if (Number.isNaN(updatedAt.getTime())) continue;
      if (updatedAt >= dayStart && String(task.status || "").toLowerCase() !== "done") {
        summary.tasksToday += 1;
      }
      if (!summary.latest) {
        summary.latest = {
          task_description: task.title || task.description || "Live mission",
          model_used: task.model || summary.model || null,
          status: task.status || "active",
          created_at: task.updated_at || task.created_at || null,
        };
      }
    }

    for (const event of safeEvents) {
      const agentId = String(event && event.agent_id ? event.agent_id : "");
      const summary = summaryById.get(agentId);
      if (!summary || summary.latest) continue;
      summary.latest = {
        task_description: event.message || event.type || "Live mission event",
        model_used: event?.metadata?.model || summary.model || null,
        status: event.type || "active",
        created_at: event.created_at || null,
      };
    }

    const totalToday = agentSummaries.reduce((sum, agent) => sum + Number(agent.tasksToday || 0), 0);
    const weekTasks = safeTasks.filter((task) => {
      const updatedAt = new Date(task.updated_at || task.created_at || 0);
      return !Number.isNaN(updatedAt.getTime()) && updatedAt >= weekStart;
    });
    const successfulWeek = weekTasks.filter((task) => String(task.status || "").toLowerCase() === "done").length;

    return {
      agentSummaries,
      totalToday,
      totalWeek: weekTasks.length,
      successfulWeek,
      successRate: computeSuccessRate(weekTasks.length, successfulWeek),
      mostActive: formatMostActive(agentSummaries),
      recentLogs: safeEvents.slice(0, 50).map((event) => ({
        agent_name: event.agent_name || summaryById.get(String(event.agent_id || ""))?.name || "Unknown Agent",
        task_description: event.message || event.type || "Live mission event",
        model_used: event?.metadata?.model || null,
        status: event.type || "active",
        created_at: event.created_at || null,
      })),
      orgStatsByName: new Map(agentSummaries.map((agent) => [agent.name, { tasksToday: agent.tasksToday, latest: agent.latest }])),
      orgMetrics: {
        activeToday: agentSummaries.filter((agent) => agent.tasksToday > 0 || String(agent.effective_status || agent.status || "").toLowerCase() === "active").length,
        totalToday,
        totalWeek: weekTasks.length,
        successRate: computeSuccessRate(weekTasks.length, successfulWeek),
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
    summarizeMissionControlSnapshot,
  };
});
