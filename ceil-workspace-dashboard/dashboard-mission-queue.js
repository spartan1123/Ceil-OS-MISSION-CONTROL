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
    if (!panel || !boardEl) return;

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

    function renderBoard() {
      const visibleTasks = filterTasks(state.tasks, state.filters);
      refs.boardEl.innerHTML = QUEUE_COLUMNS.map((column) => {
        const tasks = visibleTasks.filter((task) => task.status === column.id);
        return `
          <section class="kanban-column flex min-h-[420px] flex-col rounded-2xl border p-3" data-status="${column.id}" style="background:${column.tone};border-color:${column.border};">
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
        const [tasks, agents] = await Promise.all([
          requestJson(`/api/mission-control/api/tasks?workspace_id=${encodeURIComponent(state.workspaceId)}`),
          requestJson(`/api/mission-control/api/agents?workspace_id=${encodeURIComponent(state.workspaceId)}`),
        ]);
        state.tasks = Array.isArray(tasks) ? tasks : [];
        state.agents = Array.isArray(agents) ? agents : [];
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
          if (payload && /^task_/.test(String(payload.type || ""))) {
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
    buildPayloadFromForm,
    init,
  };
});
