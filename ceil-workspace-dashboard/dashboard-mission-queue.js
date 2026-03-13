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

  function filterTasks(tasks, filters) {
    return tasks.filter((task) => {
      if (filters.assignee && String(task.assigned_agent_id || "") !== filters.assignee) return false;
      if (filters.priority && String(task.priority || "") !== filters.priority) return false;
      if (filters.status && String(task.status || "") !== filters.status) return false;
      if (filters.type && String(task.task_type || "general") !== filters.type) return false;
      return true;
    });
  }

  function inferAgentActivityState(agent, tasks) {
    const status = String(agent && agent.status ? agent.status : "").toLowerCase();
    const assignedCount = tasks.filter((task) => String(task.assigned_agent_id || "") === String(agent && agent.id ? agent.id : "")).length;
    if (["working", "active", "busy", "running"].includes(status) || assignedCount > 0) {
      return AGENT_LANES.working;
    }
    return AGENT_LANES.standby;
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
      dragTaskId: null,
      editingTaskId: null,
      chart: null,
      sse: null,
      started: false,
      loading: false,
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

    function assigneeName(task) {
      if (task.assigned_agent && task.assigned_agent.name) return task.assigned_agent.name;
      const match = state.agents.find((agent) => agent.id === task.assigned_agent_id);
      return match ? match.name : "Unassigned";
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

    function renderMetrics(tasks) {
      const summary = summarizeBoard(tasks);
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
      } else if (tasks.some((task) => task.planning_dispatch_error)) {
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

    function renderAgentsRail(tasks) {
      const laneCounts = {
        [AGENT_LANES.all]: state.agents.length,
        [AGENT_LANES.working]: filterAgentsByLane(state.agents, AGENT_LANES.working, tasks).length,
        [AGENT_LANES.standby]: filterAgentsByLane(state.agents, AGENT_LANES.standby, tasks).length,
      };

      const agents = filterAgentsByLane(state.agents, state.agentLane, tasks)
        .sort((a, b) => {
          const aAssigned = tasks.filter((task) => String(task.assigned_agent_id || "") === String(a.id)).length;
          const bAssigned = tasks.filter((task) => String(task.assigned_agent_id || "") === String(b.id)).length;
          if (bAssigned !== aAssigned) return bAssigned - aAssigned;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });

      const listHtml = agents.length
        ? agents.map((agent) => {
            const lane = inferAgentActivityState(agent, tasks);
            const assignedCount = tasks.filter((task) => String(task.assigned_agent_id || "") === String(agent.id)).length;
            const statusLabel = lane === AGENT_LANES.working ? "WORKING" : "STANDBY";
            const statusTone = lane === AGENT_LANES.working
              ? "border-cyan-300/40 bg-cyan-500/15 text-cyan-200"
              : "border-slate-400/30 bg-slate-500/10 text-slate-300";
            const role = String(agent.role || agent.specialty || agent.description || "Mission specialist").slice(0, 44);
            const healthText = agent.openclaw_enabled ? "OpenClaw Connected" : "Gateway Pending";
            return `
              <article class="mission-agent-card rounded-xl border border-white/10 bg-[#11172a]/80 p-2.5">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-100">${escapeHtml(agent.name || "Unknown Agent")}</p>
                    <p class="truncate text-xs text-slate-400">${escapeHtml(role)}</p>
                  </div>
                  <span class="rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${statusTone}">${statusLabel}</span>
                </div>
                <div class="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                  <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full ${lane === AGENT_LANES.working ? "bg-emerald-400" : "bg-slate-500"}"></span>${lane === AGENT_LANES.working ? "Active" : "Idle"}</span>
                  <span>${assignedCount} task${assignedCount === 1 ? "" : "s"}</span>
                </div>
                <div class="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-center text-xs font-semibold text-emerald-200">${escapeHtml(healthText)}</div>
              </article>
            `;
          }).join("")
        : '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No agents in this lane</div>';

      const feedCounts = {
        all: state.feedEvents.length,
        tasks: filterFeedEvents(state.feedEvents, "tasks").length,
        agents: filterFeedEvents(state.feedEvents, "agents").length,
      };
      const feedEvents = filterFeedEvents(state.feedEvents, state.feedFilter).slice(0, 80);
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
          <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-300">+ Add Agent</button>
          <button class="rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-200">Import from Gateway</button>
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
      refs.boardEl.style.gridTemplateColumns = `${QUEUE_COLUMNS.map(() => "minmax(250px, 1fr)").join(" ")}`;
      refs.boardEl.innerHTML = QUEUE_COLUMNS.map((column) => {
        const tasks = visibleTasks.filter((task) => task.status === column.id);
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
              ${tasks.length ? tasks.map((task) => renderCard(task)).join("") : '<div class="rounded-xl border border-dashed border-white/12 bg-slate-950/30 px-3 py-6 text-center text-xs text-slate-500">No missions</div>'}
            </div>
          </section>
        `;
      }).join("");
      refs.agentsRailEl.innerHTML = renderAgentsRail(visibleTasks);

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

      renderMetrics(visibleTasks);
    }

    function renderCard(task) {
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
            <span class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${escapeHtml(assigneeName(task))}</span>
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

    [
      [refs.assigneeFilterEl, "assignee"],
      [refs.priorityFilterEl, "priority"],
      [refs.statusFilterEl, "status"],
      [refs.typeFilterEl, "type"],
    ].forEach(function ([element, key]) {
      element.addEventListener("change", function () {
        state.filters[key] = element.value;
        renderBoard();
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
    filterAgentsByLane,
    filterFeedEvents,
    buildPayloadFromForm,
    init,
  };
});
