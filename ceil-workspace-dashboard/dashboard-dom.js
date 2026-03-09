(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  }
  root.CeilDashboardDom = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function renderStats(refs, metrics) {
    if (refs.statTotalTodayEl) refs.statTotalTodayEl.textContent = String(metrics.totalToday);
    if (refs.statTotalWeekEl) refs.statTotalWeekEl.textContent = String(metrics.totalWeek);
    if (refs.statMostActiveEl) refs.statMostActiveEl.textContent = metrics.mostActive;
    if (refs.statSuccessRateEl) refs.statSuccessRateEl.textContent = metrics.successRate;
  }

  function renderAgentCards(refs, agentSummaries, deps) {
    if (!refs.agentCardsGridEl) return;

    refs.agentCardsGridEl.innerHTML = agentSummaries
      .map((agent) => {
        const latest = agent.latest || null;
        const model = latest?.model_used ? deps.escapeHtml(latest.model_used) : "N/A";
        const task = latest?.task_description ? deps.escapeHtml(latest.task_description) : "No data yet";
        const lastActive = latest?.created_at ? deps.formatTimestamp(latest.created_at) : "No data yet";

        return `
          <article
            class="agent-card panel-card rounded-2xl p-4"
            style="
              --agent-border: ${deps.hexToRgba(agent.color, 0.58)};
              --agent-ring: ${deps.hexToRgba(agent.color, 0.25)};
              --agent-shadow: ${deps.hexToRgba(agent.color, 0.22)};
            "
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-base font-bold text-white">${agent.emoji} ${deps.escapeHtml(agent.name)}</p>
                <p class="mt-0.5 text-xs text-slate-300/85">${deps.escapeHtml(agent.subtitle)}</p>
              </div>

              <span class="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-200">
                <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
                Connected
              </span>
            </div>

            <div class="mt-4 space-y-2 text-xs">
              <div class="flex items-start justify-between gap-3">
                <span class="text-slate-400">Model</span>
                <span class="text-right font-medium text-slate-100">${model}</span>
              </div>
              <div class="flex items-start justify-between gap-3">
                <span class="text-slate-400">Last task</span>
                <span class="max-w-[65%] text-right font-medium text-slate-100">${task}</span>
              </div>
              <div class="flex items-start justify-between gap-3">
                <span class="text-slate-400">Last active</span>
                <span class="text-right font-medium text-slate-100">${deps.escapeHtml(lastActive)}</span>
              </div>
              <div class="flex items-start justify-between gap-3">
                <span class="text-slate-400">Tasks today</span>
                <span class="font-semibold text-white">${agent.tasksToday}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderRecentActivity(refs, logs, deps) {
    if (!refs.recentActivityEl) return;

    if (!Array.isArray(logs) || logs.length === 0) {
      refs.recentActivityEl.innerHTML =
        '<div class="empty-note rounded-xl px-4 py-6 text-center text-sm">No data yet</div>';
      return;
    }

    refs.recentActivityEl.innerHTML = logs
      .map((entry) => {
        const meta = deps.getAgentMeta(entry.agent_name);
        const accent = meta?.color || "#64748B";
        const status = deps.getStatusBadge(entry.status);
        const task = entry.task_description ? deps.escapeHtml(entry.task_description) : "No data yet";
        const model = entry.model_used ? deps.escapeHtml(entry.model_used) : "N/A";

        return `
          <article class="rounded-xl border border-white/10 bg-slate-900/40 p-3" style="border-left: 3px solid ${accent};">
            <div class="flex items-start justify-between gap-2">
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold"
                style="background:${deps.hexToRgba(accent, 0.2)}; border:1px solid ${deps.hexToRgba(accent, 0.45)}; color:${accent};"
              >
                ${deps.escapeHtml(entry.agent_name || "Unknown Agent")}
              </span>

              <span class="whitespace-nowrap text-[11px] text-slate-400">${deps.escapeHtml(deps.formatTimestamp(entry.created_at))}</span>
            </div>

            <p class="mt-2 text-sm font-medium text-slate-100">${task}</p>

            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="text-xs text-slate-300">Model: ${model}</span>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.klass}">
                ${deps.escapeHtml(status.label)}
              </span>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderModelUsage(refs, agentSummaries, deps) {
    if (!refs.modelUsageBodyEl) return;

    if (!Array.isArray(agentSummaries) || agentSummaries.length === 0) {
      refs.modelUsageBodyEl.innerHTML =
        '<tr><td colspan="3" class="px-3 py-3 text-center text-slate-300">No data yet</td></tr>';
      return;
    }

    refs.modelUsageBodyEl.innerHTML = agentSummaries
      .map((agent) => {
        const model = agent.latest?.model_used ? deps.escapeHtml(agent.latest.model_used) : "N/A";
        return `
          <tr class="text-slate-200">
            <td class="px-3 py-2 text-xs md:text-sm">${deps.escapeHtml(agent.name)}</td>
            <td class="px-3 py-2 text-xs md:text-sm">${model}</td>
            <td class="px-3 py-2 text-right text-xs font-semibold md:text-sm">${agent.tasksToday}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderAgentsView(refs, payload, deps) {
    renderStats(refs, {
      totalToday: payload.totalToday,
      totalWeek: payload.totalWeek,
      mostActive: payload.mostActive,
      successRate: payload.successRate,
    });

    renderAgentCards(refs, payload.agentSummaries, deps);
    renderRecentActivity(refs, payload.recentLogs, deps);
    renderModelUsage(refs, payload.agentSummaries, deps);

    const panelAgents = deps.getPanelAgents?.();
    if (panelAgents && panelAgents.classList.contains("active")) {
      deps.staggerActivePanelCards?.();
    }
  }

  function renderOrg(refs, config, statsByName, metrics, deps) {
    const totalAgents = config.CEIL_AGENTS.length;

    if (refs.orgStatTotalEl) refs.orgStatTotalEl.textContent = String(totalAgents);
    if (refs.orgStatActiveEl) refs.orgStatActiveEl.textContent = String(metrics.activeToday);
    if (refs.orgStatSuccessEl) refs.orgStatSuccessEl.textContent = metrics.successRate;
    if (refs.orgStatTasksEl) refs.orgStatTasksEl.textContent = String(metrics.totalToday);

    const get = (name) => statsByName.get(name) || { tasksToday: 0, latest: null };

    if (refs.orgOrchEl) {
      refs.orgOrchEl.innerHTML = deps.buildTier2Node(config.TIER2_ORCHESTRATOR, get(config.TIER2_ORCHESTRATOR.agentName));
    }

    if (refs.orgManagerEl) {
      refs.orgManagerEl.innerHTML = deps.buildTier3Node(config.TIER3_MANAGER, get(config.TIER3_MANAGER.agentName));
    }

    if (refs.orgChiefsEl) {
      refs.orgChiefsEl.innerHTML = config.TIER4_CHIEFS.map((def) => deps.buildChiefCard(def, get(def.agentName))).join("");
    }

    if (refs.orgExecEl) {
      refs.orgExecEl.innerHTML = config.TIER5_EXECUTION.map((def) => deps.buildExecCard(def, get(def.agentName))).join("");
    }

    deps.wireToggles?.();
  }

  return {
    renderStats,
    renderAgentCards,
    renderRecentActivity,
    renderModelUsage,
    renderAgentsView,
    renderOrg,
  };
});
