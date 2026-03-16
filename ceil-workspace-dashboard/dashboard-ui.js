(function () {
      "use strict";

      // ── Helpers ────────────────────────────────────────────────────────────
      function startOfDayISO(offsetDays) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + (offsetDays || 0));
        return d.toISOString();
      }

      function startOfWeekISO() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        const day = d.getDay();
        d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
        return d.toISOString();
      }

      function escDash(v) {
        return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
      }

      function timeAgo(iso) {
        const diff = Date.now() - new Date(iso).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1)  return "just now";
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h/24)}d ago`;
      }

      const AGENT_COLORS_DASH = {
        "workspace manager":     "#4F46E5",
        "senku ishigami":        "#EC4899",
        "senku-ishigami":        "#EC4899",
        "workspace orchestrator":"#6366F1",
        "provisioning architect":"#06B6D4",
        "security & compliance": "#EF4444",
        "reliability / sre":     "#10B981",
        "cost & model governor": "#F59E0B",
        "quality auditor":       "#7C3AED",
        "os monitor":            "#14B8A6",
      };

      function agentColor(name) {
        const key = String(name || "").toLowerCase().trim();
        return AGENT_COLORS_DASH[key] || "#64748B";
      }

      // ── DOM refs ───────────────────────────────────────────────────────────
      const dsOpenTasks       = document.getElementById("ds-open-tasks");
      const dsOpenTasksSub    = document.getElementById("ds-open-tasks-sub");
      const dsDoneToday       = document.getElementById("ds-done-today");
      const dsDoneTodayDelta  = document.getElementById("ds-done-today-delta");
      const dsAgentsActive    = document.getElementById("ds-agents-active");
      const dsSuccessRate     = document.getElementById("ds-success-rate");
      const pulseTodayBadge   = document.getElementById("pulse-today-badge");
      const pulseDeltaBadge   = document.getElementById("pulse-delta-badge");
      const riskList          = document.getElementById("risk-banner-list");
      const riskAllClear      = document.getElementById("risk-all-clear");
      const snapTodo          = document.getElementById("snap-todo");
      const snapDoing         = document.getElementById("snap-doing");
      const snapDone          = document.getElementById("snap-done");
      const snapPct           = document.getElementById("snap-pct");
      const snapBar           = document.getElementById("snap-progress-bar");
      const agentRingEl       = document.getElementById("agent-activity-ring");
      const completionsList   = document.getElementById("recent-completions-list");
      const snapshotCard      = document.getElementById("dash-snapshot-card");

      // Clicking snapshot card navigates to Tasks tab
      if (snapshotCard) {
        snapshotCard.addEventListener("click", () => {
          const tasksBtn = document.querySelector(".tab-btn[data-tab='tasks']");
          if (tasksBtn) tasksBtn.click();
        });
      }

      // ── Chart instance ─────────────────────────────────────────────────────
      let pulseChart = null;

      function buildPulseChart(labels, data) {
        const canvas = document.getElementById("execution-pulse-chart");
        if (!canvas) return;

        const gradient = canvas.getContext("2d").createLinearGradient(0, 0, 0, 180);
        gradient.addColorStop(0, "rgba(124,58,237,0.35)");
        gradient.addColorStop(1, "rgba(124,58,237,0.00)");

        if (pulseChart) {
          pulseChart.data.labels = labels;
          pulseChart.data.datasets[0].data = data;
          pulseChart.update();
          return;
        }

        pulseChart = new Chart(canvas, {
          type: "line",
          data: {
            labels,
            datasets: [{
              label: "Completed",
              data,
              fill: true,
              backgroundColor: gradient,
              borderColor: "#7C3AED",
              borderWidth: 2.5,
              pointBackgroundColor: "#A78BFA",
              pointRadius: 4,
              pointHoverRadius: 6,
              tension: 0.42,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: "#1e293b",
                borderColor: "rgba(124,58,237,.4)",
                borderWidth: 1,
                titleColor: "#e2e8f0",
                bodyColor: "#94a3b8",
                callbacks: { label: ctx => ` ${ctx.parsed.y} completed` },
              }
            },
            scales: {
              x: {
                grid: { color: "rgba(255,255,255,.05)" },
                ticks: { color: "#64748b", font: { size: 11 } },
              },
              y: {
                beginAtZero: true,
                grid: { color: "rgba(255,255,255,.05)" },
                ticks: { color: "#64748b", font: { size: 11 }, stepSize: 1 },
              }
            }
          }
        });
      }

      // ── Render helpers ─────────────────────────────────────────────────────
      function renderQuickStats({ openTasks, doneToday, doneYesterday, agentsActive, successRate }) {
        if (dsOpenTasks) dsOpenTasks.textContent = openTasks;
        if (dsOpenTasksSub) dsOpenTasksSub.textContent = "todo + doing";
        if (dsDoneToday) dsDoneToday.textContent = doneToday;
        if (dsDoneTodayDelta) {
          const diff = doneToday - doneYesterday;
          const sign = diff > 0 ? "+" : "";
          dsDoneTodayDelta.textContent = `${sign}${diff} vs yesterday`;
          dsDoneTodayDelta.style.color = diff > 0 ? "#6EE7B7" : diff < 0 ? "#FCA5A5" : "#94a3b8";
        }
        if (dsAgentsActive) dsAgentsActive.textContent = agentsActive;
        if (dsSuccessRate) dsSuccessRate.textContent = successRate;
      }

      function renderPulse({ labels, counts, todayCount, deltaCount }) {
        buildPulseChart(labels, counts);

        if (pulseTodayBadge) {
          pulseTodayBadge.textContent = `${todayCount} today`;
          pulseTodayBadge.style.cssText = "background:rgba(124,58,237,.18);border-color:rgba(124,58,237,.5);color:#C4B5FD;";
        }
        if (pulseDeltaBadge) {
          const sign = deltaCount >= 0 ? "+" : "";
          pulseDeltaBadge.textContent = `${sign}${deltaCount} vs yesterday`;
          const isPos = deltaCount > 0;
          const isNeg = deltaCount < 0;
          pulseDeltaBadge.style.cssText = isPos
            ? "background:rgba(16,185,129,.18);border-color:rgba(16,185,129,.5);color:#6EE7B7;"
            : isNeg
              ? "background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.5);color:#FCA5A5;"
              : "background:rgba(100,116,139,.18);border-color:rgba(100,116,139,.5);color:#CBD5E1;";
        }
      }

      function renderRiskBanner({ atRiskCount, doingCount, doingThreshold }) {
        if (!riskList || !riskAllClear) return;

        const items = [];

        if (atRiskCount > 0) {
          items.push({
            color: "#EF4444",
            bg: "rgba(239,68,68,.12)",
            border: "rgba(239,68,68,.4)",
            icon: "🔴",
            text: `${atRiskCount} task${atRiskCount > 1 ? "s" : ""} marked <strong>At Risk</strong>`,
          });
        }

        if (doingCount >= doingThreshold) {
          items.push({
            color: "#F59E0B",
            bg: "rgba(245,158,11,.12)",
            border: "rgba(245,158,11,.4)",
            icon: "🟡",
            text: `${doingCount} tasks stuck in <strong>Doing</strong> — possible bottleneck`,
          });
        }

        if (items.length === 0) {
          riskList.innerHTML = "";
          riskAllClear.classList.remove("hidden");
        } else {
          riskAllClear.classList.add("hidden");
          riskList.innerHTML = items.map(item => `
            <div class="rounded-xl border px-3 py-2.5 text-xs" style="background:${item.bg};border-color:${item.border};color:${item.color};">
              ${item.icon} ${item.text}
            </div>`).join("");
        }
      }

      function renderSnapshot({ todo, doing, done }) {
        const total = todo + doing + done || 1;
        const pct   = Math.round((done / total) * 100);
        if (snapTodo)  snapTodo.textContent  = todo;
        if (snapDoing) snapDoing.textContent = doing;
        if (snapDone)  snapDone.textContent  = done;
        if (snapPct)   snapPct.textContent   = pct + "%";
        if (snapBar)   snapBar.style.width   = pct + "%";
      }

      function renderAgentRing(agentMap) {
        if (!agentRingEl) return;
        const entries = Object.entries(agentMap).sort((a,b) => b[1] - a[1]).slice(0, 7);
        const max = entries[0]?.[1] || 1;

        if (entries.length === 0) {
          agentRingEl.innerHTML = '<p class="text-xs text-slate-500">No agent activity today</p>';
          return;
        }

        agentRingEl.innerHTML = entries.map(([name, count]) => {
          const color = agentColor(name);
          const pct   = Math.round((count / max) * 100);
          const shortName = name.length > 22 ? name.slice(0, 20) + "…" : name;
          return `
            <div>
              <div class="mb-0.5 flex items-center justify-between text-[11px]">
                <span class="font-medium" style="color:${color};">${escDash(shortName)}</span>
                <span class="text-slate-400">${count}</span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
                <div class="h-1.5 rounded-full transition-all duration-500" style="width:${pct}%;background:${color};"></div>
              </div>
            </div>`;
        }).join("");
      }

      function renderRecentCompletions(logs) {
        if (!completionsList) return;
        if (!logs || logs.length === 0) {
          completionsList.innerHTML = '<p class="text-xs text-slate-500">No completions yet today</p>';
          return;
        }

        completionsList.innerHTML = logs.slice(0, 6).map(entry => {
          const color = agentColor(entry.agent_name);
          const task  = entry.task_description
            ? (entry.task_description.length > 48 ? entry.task_description.slice(0,46)+"…" : entry.task_description)
            : "Completed task";
          return `
            <div class="rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2" style="border-left:3px solid ${color};">
              <p class="text-[11px] font-semibold text-slate-100">${escDash(task)}</p>
              <div class="mt-0.5 flex items-center justify-between gap-2">
                <span class="text-[10px]" style="color:${color};">${escDash(entry.agent_name || "Unknown")}</span>
                <span class="text-[10px] text-slate-500">${timeAgo(entry.created_at)}</span>
              </div>
            </div>`;
        }).join("");
      }

      // ── Main load ──────────────────────────────────────────────────────────
      async function loadDashboard() {
        // ── Static todos data (no supabase needed for snapshot) ──
        // Pull from Kanban state if available, else query supabase
        async function getTodoSnapshot() {
          // Try window.allTasks from kanban (if loaded)
          // Otherwise fall back to fresh supabase query
          if (supabaseClient) {
            const { data, error } = await supabaseClient
              .from("todos")
              .select("status, track_status")
              .limit(500);
            if (!error && data) {
              const todo  = data.filter(t => t.status === "todo").length;
              const doing = data.filter(t => t.status === "in_progress").length;
              const done  = data.filter(t => t.status === "done").length;
              const atRisk = data.filter(t => t.track_status === "At Risk").length;
              return { todo, doing, done, atRisk };
            }
          }
          return { todo: 0, doing: 0, done: 0, atRisk: 0 };
        }

        // ── Build last 7 days labels ──
        function last7DayLabels() {
          const labels = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
          }
          return labels;
        }

        const fallback = {
          openTasks: 0, doneToday: 0, doneYesterday: 0,
          agentsActive: 0, successRate: "N/A",
          pulseLabels: last7DayLabels(),
          pulseCounts: [0,0,0,0,0,0,0],
          todayPulseCount: 0, deltaPulse: 0,
          atRiskCount: 0, doingCount: 0,
          todo: 0, doing: 0, done: 0,
          agentMap: {},
          recentCompletions: [],
        };

        const snap = await getTodoSnapshot();

        try {
          const snapshot = await fetchMissionControlSnapshot(window.CEIL_MISSION_QUEUE_WORKSPACE_ID || "default");
          if (snapshot.agents.length || snapshot.tasks.length || snapshot.events.length) {
            const runtimeSummary = summarizeMissionControlSnapshot(snapshot);
            const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
            const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
            const todayStartDate = new Date(startOfDayISO(0));
            const yesterdayStartDate = new Date(startOfDayISO(-1));
            const doneToday = tasks.filter((task) => String(task.status || "").toLowerCase() === "done" && new Date(task.updated_at || task.created_at || 0) >= todayStartDate).length;
            const doneYesterday = tasks.filter((task) => {
              const updatedAt = new Date(task.updated_at || task.created_at || 0);
              return String(task.status || "").toLowerCase() === "done" && updatedAt >= yesterdayStartDate && updatedAt < todayStartDate;
            }).length;
            const activeAgents = agents.filter((agent) => ["active", "working", "busy", "running", "in_progress"].includes(String(agent.effective_status || agent.status || "").toLowerCase())).length;
            const pulseCounts = fallback.pulseCounts.slice();
            const recentCompletions = tasks
              .filter((task) => String(task.status || "").toLowerCase() === "done")
              .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))
              .slice(0, 6)
              .map((task) => ({
                agent_name: agents.find((agent) => String(agent.id || "") === String(task.assigned_agent_id || ""))?.name || "Unknown",
                task_description: task.title || task.description || "Completed task",
                status: task.status || "done",
                created_at: task.updated_at || task.created_at || null,
              }));
            const agentMap = Object.fromEntries(runtimeSummary.agentSummaries.filter((agent) => agent.tasksToday > 0).map((agent) => [agent.name, agent.tasksToday]));

            renderQuickStats({
              openTasks: tasks.filter((task) => !["done", "verification"].includes(String(task.status || "").toLowerCase())).length,
              doneToday,
              doneYesterday,
              agentsActive: activeAgents,
              successRate: runtimeSummary.successRate,
            });
            renderPulse({ labels: fallback.pulseLabels, counts: pulseCounts, todayCount: doneToday, deltaCount: doneToday - doneYesterday });
            renderRiskBanner({
              atRiskCount: tasks.filter((task) => ["urgent", "high"].includes(String(task.priority || "").toLowerCase()) && String(task.status || "").toLowerCase() !== "done").length,
              doingCount: tasks.filter((task) => ["assigned", "in_progress", "testing", "review"].includes(String(task.status || "").toLowerCase())).length,
              doingThreshold: 4,
            });
            renderSnapshot({
              todo: tasks.filter((task) => ["planning", "inbox", "assigned"].includes(String(task.status || "").toLowerCase())).length,
              doing: tasks.filter((task) => ["in_progress", "testing", "review", "verification"].includes(String(task.status || "").toLowerCase())).length,
              done: tasks.filter((task) => String(task.status || "").toLowerCase() === "done").length,
            });
            renderAgentRing(agentMap);
            renderRecentCompletions(recentCompletions);
            return;
          }
        } catch (error) {
          console.warn("Mission Control dashboard snapshot unavailable, falling back to Supabase analytics:", error);
        }

        if (!supabaseClient) {
          renderQuickStats({ openTasks: snap.todo + snap.doing, doneToday: 0, doneYesterday: 0, agentsActive: 0, successRate: "N/A" });
          renderPulse({ labels: fallback.pulseLabels, counts: fallback.pulseCounts, todayCount: 0, deltaCount: 0 });
          renderRiskBanner({ atRiskCount: snap.atRisk, doingCount: snap.doing, doingThreshold: 4 });
          renderSnapshot({ todo: snap.todo, doing: snap.doing, done: snap.done });
          renderAgentRing({});
          renderRecentCompletions([]);
          return;
        }

        try {
          const todayStart     = startOfDayISO(0);
          const yesterdayStart = startOfDayISO(-1);
          const weekStart      = startOfWeekISO();

          // Build 7-day window starts
          const dayStarts = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setHours(0,0,0,0);
            d.setDate(d.getDate() - i);
            dayStarts.push(d.toISOString());
          }
          const sevenDaysAgo = dayStarts[0];

          const [
            weekSuccessRes,
            weekTotalRes,
            recentLogsRes,
            sevenDayLogsRes,
          ] = await Promise.all([
            supabaseClient
              .from("agent_logs")
              .select("*", { count: "exact", head: true })
              .gte("created_at", weekStart)
              .or(getCompletedLikeStatusOrClause("status")),
            supabaseClient
              .from("agent_logs")
              .select("*", { count: "exact", head: true })
              .gte("created_at", weekStart),
            supabaseClient
              .from("agent_logs")
              .select("agent_name, task_description, status, created_at")
              .gte("created_at", todayStart)
              .order("created_at", { ascending: false })
              .limit(100),
            supabaseClient
              .from("agent_logs")
              .select("agent_name, status, created_at")
              .gte("created_at", sevenDaysAgo)
              .order("created_at", { ascending: false })
              .limit(2000),
          ]);

          const logs7day       = sevenDayLogsRes.data || [];
          const logsToday      = recentLogsRes.data || [];

          // Pulse: count completeds per day
          const pulseCounts = dayStarts.map((start, idx) => {
            const end = idx < 6 ? dayStarts[idx + 1] : new Date(start).getTime() + 86400000;
            return logs7day.filter(l =>
              isCompletedLikeStatus(l.status) &&
              new Date(l.created_at) >= new Date(start) &&
              new Date(l.created_at) < new Date(end)
            ).length;
          });

          const todayPulseCount     = pulseCounts[6];
          const yesterdayPulseCount = pulseCounts[5];

          // Done tasks today (completed in agent_logs)
          const doneToday     = logsToday.filter(l => isCompletedLikeStatus(l.status)).length;
          // Done yesterday
          const yesterdayLogs = logs7day.filter(l => {
            const t = new Date(l.created_at);
            return t >= new Date(dayStarts[5]) && t < new Date(dayStarts[6]);
          });
          const doneYesterday = yesterdayLogs.filter(l => isCompletedLikeStatus(l.status)).length;

          // Agents active today (distinct agent names)
          const agentsToday = new Set(logsToday.map(l => l.agent_name?.toLowerCase().trim()).filter(Boolean));

          // Agent activity map (all 7-day logs today)
          const agentMap = {};
          for (const l of logsToday) {
            const k = l.agent_name || "Unknown";
            agentMap[k] = (agentMap[k] || 0) + 1;
          }

          // Success rate
          const totalWeek   = weekTotalRes.count || 0;
          const successWeek = weekSuccessRes.count || 0;
          const successRate = totalWeek > 0 ? `${((successWeek / totalWeek) * 100).toFixed(1)}%` : "N/A";

          // Recent completions
          const recentCompletions = logsToday
            .filter(l => isCompletedLikeStatus(l.status))
            .slice(0, 6);

          renderQuickStats({
            openTasks:    snap.todo + snap.doing,
            doneToday,
            doneYesterday,
            agentsActive: agentsToday.size,
            successRate,
          });

          renderPulse({
            labels:       last7DayLabels(),
            counts:       pulseCounts,
            todayCount:   todayPulseCount,
            deltaCount:   todayPulseCount - yesterdayPulseCount,
          });

          renderRiskBanner({
            atRiskCount:    snap.atRisk,
            doingCount:     snap.doing,
            doingThreshold: 4,
          });

          renderSnapshot({ todo: snap.todo, doing: snap.doing, done: snap.done });
          renderAgentRing(agentMap);
          renderRecentCompletions(recentCompletions);

        } catch (err) {
          console.error("Dashboard load failed:", err);
          renderQuickStats({ openTasks: snap.todo + snap.doing, doneToday: 0, doneYesterday: 0, agentsActive: 0, successRate: "N/A" });
          renderPulse({ labels: fallback.pulseLabels, counts: fallback.pulseCounts, todayCount: 0, deltaCount: 0 });
          renderRiskBanner({ atRiskCount: snap.atRisk, doingCount: snap.doing, doingThreshold: 4 });
          renderSnapshot({ todo: snap.todo, doing: snap.doing, done: snap.done });
          renderAgentRing({});
          renderRecentCompletions([]);
        }
      }

      // ── Tab hook ───────────────────────────────────────────────────────────
      let dashLoaded = false;

      function scheduleDashLoad() {
        if (dashLoaded) { loadDashboard(); return; }
        dashLoaded = true;
        loadDashboard();
      }

      // Hook tab clicks
      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          if (btn.dataset.tab === "dashboard") setTimeout(scheduleDashLoad, 80);
        });
      });

      // Load on page open if dashboard is active
      if (document.getElementById("panel-dashboard")?.classList.contains("active")) {
        setTimeout(loadDashboard, 120);
      }

      // Realtime: refresh dashboard on agent_logs or todos changes
      if (supabaseClient) {
        supabaseClient
          .channel("dashboard-live")
          .on("postgres_changes", { event: "*", schema: "public", table: "agent_logs" }, () => {
            if (document.getElementById("panel-dashboard")?.classList.contains("active")) {
              setTimeout(loadDashboard, 300);
            }
          })
          .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, () => {
            if (document.getElementById("panel-dashboard")?.classList.contains("active")) {
              setTimeout(loadDashboard, 300);
            }
          })
          .subscribe();
      }

    })();
