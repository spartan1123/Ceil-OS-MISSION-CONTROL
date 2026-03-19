(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.CeilMissionQueue = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const QUEUE_COLUMNS = [
    { id: "planning", label: "Planning", tone: "rgba(124,58,237,.14)", border: "rgba(124,58,237,.42)", chip: "#C4B5FD" },
    { id: "inbox", label: "Inbox", tone: "rgba(59,130,246,.14)", border: "rgba(59,130,246,.42)", chip: "#93C5FD" },
    { id: "assigned", label: "Assigned", tone: "rgba(6,182,212,.14)", border: "rgba(6,182,212,.42)", chip: "#67E8F9" },
    { id: "in_progress", label: "In Progress", tone: "rgba(245,158,11,.14)", border: "rgba(245,158,11,.42)", chip: "#FCD34D" },
    { id: "testing", label: "Testing", tone: "rgba(236,72,153,.14)", border: "rgba(236,72,153,.42)", chip: "#F9A8D4" },
    { id: "review", label: "Review", tone: "rgba(168,85,247,.14)", border: "rgba(168,85,247,.42)", chip: "#D8B4FE" },
    { id: "verification", label: "Verification", tone: "rgba(20,184,166,.14)", border: "rgba(20,184,166,.42)", chip: "#99F6E4" },
    { id: "done", label: "Done", tone: "rgba(16,185,129,.14)", border: "rgba(16,185,129,.42)", chip: "#86EFAC" },
  ];

  const PRIORITY_THEME = {
    urgent: { label: "Urgent", bg: "rgba(239,68,68,.18)", border: "rgba(239,68,68,.5)", text: "#FCA5A5" },
    high: { label: "High", bg: "rgba(249,115,22,.18)", border: "rgba(249,115,22,.5)", text: "#FDBA74" },
    normal: { label: "Normal", bg: "rgba(59,130,246,.18)", border: "rgba(59,130,246,.5)", text: "#93C5FD" },
    low: { label: "Low", bg: "rgba(100,116,139,.18)", border: "rgba(100,116,139,.5)", text: "#CBD5E1" },
  };

  const TYPE_THEME = {
    general: { label: "General", color: "#94A3B8" },
    provision_workspace: { label: "Provisioning", color: "#67E8F9" },
  };

  const AGENT_LANES = {
    all: "all",
    working: "working",
    standby: "standby",
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function summarizeBoard(tasks) {
    const total = tasks.length || 1;
    const open = tasks.filter((task) => !["done", "verification"].includes(task.status)).length;
    const active = tasks.filter((task) => ["assigned", "in_progress", "testing", "review"].includes(task.status)).length;
    const done = tasks.filter((task) => task.status === "done").length;
    return {
      total,
      open,
      active,
      done,
      openPct: `${Math.round((open / total) * 100)}%`,
      activePct: `${Math.round((active / total) * 100)}%`,
      donePct: `${Math.round((done / total) * 100)}%`,
    };
  }

  function isSyntheticRuntimeTask(task) {
    const source = String(task && task.source ? task.source : "").toLowerCase();
    return Boolean(task && (task.runtime_derived || task.synthetic || source === "runtime"));
  }

  function isSyntheticRuntimeAgent(agent) {
    const source = String(agent && agent.source ? agent.source : "").toLowerCase();
    return Boolean(agent && (agent.runtime_derived || agent.synthetic || source === "runtime"));
  }

  function filterTasks(tasks, filters) {
    return tasks.filter((task) => {
      // NOTE: Runtime/synthetic tasks are now shown as they represent live agent activity
      // if (isSyntheticRuntimeTask(task)) return false;
      if (filters.assignee && String(task.assigned_agent_id || "") !== filters.assignee) return false;
      if (filters.priority && String(task.priority || "") !== filters.priority) return false;
      if (filters.status && String(task.status || "") !== filters.status) return false;
      if (filters.type && String(task.task_type || "general") !== filters.type) return false;
      return true;
    });
  }

  function inferAgentActivityState(agent, tasks) {
    if (isSyntheticRuntimeAgent(agent)) {
      return AGENT_LANES.standby;
    }
    const status = String(agent && (agent.effective_status || agent.status) ? (agent.effective_status || agent.status) : "").toLowerCase();
    const assignedCount = tasks.filter((task) => String(task.assigned_agent_id || "") === String(agent && agent.id ? agent.id : "")).length;
    if (["working", "active", "busy", "running", "in_progress"].includes(status) || assignedCount > 0) {
      return AGENT_LANES.working;
    }
    return AGENT_LANES.standby;
  }

  function getAgentSourceMeta(agent) {
    const source = String(agent && agent.source ? agent.source : "").toLowerCase();
    const gatewayAgentId = String(agent && agent.gateway_agent_id ? agent.gateway_agent_id : "").trim();
    if (source === "gateway" || source === "runtime" || gatewayAgentId) {
      return {
        label: "Gateway-linked",
        detail: gatewayAgentId || "Imported from gateway",
        tone: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
      };
    }
    return {
      label: "Local",
      detail: "Created inside Mission Control",
      tone: "border-violet-400/30 bg-violet-500/10 text-violet-200",
    };
  }

  function getAgentStatusMeta(agent, tasks) {
    const assignedCount = tasks.filter((task) => String(task.assigned_agent_id || "") === String(agent && agent.id ? agent.id : "")).length;
    const rawStatus = String(agent && (agent.effective_status || agent.status) ? (agent.effective_status || agent.status) : "standby").trim();
    const normalized = rawStatus.toLowerCase();
    const lane = inferAgentActivityState(agent, tasks);
    if (assignedCount > 0) {
      return {
        label: `${assignedCount} active task${assignedCount === 1 ? "" : "s"}`,
        chip: "Assigned",
        dot: "bg-emerald-400",
        tone: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
        lane,
      };
    }
    if (["working", "active", "busy", "running", "in_progress"].includes(normalized)) {
      return {
        label: rawStatus.replaceAll("_", " "),
        chip: "Working",
        dot: "bg-cyan-300",
        tone: "border-cyan-300/40 bg-cyan-500/15 text-cyan-200",
        lane,
      };
    }
    return {
      label: rawStatus.replaceAll("_", " "),
      chip: "Standby",
      dot: "bg-slate-500",
      tone: "border-slate-400/30 bg-slate-500/10 text-slate-300",
      lane,
    };
  }

  function filterAgentsByLane(agents, lane, tasks) {
    if (lane === AGENT_LANES.all) return agents.slice();
    return agents.filter((agent) => inferAgentActivityState(agent, tasks) === lane);
  }

  function feedLaneForEvent(event) {
    if (!event || typeof event !== "object") return "all";
    if (event.task_id || /^task_/i.test(String(event.type || ""))) return "tasks";
    if (event.agent_id || /^agent_/i.test(String(event.type || ""))) return "agents";
    return "all";
  }

  function filterFeedEvents(events, filter) {
    if (filter === "all") return events.slice();
    return events.filter((event) => feedLaneForEvent(event) === filter);
  }

  function buildPayloadFromForm(formState) {
    return {
      title: String(formState.title || "").trim(),
      description: String(formState.description || "").trim() || null,
      priority: formState.priority || "normal",
      status: formState.status || "inbox",
      task_type: formState.task_type || "general",
      assigned_agent_id: formState.assigned_agent_id || null,
      due_date: formState.due_date || null,
      workspace_id: formState.workspace_id || "default",
      business_id: formState.business_id || "default",
    };
  }

  function buildAgentPayloadFromForm(formState) {
    return {
      name: String(formState.name || "").trim(),
      role: String(formState.role || "").trim(),
      description: String(formState.description || "").trim() || null,
      avatar_emoji: String(formState.avatar_emoji || "").trim() || "🤖",
      status: formState.status || "standby",
      model: String(formState.model || "").trim() || null,
      soul_md: String(formState.soul_md || "").trim() || null,
      user_md: String(formState.user_md || "").trim() || null,
      agents_md: String(formState.agents_md || "").trim() || null,
      workspace_id: formState.workspace_id || "default",
    };
  }

  function buildGatewayImportPayload(candidates, selectedIds, workspaceId) {
    const picked = candidates.filter((item) => selectedIds.has(String(item.id || "")) && !item.already_imported);
    return {
      agents: picked.map((item) => ({
        gateway_agent_id: String(item.id || ""),
        name: String(item.name || item.id || "Unnamed"),
        workspace_id: workspaceId || "default",
      })),
    };
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) },
      ...options,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = payload && typeof payload === "object" ? payload.error || payload.message : payload;
      throw new Error(message || `Request failed (${response.status})`);
    }
    return payload;
  }

  function init(options) {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const panel = document.getElementById("panel-tasks");
    const boardEl = document.getElementById("mission-queue-board");
    const agentsRailEl = document.getElementById("mission-queue-agents");
    if (!panel || !boardEl || !agentsRailEl) return;

    const state = {
      workspaceId: (options && options.workspaceId) || "default",
      tasks: [],
      agents: [],
      filters: {
        assignee: "",
        priority: "",
        status: "",
        type: "",
      },
      agentLane: AGENT_LANES.all,
      sideView: "agents",
      feedFilter: "all",
      feedEvents: [],
      gatewayCandidates: [],
      gatewaySelection: new Set(),
      dragTaskId: null,
      editingTaskId: null,
      chart: null,
      sse: null,
      started: false,
      loading: false,
      renderCache: {
        contextKey: "",
        context: null,
        boardHtml: "",
        agentsHtml: "",
      },
    };

    const refs = {
      panel,
      boardEl,
      agentsRailEl: document.getElementById("mission-queue-agents"),
      bannerEl: document.getElementById("mission-queue-banner"),
      refreshBtn: document.getElementById("mission-queue-refresh-btn"),
      newBtn: document.getElementById("mission-queue-new-btn"),
      assigneeFilterEl: document.getElementById("tasks-filter-assignee"),
      priorityFilterEl: document.getElementById("tasks-filter-priority"),
      statusFilterEl: document.getElementById("tasks-filter-status"),
      typeFilterEl: document.getElementById("tasks-filter-type"),
      modalEl: document.getElementById("task-edit-modal"),
      modalTitleEl: document.getElementById("mission-queue-modal-title"),
      editTitleEl: document.getElementById("edit-title"),
      editDescriptionEl: document.getElementById("edit-description"),
      editPriorityEl: document.getElementById("edit-priority"),
      editStatusEl: document.getElementById("edit-status"),
      editTaskTypeEl: document.getElementById("edit-task-type"),
      editAssigneeEl: document.getElementById("edit-assignee"),
      editDueEl: document.getElementById("edit-due-date"),
      saveBtn: document.getElementById("edit-save-btn"),
      cancelBtn: document.getElementById("edit-cancel-btn"),
      openCountEl: document.getElementById("stat-queue-open-count"),
      openPctEl: document.getElementById("stat-queue-open-pct"),
      activeCountEl: document.getElementById("stat-queue-active-count"),
      activePctEl: document.getElementById("stat-queue-active-pct"),
      doneCountEl: document.getElementById("stat-done-count"),
      donePctEl: document.getElementById("stat-done-pct"),
      motivationEl: document.getElementById("tasks-motivation-badge"),
      chartCanvas: document.getElementById("tasks-donut-chart"),
      agentModalEl: document.getElementById("agent-edit-modal"),
      agentModalCloseBtn: document.getElementById("agent-modal-close-btn"),
      agentModalTabs: Array.from(document.querySelectorAll(".mission-agent-modal-tab")),
      agentNameEl: document.getElementById("agent-name"),
      agentRoleEl: document.getElementById("agent-role"),
      agentDescriptionEl: document.getElementById("agent-description"),
      agentEmojiEl: document.getElementById("agent-emoji"),
      agentStatusEl: document.getElementById("agent-status"),
      agentModelEl: document.getElementById("agent-model"),
      agentSoulEl: document.getElementById("agent-soul-md"),
      agentUserEl: document.getElementById("agent-user-md"),
      agentAgentsEl: document.getElementById("agent-agents-md"),
      agentSaveBtn: document.getElementById("agent-save-btn"),
      agentCancelBtn: document.getElementById("agent-cancel-btn"),
      agentImportModalEl: document.getElementById("agent-import-modal"),
      agentImportListEl: document.getElementById("agent-import-list"),
      agentImportCloseBtn: document.getElementById("agent-import-close-btn"),
      agentImportCancelBtn: document.getElementById("agent-import-cancel-btn"),
      agentImportSaveBtn: document.getElementById("agent-import-save-btn"),
    };

    function setBanner(message, tone) {
      if (!refs.bannerEl) return;
      if (!message) {
        refs.bannerEl.classList.add("hidden");
        refs.bannerEl.textContent = "";
        refs.bannerEl.style.background = "";
        refs.bannerEl.style.borderColor = "";
        refs.bannerEl.style.color = "";
        return;
      }
      refs.bannerEl.classList.remove("hidden");
      refs.bannerEl.textContent = message;
      refs.bannerEl.style.background = tone === "error" ? "rgba(127,29,29,.35)" : "rgba(8,47,73,.35)";
      refs.bannerEl.style.borderColor = tone === "error" ? "rgba(248,113,113,.4)" : "rgba(103,232,249,.35)";
      refs.bannerEl.style.color = tone === "error" ? "#FCA5A5" : "#BAE6FD";
    }

    function buildRenderContext(visibleTasks) {
      const taskSignature = visibleTasks.map((task) => [task.id, task.status, task.assigned_agent_id || "", task.updated_at || "", task.priority || ""].join(":" )).join("|");
      const agentSignature = state.agents.map((agent) => [agent.id, agent.status || "", agent.effective_status || "", agent.updated_at || ""].join(":")).join("|");
      const feedSignature = state.feedEvents.slice(0, 80).map((event) => [event.id || "", event.type || "", event.created_at || ""].join(":")).join("|");
      const contextKey = [taskSignature, agentSignature, state.agentLane, state.sideView, state.feedFilter, feedSignature].join("::");
      if (state.renderCache.contextKey === contextKey && state.renderCache.context) {
        return state.renderCache.context;
      }

      const agentNameById = new Map(state.agents.map((agent) => [String(agent.id || ""), String(agent.name || "Unknown Agent")]));
      const assignedCountByAgentId = new Map();
      const tasksByStatus = new Map(QUEUE_COLUMNS.map((column) => [column.id, []]));
      let open = 0;
      let active = 0;
      let done = 0;
      let hasPlanningDispatchError = false;

      visibleTasks.forEach((task) => {
        const assignedAgentId = String(task.assigned_agent_id || "");
        assignedCountByAgentId.set(assignedAgentId, (assignedCountByAgentId.get(assignedAgentId) || 0) + (assignedAgentId ? 1 : 0));
        if (tasksByStatus.has(task.status)) {
          tasksByStatus.get(task.status).push(task);
        }
        if (!["done", "verification"].includes(task.status)) open += 1;
        if (["assigned", "in_progress", "testing", "review"].includes(task.status)) active += 1;
        if (task.status === "done") done += 1;
        if (task.planning_dispatch_error) hasPlanningDispatchError = true;
      });

      const total = visibleTasks.length || 1;
      const summary = {
        total,
        open,
        active,
        done,
        openPct: `${Math.round((open / total) * 100)}%`,
        activePct: `${Math.round((active / total) * 100)}%`,
        donePct: `${Math.round((done / total) * 100)}%`,
      };

      const laneCounts = {
        [AGENT_LANES.all]: state.agents.length,
        [AGENT_LANES.working]: 0,
        [AGENT_LANES.standby]: 0,
      };
      const agentLaneById = new Map();
      state.agents.forEach((agent) => {
        const lane = inferAgentActivityState(agent, visibleTasks);
        agentLaneById.set(String(agent.id || ""), lane);
        laneCounts[lane] += 1;
      });

      const feedCounts = {
        all: state.feedEvents.length,
        tasks: 0,
        agents: 0,
      };
      state.feedEvents.forEach((event) => {
        const lane = feedLaneForEvent(event);
        if (lane === "tasks") feedCounts.tasks += 1;
        if (lane === "agents") feedCounts.agents += 1;
      });
      const filteredFeedEvents = state.feedFilter === "all"
        ? state.feedEvents.slice(0, 80)
        : state.feedEvents.filter((event) => feedLaneForEvent(event) === state.feedFilter).slice(0, 80);

      const context = {
        summary,
        tasksByStatus,
        assignedCountByAgentId,
        agentNameById,
        laneCounts,
        agentLaneById,
        feedCounts,
        filteredFeedEvents,
        hasPlanningDispatchError,
      };
      state.renderCache.contextKey = contextKey;
      state.renderCache.context = context;
      return context;
    }

    function assigneeName(task, context) {
      if (task.assigned_agent && task.assigned_agent.name) return task.assigned_agent.name;
      return context.agentNameById.get(String(task.assigned_agent_id || "")) || "Unassigned";
    }

    function hydrateFilters() {
      if (!refs.assigneeFilterEl || !refs.editAssigneeEl) return;
      const options = ['<option value="">All Assignees</option>']
        .concat(state.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`));
      refs.assigneeFilterEl.innerHTML = options.join("");

      const modalOptions = ['<option value="">Unassigned</option>']
        .concat(state.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`));
      refs.editAssigneeEl.innerHTML = modalOptions.join("");
      refs.assigneeFilterEl.value = state.filters.assignee;
    }

    function renderMetrics(context) {
      const summary = context.summary;
      refs.openCountEl.textContent = String(summary.open);
      refs.openPctEl.textContent = summary.openPct;
      refs.activeCountEl.textContent = String(summary.active);
      refs.activePctEl.textContent = summary.activePct;
      refs.doneCountEl.textContent = String(summary.done);
      refs.donePctEl.textContent = summary.donePct;

      const completion = Math.round((summary.done / summary.total) * 100);
      let message = "Queue is live and waiting for work.";
      let theme = { bg: "rgba(59,130,246,.18)", border: "rgba(59,130,246,.45)", text: "#93C5FD" };
      if (completion >= 90) {
        message = "Verification lane is clear.";
        theme = { bg: "rgba(16,185,129,.18)", border: "rgba(16,185,129,.45)", text: "#86EFAC" };
      } else if (summary.active > summary.done) {
        message = "Execution lanes are busy.";
        theme = { bg: "rgba(245,158,11,.18)", border: "rgba(245,158,11,.45)", text: "#FCD34D" };
      } else if (context.hasPlanningDispatchError) {
        message = "Some missions need operator attention.";
        theme = { bg: "rgba(239,68,68,.18)", border: "rgba(239,68,68,.45)", text: "#FCA5A5" };
      }
      refs.motivationEl.textContent = message;
      refs.motivationEl.style.background = theme.bg;
      refs.motivationEl.style.borderColor = theme.border;
      refs.motivationEl.style.color = theme.text;

      if (!refs.chartCanvas || typeof Chart === "undefined") return;
      const data = [summary.open || 0.001, summary.active || 0.001, summary.done || 0.001];
      if (state.chart) {
        state.chart.data.datasets[0].data = data;
        state.chart.update("none");
        return;
      }
      state.chart = new Chart(refs.chartCanvas, {
        type: "doughnut",
        data: {
          labels: ["Open", "Active", "Done"],
          datasets: [{ data, backgroundColor: ["#8B5CF6", "#F59E0B", "#10B981"], borderWidth: 0, hoverOffset: 4 }],
        },
        options: {
          responsive: false,
          cutout: "68%",
          animation: { duration: 300 },
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
        },
      });
    }

    function formatRelativeTime(value) {
      if (!value) return "Unknown";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "Unknown";
      const diffMs = Date.now() - date.getTime();
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diffMs < minute) return "just now";
      if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} min ago`;
      if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / hour))} hr ago`;
      return `${Math.max(1, Math.floor(diffMs / day))} day ago`;
    }

    function renderAgentsRail(tasks, context) {
      const realAgents = state.agents.slice();
      const laneCounts = context.laneCounts;

      const agents = realAgents
        .filter((agent) => state.agentLane === AGENT_LANES.all || context.agentLaneById.get(String(agent.id || "")) === state.agentLane)
        .sort((a, b) => {
          const aAssigned = context.assignedCountByAgentId.get(String(a.id || "")) || 0;
          const bAssigned = context.assignedCountByAgentId.get(String(b.id || "")) || 0;
          if (bAssigned !== aAssigned) return bAssigned - aAssigned;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });

      const listHtml = agents.length
        ? agents.map((agent) => {
            const assignedCount = context.assignedCountByAgentId.get(String(agent.id || "")) || 0;
            const statusMeta = getAgentStatusMeta(agent, tasks);
            const sourceMeta = getAgentSourceMeta(agent);
            const role = String(agent.role || agent.specialty || agent.description || "Mission specialist").slice(0, 44);
            return `
              <article class="mission-agent-card rounded-xl border border-white/10 bg-[#11172a]/80 p-2.5">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-100">${escapeHtml(agent.name || "Unknown Agent")}</p>
                    <p class="truncate text-xs text-slate-400">${escapeHtml(role)}</p>
                  </div>
                  <span class="rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${statusMeta.tone}">${escapeHtml(statusMeta.chip)}</span>
                </div>
                <div class="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                  <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full ${statusMeta.dot}"></span>${escapeHtml(statusMeta.label)}</span>
                  <span>${assignedCount} task${assignedCount === 1 ? "" : "s"}</span>
                </div>
                <div class="mt-2 rounded-lg border px-2 py-1 text-center text-xs font-semibold ${sourceMeta.tone}">${escapeHtml(sourceMeta.label)}</div>
                <p class="mt-1 truncate text-[10px] uppercase tracking-[0.14em] text-slate-500">${escapeHtml(sourceMeta.detail)}</p>
              </article>
            `;
          }).join("")
        : '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No agents in this lane</div>';

      const feedCounts = context.feedCounts;
      const feedEvents = context.filteredFeedEvents;
      const feedHtml = feedEvents.length
        ? feedEvents.map((event) => {
            const icon = feedLaneForEvent(event) === "agents" ? "🤖" : feedLaneForEvent(event) === "tasks" ? "📌" : "🔔";
            return `
              <article class="rounded-xl border border-white/10 bg-[#11172a]/80 px-2.5 py-2">
                <p class="text-sm leading-snug text-slate-100">${icon} ${escapeHtml(event.message || event.type || "Mission event")}</p>
                <p class="mt-1 text-xs text-slate-400">◷ ${escapeHtml(formatRelativeTime(event.created_at))}</p>
              </article>
            `;
          }).join("")
        : '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No live feed events</div>';

      const agentsViewHtml = `
        <div class="mb-3 grid grid-cols-3 gap-1.5 rounded-xl border border-white/10 bg-slate-900/45 p-1">
          <button class="mission-agent-filter-btn ${state.agentLane === AGENT_LANES.all ? "active" : ""}" data-lane="all">ALL <span>${laneCounts[AGENT_LANES.all]}</span></button>
          <button class="mission-agent-filter-btn ${state.agentLane === AGENT_LANES.working ? "active" : ""}" data-lane="working">WORKING <span>${laneCounts[AGENT_LANES.working]}</span></button>
          <button class="mission-agent-filter-btn ${state.agentLane === AGENT_LANES.standby ? "active" : ""}" data-lane="standby">STANDBY <span>${laneCounts[AGENT_LANES.standby]}</span></button>
        </div>
        <div class="mission-agents-list flex-1 space-y-2 overflow-y-auto pr-1">${listHtml}</div>
        <div class="mt-3 grid grid-cols-1 gap-2">
          <button id="mission-add-agent-btn" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-300">+ Add Local Agent</button>
          <button id="mission-import-agent-btn" class="rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-200">Import Gateway Agent</button>
          <p class="text-[10px] uppercase tracking-[0.14em] text-slate-500">Local agents live only in Mission Control. Gateway imports stay linked to a real OpenClaw agent id.</p>
        </div>
      `;

      const feedViewHtml = `
        <div class="mb-3 grid grid-cols-3 gap-1.5 rounded-xl border border-white/10 bg-slate-900/45 p-1">
          <button class="mission-feed-filter-btn ${state.feedFilter === "all" ? "active" : ""}" data-feed="all">ALL <span>${feedCounts.all}</span></button>
          <button class="mission-feed-filter-btn ${state.feedFilter === "tasks" ? "active" : ""}" data-feed="tasks">TASKS <span>${feedCounts.tasks}</span></button>
          <button class="mission-feed-filter-btn ${state.feedFilter === "agents" ? "active" : ""}" data-feed="agents">AGENTS <span>${feedCounts.agents}</span></button>
        </div>
        <div class="mission-agents-list flex-1 space-y-2 overflow-y-auto pr-1">${feedHtml}</div>
      `;

      return `
        <aside class="mission-agents-rail flex min-h-[560px] flex-col rounded-2xl border border-white/12 bg-[#0f172acc]/90 p-3">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div>
              <p class="text-xs font-bold uppercase tracking-[0.15em] text-slate-300">${state.sideView === "agents" ? "Agents" : "Live Feed"}</p>
              <p class="text-[11px] text-slate-400">${state.sideView === "agents" ? `${laneCounts[AGENT_LANES.all]} total` : `${feedCounts.all} events`}</p>
            </div>
          </div>
          <div class="mb-3 grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-slate-900/45 p-1">
            <button class="mission-side-tab-btn ${state.sideView === "agents" ? "active" : ""}" data-side="agents">AGENTS</button>
            <button class="mission-side-tab-btn ${state.sideView === "feed" ? "active" : ""}" data-side="feed">LIVE FEED</button>
          </div>
          ${state.sideView === "agents" ? agentsViewHtml : feedViewHtml}
        </aside>
      `;
    }

    function renderBoard() {
      const visibleTasks = filterTasks(state.tasks, state.filters);
      const context = buildRenderContext(visibleTasks);
      refs.boardEl.style.gridTemplateColumns = `${QUEUE_COLUMNS.map(() => "minmax(250px, 1fr)").join(" ")}`;
      const boardHtml = QUEUE_COLUMNS.map((column) => {
        const tasks = context.tasksByStatus.get(column.id) || [];
        return `
          <section class="kanban-column flex min-h-[560px] flex-col rounded-2xl border p-3" data-status="${column.id}" style="background:${column.tone};border-color:${column.border};">
            <div class="mb-3 flex items-center justify-between gap-2">
              <div>
                <p class="text-sm font-bold text-white">${column.label}</p>
                <p class="text-[11px] text-slate-400">${tasks.length} mission${tasks.length === 1 ? "" : "s"}</p>
              </div>
              <span class="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style="border-color:${column.border};color:${column.chip};">${tasks.length}</span>
            </div>
            <div class="kanban-card-list flex-1 space-y-3">
              ${tasks.length ? tasks.map((task) => renderCard(task, context)).join("") : '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No missions</div>'}
            </div>
          </section>
        `;
      }).join("");
      const agentsHtml = renderAgentsRail(visibleTasks, context);
      if (state.renderCache.boardHtml !== boardHtml) {
        refs.boardEl.innerHTML = boardHtml;
        state.renderCache.boardHtml = boardHtml;
      }
      if (state.renderCache.agentsHtml !== agentsHtml) {
        refs.agentsRailEl.innerHTML = agentsHtml;
        state.renderCache.agentsHtml = agentsHtml;
      }

      refs.boardEl.querySelectorAll("[data-task-id]").forEach((card) => {
        card.addEventListener("dragstart", onDragStart);
        card.addEventListener("dragend", onDragEnd);
      });
      refs.boardEl.querySelectorAll(".kanban-column").forEach((column) => {
        column.addEventListener("dragover", onDragOver);
        column.addEventListener("dragleave", onDragLeave);
        column.addEventListener("drop", onDrop);
      });
      refs.boardEl.querySelectorAll("[data-action='edit']").forEach((button) => {
        button.addEventListener("click", () => openModal(button.getAttribute("data-task-id")));
      });
      refs.boardEl.querySelectorAll("[data-action='delete']").forEach((button) => {
        button.addEventListener("click", () => deleteTask(button.getAttribute("data-task-id")));
      });
      refs.agentsRailEl.querySelectorAll(".mission-side-tab-btn").forEach((button) => {
        button.addEventListener("click", () => {
          state.sideView = String(button.getAttribute("data-side") || "agents");
          renderBoard();
        });
      });
      refs.agentsRailEl.querySelectorAll(".mission-agent-filter-btn").forEach((button) => {
        button.addEventListener("click", () => {
          state.agentLane = String(button.getAttribute("data-lane") || AGENT_LANES.all);
          renderBoard();
        });
      });
      refs.agentsRailEl.querySelectorAll(".mission-feed-filter-btn").forEach((button) => {
        button.addEventListener("click", () => {
          state.feedFilter = String(button.getAttribute("data-feed") || "all");
          renderBoard();
        });
      });
      const addAgentBtn = refs.agentsRailEl.querySelector("#mission-add-agent-btn");
      if (addAgentBtn) {
        addAgentBtn.addEventListener("click", openAgentModal);
      }
      const importAgentBtn = refs.agentsRailEl.querySelector("#mission-import-agent-btn");
      if (importAgentBtn) {
        importAgentBtn.addEventListener("click", openImportModal);
      }

      renderMetrics(context);
    }

    function renderCard(task, context) {
      const priority = PRIORITY_THEME[String(task.priority || "normal")] || PRIORITY_THEME.normal;
      const type = TYPE_THEME[String(task.task_type || "general")] || TYPE_THEME.general;
      const due = formatDate(task.due_date);
      const dispatchError = task.planning_dispatch_error ? `<p class="mt-2 rounded-lg border border-rose-400/25 bg-rose-950/35 px-2 py-1 text-[11px] text-rose-200">${escapeHtml(task.planning_dispatch_error)}</p>` : "";
      const description = task.description ? `<p class="mt-2 text-xs leading-relaxed text-slate-300">${escapeHtml(task.description).slice(0, 220)}</p>` : "";
      return `
        <article class="kanban-card rounded-2xl border border-white/10 bg-slate-950/55 p-3 shadow-[0_14px_28px_rgba(15,23,42,.25)] transition hover:border-white/20" draggable="true" data-task-id="${escapeHtml(task.id)}">
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-bold leading-snug text-white">${escapeHtml(task.title || "Untitled mission")}</h3>
            <span class="rounded-full border px-2 py-0.5 text-[10px] font-semibold" style="background:${priority.bg};border-color:${priority.border};color:${priority.text};">${priority.label}</span>
          </div>
          ${description}
          <div class="mt-3 flex flex-wrap gap-1.5">
            <span class="rounded-full border px-2 py-0.5 text-[10px] font-semibold" style="background:${type.color}22;border-color:${type.color}66;color:${type.color};">${type.label}</span>
            <span class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${escapeHtml(assigneeName(task, context))}</span>
            ${due ? `<span class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-300">Due ${escapeHtml(due)}</span>` : ""}
          </div>
          ${dispatchError}
          <div class="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>${escapeHtml((task.status_reason || "").slice(0, 64) || "No operator note")}</span>
            <div class="flex items-center gap-2">
              <button class="rounded-lg border border-white/10 px-2 py-1 text-slate-200 transition hover:bg-white/5" data-action="edit" data-task-id="${escapeHtml(task.id)}">Edit</button>
              <button class="rounded-lg border border-rose-400/20 px-2 py-1 text-rose-200 transition hover:bg-rose-500/10" data-action="delete" data-task-id="${escapeHtml(task.id)}">Delete</button>
            </div>
          </div>
        </article>
      `;
    }

    function currentTask(id) {
      return state.tasks.find((task) => String(task.id) === String(id)) || null;
    }

    function openModal(taskId) {
      const task = taskId ? currentTask(taskId) : null;
      state.editingTaskId = task ? task.id : null;
      refs.modalTitleEl.textContent = task ? "Edit Mission" : "New Mission";
      refs.editTitleEl.value = task ? task.title || "" : "";
      refs.editDescriptionEl.value = task ? task.description || "" : "";
      refs.editPriorityEl.value = task ? task.priority || "normal" : "normal";
      refs.editStatusEl.value = task ? task.status || "inbox" : "inbox";
      refs.editTaskTypeEl.value = task ? task.task_type || "general" : "general";
      refs.editAssigneeEl.value = task ? task.assigned_agent_id || "" : "";
      refs.editDueEl.value = task && task.due_date ? String(task.due_date).slice(0, 10) : "";
      refs.modalEl.classList.remove("hidden");
      refs.modalEl.classList.add("flex");
      refs.editTitleEl.focus();
    }

    function closeModal() {
      state.editingTaskId = null;
      refs.modalEl.classList.add("hidden");
      refs.modalEl.classList.remove("flex");
    }

    function setAgentModalTab(tab) {
      refs.agentModalTabs.forEach((button) => {
        const isActive = button.getAttribute("data-agent-tab") === tab;
        button.classList.toggle("active", isActive);
      });
      ["info", "soul", "user", "agents"].forEach((name) => {
        const panelEl = document.getElementById(`agent-modal-panel-${name}`);
        if (!panelEl) return;
        panelEl.classList.toggle("hidden", name !== tab);
      });
    }

    function openAgentModal() {
      if (!refs.agentModalEl) return;
      refs.agentNameEl.value = "";
      refs.agentRoleEl.value = "";
      refs.agentDescriptionEl.value = "";
      refs.agentEmojiEl.value = "🤖";
      refs.agentStatusEl.value = "standby";
      refs.agentModelEl.value = "";
      refs.agentSoulEl.value = "";
      refs.agentUserEl.value = "";
      refs.agentAgentsEl.value = "";
      setAgentModalTab("info");
      refs.agentModalEl.classList.remove("hidden");
      refs.agentModalEl.classList.add("flex");
      refs.agentNameEl.focus();
    }

    function closeAgentModal() {
      if (!refs.agentModalEl) return;
      refs.agentModalEl.classList.add("hidden");
      refs.agentModalEl.classList.remove("flex");
    }

    async function saveAgent() {
      const payload = buildAgentPayloadFromForm({
        name: refs.agentNameEl.value,
        role: refs.agentRoleEl.value,
        description: refs.agentDescriptionEl.value,
        avatar_emoji: refs.agentEmojiEl.value,
        status: refs.agentStatusEl.value,
        model: refs.agentModelEl.value,
        soul_md: refs.agentSoulEl.value,
        user_md: refs.agentUserEl.value,
        agents_md: refs.agentAgentsEl.value,
        workspace_id: state.workspaceId,
      });
      if (!payload.name || !payload.role) {
        setBanner("Agent name and role are required.", "error");
        return;
      }
      try {
        const created = await requestJson("/api/mission-control/api/agents", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        state.agents = [created].concat(state.agents.filter((agent) => agent.id !== created.id));
        closeAgentModal();
        renderBoard();
        setBanner(`Created agent \"${created.name}\".`, "info");
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Agent create failed.", "error");
      }
    }

    function renderImportCandidates() {
      if (!refs.agentImportListEl) return;
      if (!state.gatewayCandidates.length) {
        refs.agentImportListEl.innerHTML = '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No gateway agents found</div>';
        return;
      }
      refs.agentImportListEl.innerHTML = state.gatewayCandidates.map((item) => {
        const id = String(item.id || "");
        const selected = state.gatewaySelection.has(id);
        const imported = Boolean(item.already_imported);
        return `
          <label class="mb-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 ${imported ? "border-emerald-400/25 bg-emerald-500/10" : "border-white/10 bg-slate-900/45"}">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold ${imported ? "text-emerald-200" : "text-slate-100"}">${escapeHtml(String(item.name || id))}</p>
              <p class="truncate text-xs text-slate-400">${escapeHtml(id)}</p>
            </div>
            ${imported
              ? '<span class="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-200">Imported</span>'
              : `<input type="checkbox" class="h-4 w-4" data-import-id="${escapeHtml(id)}" ${selected ? "checked" : ""} />`}
          </label>
        `;
      }).join("");

      refs.agentImportListEl.querySelectorAll("[data-import-id]").forEach((checkbox) => {
        checkbox.addEventListener("change", function () {
          const importId = String(checkbox.getAttribute("data-import-id") || "");
          if (!importId) return;
          if (checkbox.checked) state.gatewaySelection.add(importId);
          else state.gatewaySelection.delete(importId);
        });
      });
    }

    async function openImportModal() {
      if (!refs.agentImportModalEl) return;
      state.gatewaySelection = new Set();
      refs.agentImportModalEl.classList.remove("hidden");
      refs.agentImportModalEl.classList.add("flex");
      refs.agentImportListEl.innerHTML = '<div class="rounded-xl border border-white/10 bg-slate-900/45 px-3 py-6 text-center text-xs text-slate-300">Loading gateway agents…</div>';
      try {
        const payload = await requestJson("/api/mission-control/api/agents/discover");
        state.gatewayCandidates = Array.isArray(payload && payload.agents) ? payload.agents : [];
      } catch (_error) {
        state.gatewayCandidates = [];
        setBanner("Unable to load gateway agents.", "error");
      }
      renderImportCandidates();
    }

    function closeImportModal() {
      if (!refs.agentImportModalEl) return;
      refs.agentImportModalEl.classList.add("hidden");
      refs.agentImportModalEl.classList.remove("flex");
    }

    async function saveImportedAgents() {
      const payload = buildGatewayImportPayload(state.gatewayCandidates, state.gatewaySelection, state.workspaceId);
      if (!payload.agents.length) {
        setBanner("Select at least one gateway agent to import.", "error");
        return;
      }
      try {
        const result = await requestJson("/api/mission-control/api/agents/import", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        closeImportModal();
        await loadTasks();
        const imported = Array.isArray(result && result.imported) ? result.imported.length : payload.agents.length;
        const skipped = Array.isArray(result && result.skipped) ? result.skipped.length : 0;
        setBanner(`Imported ${imported} agent${imported === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}.`, "info");
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Gateway import failed.", "error");
      }
    }

    async function saveTask() {
      const payload = buildPayloadFromForm({
        title: refs.editTitleEl.value,
        description: refs.editDescriptionEl.value,
        priority: refs.editPriorityEl.value,
        status: refs.editStatusEl.value,
        task_type: refs.editTaskTypeEl.value,
        assigned_agent_id: refs.editAssigneeEl.value,
        due_date: refs.editDueEl.value,
        workspace_id: state.workspaceId,
      });
      if (!payload.title) {
        setBanner("Mission title is required.", "error");
        refs.editTitleEl.focus();
        return;
      }

      try {
        if (state.editingTaskId) {
          const updated = await requestJson(`/api/mission-control/api/tasks/${encodeURIComponent(state.editingTaskId)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
          state.tasks = state.tasks.map((task) => (task.id === updated.id ? updated : task));
          setBanner(`Updated "${updated.title}".`, "info");
        } else {
          const created = await requestJson("/api/mission-control/api/tasks", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          state.tasks = [created].concat(state.tasks.filter((task) => task.id !== created.id));
          setBanner(`Created "${created.title}".`, "info");
        }
        closeModal();
        renderBoard();
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Mission save failed.", "error");
      }
    }

    async function deleteTask(taskId) {
      const task = currentTask(taskId);
      if (!task || !window.confirm(`Delete "${task.title}"?`)) return;
      try {
        await requestJson(`/api/mission-control/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
        state.tasks = state.tasks.filter((item) => item.id !== taskId);
        renderBoard();
        setBanner(`Deleted "${task.title}".`, "info");
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Mission delete failed.", "error");
      }
    }

    async function updateTaskStatus(taskId, nextStatus) {
      const task = currentTask(taskId);
      if (!task || task.status === nextStatus) return;
      const previousStatus = task.status;
      task.status = nextStatus;
      renderBoard();
      try {
        const updated = await requestJson(`/api/mission-control/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        });
        state.tasks = state.tasks.map((item) => (item.id === updated.id ? updated : item));
        renderBoard();
      } catch (error) {
        task.status = previousStatus;
        renderBoard();
        setBanner(error instanceof Error ? error.message : `Transition to ${nextStatus} failed.`, "error");
      }
    }

    function onDragStart(event) {
      state.dragTaskId = event.currentTarget.getAttribute("data-task-id");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.dragTaskId);
      event.currentTarget.classList.add("dragging");
    }

    function onDragEnd(event) {
      event.currentTarget.classList.remove("dragging");
      refs.boardEl.querySelectorAll(".kanban-column").forEach((column) => column.classList.remove("drag-over"));
      state.dragTaskId = null;
    }

    function onDragOver(event) {
      event.preventDefault();
      event.currentTarget.classList.add("drag-over");
    }

    function onDragLeave(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove("drag-over");
      }
    }

    function onDrop(event) {
      event.preventDefault();
      const status = event.currentTarget.getAttribute("data-status");
      event.currentTarget.classList.remove("drag-over");
      if (!state.dragTaskId || !status) return;
      updateTaskStatus(state.dragTaskId, status);
    }

    async function loadTasks() {
      if (state.loading) return;
      state.loading = true;
      try {
        const [tasks, agents, events] = await Promise.all([
          requestJson(`/api/mission-control/api/tasks?workspace_id=${encodeURIComponent(state.workspaceId)}`),
          requestJson(`/api/mission-control/api/agents?workspace_id=${encodeURIComponent(state.workspaceId)}`),
          requestJson(`/api/mission-control/api/events?workspace_id=${encodeURIComponent(state.workspaceId)}`).catch(() => []),
        ]);
        state.tasks = Array.isArray(tasks) ? tasks : [];
        state.agents = Array.isArray(agents) ? agents : [];
        state.feedEvents = Array.isArray(events) ? events : [];
        hydrateFilters();
        renderBoard();
        setBanner("", "");
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Mission Queue load failed.", "error");
      } finally {
        state.loading = false;
      }
    }

    const debouncedReload = debounce(loadTasks, 250);
    const debouncedRenderBoard = debounce(renderBoard, 80);

    function connectSSE() {
      if (typeof EventSource === "undefined") return;
      if (state.sse) state.sse.close();
      state.sse = new EventSource(`/api/mission-control/api/events/stream?workspace_id=${encodeURIComponent(state.workspaceId)}`);
      state.sse.onmessage = function (event) {
        if (!event.data) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload && /^(task_|agent_)/.test(String(payload.type || ""))) {
            debouncedReload();
          }
        } catch (_error) {
          debouncedReload();
        }
      };
      state.sse.onerror = function () {
        if (state.sse) state.sse.close();
        state.sse = null;
        window.setTimeout(connectSSE, 5000);
      };
    }

    function ensureStarted() {
      if (state.started) return;
      state.started = true;
      loadTasks();
      connectSSE();
      window.setInterval(loadTasks, 30000);
    }

    refs.refreshBtn.addEventListener("click", loadTasks);
    refs.newBtn.addEventListener("click", function () { openModal(null); });
    refs.cancelBtn.addEventListener("click", closeModal);
    refs.modalEl.addEventListener("click", function (event) {
      if (event.target === refs.modalEl) closeModal();
    });
    refs.saveBtn.addEventListener("click", saveTask);
    if (refs.agentModalEl) {
      refs.agentModalEl.addEventListener("click", function (event) {
        if (event.target === refs.agentModalEl) closeAgentModal();
      });
    }
    if (refs.agentModalCloseBtn) refs.agentModalCloseBtn.addEventListener("click", closeAgentModal);
    if (refs.agentCancelBtn) refs.agentCancelBtn.addEventListener("click", closeAgentModal);
    if (refs.agentSaveBtn) refs.agentSaveBtn.addEventListener("click", saveAgent);
    refs.agentModalTabs.forEach((button) => {
      button.addEventListener("click", function () {
        setAgentModalTab(String(button.getAttribute("data-agent-tab") || "info"));
      });
    });
    if (refs.agentImportModalEl) {
      refs.agentImportModalEl.addEventListener("click", function (event) {
        if (event.target === refs.agentImportModalEl) closeImportModal();
      });
    }
    if (refs.agentImportCloseBtn) refs.agentImportCloseBtn.addEventListener("click", closeImportModal);
    if (refs.agentImportCancelBtn) refs.agentImportCancelBtn.addEventListener("click", closeImportModal);
    if (refs.agentImportSaveBtn) refs.agentImportSaveBtn.addEventListener("click", saveImportedAgents);

    [
      [refs.assigneeFilterEl, "assignee"],
      [refs.priorityFilterEl, "priority"],
      [refs.statusFilterEl, "status"],
      [refs.typeFilterEl, "type"],
    ].forEach(function ([element, key]) {
      element.addEventListener("change", function () {
        state.filters[key] = element.value;
        debouncedRenderBoard();
      });
    });

    document.querySelectorAll(".tab-btn").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.getAttribute("data-tab") === "tasks") {
          window.setTimeout(ensureStarted, 60);
        }
      });
    });

    if (panel.classList.contains("active")) ensureStarted();
  }

  return {
    QUEUE_COLUMNS,
    PRIORITY_THEME,
    summarizeBoard,
    filterTasks,
    inferAgentActivityState,
    getAgentStatusMeta,
    getAgentSourceMeta,
    filterAgentsByLane,
    filterFeedEvents,
    buildPayloadFromForm,
    buildAgentPayloadFromForm,
    buildGatewayImportPayload,
    init,
  };
});
