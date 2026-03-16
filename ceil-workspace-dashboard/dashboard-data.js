(function () {
      "use strict";

      const COUNCIL_TABLE = "council_sessions";
      const COUNCIL_RUNS_TABLE = "council_runs";
      const COUNCIL_MESSAGES_TABLE = "council_messages";

      const LOCAL_KEY = "ceil-council-sessions-v1";
      const LOCAL_RUN_PREFIX = "council_runs:";
      const LOCAL_MESSAGE_PREFIX = "council_messages:";
      const LOCAL_UNSYNCED_RUNS_KEY = "council_unsynced_runs";

      const RUNTIME_PROXY_PATH = "/api/tools/invoke";
      const AGENT_GATEWAY_PORT_MAP = {
        "main": 18789,
        "workspace-manager": 19001,
        "provisioning-architect": 19011,
        "reliability-sre": 19031,
        "quality-auditor": 19051,
        "os-monitor": 19081,
        "research-search": 19091,
        "senku-ishigami": 19101,
        "ariana": 19111,
      };

      // ── DOM refs ─────────────────────────────────────────────────────────
      const panelCouncil = document.getElementById("panel-council");
      const viewBtns = Array.from(document.querySelectorAll(".council-view-btn"));
      const viewListEl = document.getElementById("council-view-list");
      const viewWeeklyEl = document.getElementById("council-view-weekly");
      const viewMonthlyEl = document.getElementById("council-view-monthly");
      const detailPanelEl = document.getElementById("council-detail-panel");
      const detailContentEl = document.getElementById("council-detail-content");
      const backBtnEl = document.getElementById("council-back-btn");

      const statTotalEl = document.getElementById("council-stat-total");
      const statWeekEl = document.getElementById("council-stat-week");
      const statAgentsEl = document.getElementById("council-stat-agents");
      const statLastEl = document.getElementById("council-stat-last");

      const newBtnEl = document.getElementById("council-new-btn");
      const modalEl = document.getElementById("council-modal");
      const modalSaveEl = document.getElementById("council-modal-save");
      const modalCancelEl = document.getElementById("council-modal-cancel");
      const titleInputEl = document.getElementById("council-title-input");
      const dateInputEl = document.getElementById("council-date-input");
      const timeInputEl = document.getElementById("council-time-input");
      const notesInputEl = document.getElementById("council-notes-input");
      const participantPickerEl = document.getElementById("council-participant-picker");
      const deleteModalEl = document.getElementById("council-delete-modal");
      const deleteModalTextEl = document.getElementById("council-delete-modal-text");
      const deleteModalConfirmEl = document.getElementById("council-delete-modal-confirm");
      const deleteModalCancelEl = document.getElementById("council-delete-modal-cancel");

      if (!panelCouncil) return;

      // ── State ────────────────────────────────────────────────────────────
      let sessions = [];
      let loaded = false;
      let activeView = "list";
      let weekOffset = 0;
      let monthOffset = 0;
      let selectedParticipants = new Set(["Workspace Orchestrator", "Workspace Manager", "Senku Ishigami"]);
      let usingLocalStore = false;
      let selectedSessionId = null;
      let deleteConfirmResolver = null;

      const runsById = new Map();
      const messagesByRun = new Map();
      const activeRunControllers = new Map();
      const runtimeToolCache = new Map();
      const councilEventSources = new Map();
      const participantStatesByRun = new Map();

      // ── Helpers ──────────────────────────────────────────────────────────
      function esc(v) {
        return String(v ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function agentMeta(name) {
        if (typeof resolveAgentFromLogName === "function") {
          const resolved = resolveAgentFromLogName(name);
          if (resolved) return resolved;
        }
        return CEIL_AGENTS.find(a => normalizeAgentName(a.name) === normalizeAgentName(name));
      }

      function agentColor(name) {
        return agentMeta(name)?.color || "#64748B";
      }

      function agentEmoji(name) {
        return agentMeta(name)?.emoji || "🤖";
      }

      function asDate(v) {
        const d = new Date(v || Date.now());
        return isNaN(d) ? new Date() : d;
      }

      function fmtDateTime(v) {
        const d = asDate(v);
        return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
      }

      function fmtDate(v) {
        const d = asDate(v);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      }

      function toInputDate(v) {
        const d = asDate(v);
        const yy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yy}-${mm}-${dd}`;
      }

      function toInputTime(v) {
        const d = asDate(v);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      }

      function startOfWeek(d) {
        const x = new Date(d);
        x.setHours(0,0,0,0);
        const day = x.getDay();
        x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
        return x;
      }

      function readJson(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch {
          return fallback;
        }
      }

      function writeJson(key, value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch {
          return false;
        }
      }

      function nowIso() {
        return new Date().toISOString();
      }

      function generateUuid() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
          return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }

      function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
      }

      function addUniqueLocalValue(key, value) {
        const list = readJson(key, []);
        if (!Array.isArray(list)) return;
        if (!list.includes(value)) {
          list.unshift(value);
          writeJson(key, list.slice(0, 500));
        }
      }

      function removeLocalValue(key, value) {
        const list = readJson(key, []);
        if (!Array.isArray(list)) return;
        writeJson(key, list.filter((item) => item !== value));
      }

      function markRunUnsynced(runId) {
        addUniqueLocalValue(LOCAL_UNSYNCED_RUNS_KEY, runId);
      }

      function clearRunUnsynced(runId) {
        removeLocalValue(LOCAL_UNSYNCED_RUNS_KEY, runId);
      }

      function localRunKey(runId) {
        return `${LOCAL_RUN_PREFIX}${runId}`;
      }

      function localMessagesKey(runId) {
        return `${LOCAL_MESSAGE_PREFIX}${runId}`;
      }

      function toParticipantSlug(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        if (AGENT_RUNTIME_CONFIG.canonicalSlugs.includes(raw)) return raw;
        const mapped = agentSlugFromName(raw);
        if (mapped) return mapped;
        return normalizeAgentName(raw).replace(/\s+/g, "-").replace(/\//g, "-");
      }

      function participantDisplay(slugOrName) {
        const normalized = String(slugOrName || "").trim();
        if (!normalized) return "Unknown";

        const viaMap = Object.entries(AGENT_RUNTIME_CONFIG.participantToSlug || {}).find(([, slug]) => slug === normalized);
        if (viaMap?.[0]) return viaMap[0];

        return agentMeta(normalized)?.name || normalized;
      }

      function participantsFromSession(session) {
        return Array.isArray(session?.participants)
          ? session.participants.map(toParticipantSlug).filter(Boolean)
          : [];
      }

      function topicFromSession(session) {
        return String(session?.topic || session?.notes || session?.title || "").trim();
      }

      function runtimePortForAgentSlug(slug) {
        const key = String(slug || "").trim();
        return AGENT_GATEWAY_PORT_MAP[key] || 18789;
      }

      function runStatusMeta(status) {
        const s = String(status || "").toLowerCase();
        if (s === "running") return { label: "running", klass: "border-cyan-400/40 bg-cyan-500/15 text-cyan-200" };
        if (s === "queued") return { label: "queued", klass: "border-amber-400/40 bg-amber-500/15 text-amber-200" };
        if (s === "completed") return { label: "completed", klass: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200" };
        if (s === "failed") return { label: "failed", klass: "border-red-400/40 bg-red-500/15 text-red-200" };
        if (s === "stopped") return { label: "stopped", klass: "border-slate-400/40 bg-slate-500/15 text-slate-200" };
        return { label: "idle", klass: "border-slate-500/40 bg-slate-500/10 text-slate-300" };
      }

      function classifyDispatchError(message = "") {
        const text = String(message || "").toLowerCase();
        if (!text) return "other";
        if (text.includes("tool not available") || text.includes("missing") || text.includes("tool exposure")) return "tool_missing";
        if (text.includes("unauthorized") || text.includes("auth") || text.includes("token")) return "auth";
        if (text.includes("timeout")) return "timeout";
        if (text.includes("forbidden")) return "forbidden";
        if (text.includes("no session found") || text.includes("session_not_found") || text.includes("session key") || text.includes("unable to create or bind a thread")) return "session_not_found";
        return "other";
      }

      function writeLocalRun(run) {
        writeJson(localRunKey(run.id), run);
        runsById.set(run.id, run);
      }

      function readLocalRun(runId) {
        const run = readJson(localRunKey(runId), null);
        if (run) runsById.set(runId, run);
        return run;
      }

      function readLocalMessages(runId) {
        const rows = readJson(localMessagesKey(runId), []);
        const list = Array.isArray(rows) ? rows : [];
        messagesByRun.set(runId, list);
        return list;
      }

      function appendLocalMessage(message) {
        const list = readLocalMessages(message.run_id);
        const next = [...list, message];
        writeJson(localMessagesKey(message.run_id), next);
        messagesByRun.set(message.run_id, next);
      }

      function upsertParticipantState(runId, nextState) {
        const list = participantStatesByRun.get(runId) || [];
        const filtered = list.filter((item) => String(item.agent_slug || "") !== String(nextState.agent_slug || ""));
        filtered.push(nextState);
        participantStatesByRun.set(runId, filtered);
      }

      function closeCouncilEventStream(runId) {
        const source = councilEventSources.get(runId);
        if (source) {
          source.close();
          councilEventSources.delete(runId);
        }
      }

      function applyCouncilEvent(event) {
        const runId = String(event?.run_id || event?.payload?.run_id || "");
        if (!runId) return;

        if (event.type === "message") {
          const payload = event.payload || {};
          appendLocalMessage({
            id: event.id || generateUuid(),
            run_id: runId,
            agent_slug: payload.agent_slug || "system",
            role: payload.role || "system",
            content: payload.content || "",
            created_at: payload.created_at || event.created_at || nowIso(),
          });
        }

        if (event.type === "round.status") {
          const payload = event.payload || {};
          appendLocalMessage({
            id: event.id || generateUuid(),
            run_id: runId,
            agent_slug: "system",
            role: "system",
            content: `[round:${payload.round || "unknown"}] ${payload.state || "updated"}${payload.details ? ` — ${payload.details}` : ""}`,
            created_at: payload.created_at || event.created_at || nowIso(),
          });
        }

        if (event.type === "artifact.persisted") {
          const payload = event.payload || {};
          appendLocalMessage({
            id: event.id || generateUuid(),
            run_id: runId,
            agent_slug: "system",
            role: "system",
            content: payload.status === "persisted"
              ? `Artifact persisted at ${payload.path || "(unknown path)"}`
              : `Artifact persistence ${payload.status || "skipped"}${payload.error ? `: ${payload.error}` : ""}`,
            created_at: payload.created_at || event.created_at || nowIso(),
          });
        }

        if (event.type === "participant.status") {
          const payload = event.payload || {};
          upsertParticipantState(runId, {
            agent_slug: payload.agent_slug || "",
            participant: payload.participant || participantDisplay(payload.agent_slug || ""),
            state: payload.state || "idle",
            details: payload.details || "",
            session_key: payload.session_key || "",
            created_at: payload.created_at || event.created_at || nowIso(),
          });
        }

        if (event.type === "run.status" || event.type === "run.created") {
          const payload = event.payload || {};
          const run = runsById.get(runId) || { id: runId, session_id: payload.session_id || "", created_by: "dashboard", error: null };
          run.status = payload.status || run.status || "queued";
          run.started_at = payload.started_at || run.started_at || payload.created_at || nowIso();
          run.ended_at = payload.ended_at || run.ended_at || null;
          if (Object.prototype.hasOwnProperty.call(payload, "error")) {
            run.error = payload.error;
          }
          runsById.set(runId, run);
          writeLocalRun(run);

          const session = sessions.find((item) => String(item.id) === String(run.session_id || payload.session_id || ""));
          if (session) {
            session.last_run_id = runId;
            session.run_status = run.status;
            session.run_started_at = run.started_at || session.run_started_at;
            session.run_finished_at = run.ended_at || session.run_finished_at;
            saveLocalSessions();
          }

          if (["completed", "failed", "stopped"].includes(String(run.status || "").toLowerCase())) {
            closeCouncilEventStream(runId);
          }
        }

        const linkedRun = runsById.get(runId);
        const linkedSession = sessions.find((item) => String(item.id) === String(linkedRun?.session_id || ""));
        if (linkedSession && selectedSessionId && String(selectedSessionId) === String(linkedSession.id)) {
          renderDetail(linkedSession);
        }

        renderStats();
      }

      function startCouncilEventStream(runId, sessionId) {
        closeCouncilEventStream(runId);
        const source = new EventSource(`/api/council/run/stream?run_id=${encodeURIComponent(runId)}`);
        source.addEventListener("message", (msg) => {
          try {
            const event = JSON.parse(msg.data);
            applyCouncilEvent(event);
          } catch (error) {
            console.error("Failed to parse council event:", error);
          }
        });
        source.addEventListener("participant.status", (msg) => {
          try {
            applyCouncilEvent(JSON.parse(msg.data));
          } catch (error) {
            console.error("Failed to parse council participant event:", error);
          }
        });
        source.addEventListener("run.status", (msg) => {
          try {
            applyCouncilEvent(JSON.parse(msg.data));
          } catch (error) {
            console.error("Failed to parse council status event:", error);
          }
        });
        source.addEventListener("run.created", (msg) => {
          try {
            const event = JSON.parse(msg.data);
            const run = {
              id: event.payload?.run_id || runId,
              session_id: sessionId,
              status: event.payload?.status || "queued",
              started_at: event.payload?.created_at || nowIso(),
              ended_at: null,
              created_by: "dashboard",
              error: null,
            };
            runsById.set(runId, run);
            applyCouncilEvent(event);
          } catch (error) {
            console.error("Failed to parse council created event:", error);
          }
        });
        source.onerror = () => {
          const run = runsById.get(runId);
          const terminal = ["completed", "failed", "stopped"].includes(String(run?.status || "").toLowerCase());
          if (terminal) {
            closeCouncilEventStream(runId);
          }
        };
        councilEventSources.set(runId, source);
      }

      function normalizeSession(row) {
        const rawParticipants = Array.isArray(row.participants)
          ? row.participants
          : typeof row.participants === "string"
            ? row.participants.split(",").map(s => s.trim()).filter(Boolean)
            : [];

        const participants = rawParticipants.map(toParticipantSlug).filter(Boolean);
        const transcript = Array.isArray(row.transcript) ? row.transcript : [];

        const participant_bindings = Array.isArray(row.participant_bindings)
          ? row.participant_bindings.map((binding) => {
              const slug = toParticipantSlug(binding.agent_slug || binding.participant || "");
              return {
                participant: binding.participant || participantDisplay(slug),
                agent_slug: slug,
                session_label: binding.session_label || slug,
                session_key: String(binding.session_key || row.last_run_id || ""),
              };
            })
          : participants.map((slug) => ({
              participant: participantDisplay(slug),
              agent_slug: slug,
              session_label: slug,
              session_key: String(row.last_run_id || ""),
            }));

        return {
          id: row.id || generateUuid(),
          title: row.title || "Council Session",
          topic: topicFromSession(row),
          meeting_at: row.meeting_at || row.meeting_date || row.created_at || new Date().toISOString(),
          participants,
          participant_bindings,
          notes: row.notes || row.summary || "",
          transcript,
          created_at: row.created_at || row.meeting_at || new Date().toISOString(),
          last_run_id: String(row.last_run_id || ""),
          run_status: String(row.run_status || ""),
          run_started_at: row.run_started_at || "",
          run_finished_at: row.run_finished_at || "",
        };
      }

      function sortSessions() {
        sessions.sort((a,b) => asDate(b.meeting_at) - asDate(a.meeting_at));
      }

      function loadLocalSessions() {
        try {
          const raw = localStorage.getItem(LOCAL_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) {
            sessions = parsed
              .map(normalizeSession)
              .filter((row) => !String(row.id || "").startsWith("seed-"));
          } else {
            sessions = [];
          }
        } catch {
          sessions = [];
        }
      }

      function saveLocalSessions() {
        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(sessions));
        } catch {}
      }

      async function loadSessions() {
        // Load local as the baseline (merging logic)
        loadLocalSessions();
        const localOnly = sessions.filter(s => !String(s.id).startsWith("seed-"));

        if (!supabaseClient || usingLocalStore) {
          sortSessions();
          return;
        }

        const extendedSelect = "id, title, topic, meeting_at, participants, participant_bindings, notes, transcript, created_at, last_run_id, run_status, run_started_at, run_finished_at";

        let response = await supabaseClient
          .from(COUNCIL_TABLE)
          .select(extendedSelect)
          .order("meeting_at", { ascending: false })
          .limit(600);

        if (response.error) {
          console.error("Supabase load error (extended):", response.error);
          response = await supabaseClient
            .from(COUNCIL_TABLE)
            .select("id, title, meeting_at, participants, participant_bindings, notes, transcript, created_at")
            .order("meeting_at", { ascending: false })
            .limit(600);
        }

        if (response.error) {
          console.error("Supabase load error (fallback):", response.error);
          usingLocalStore = true;
          sortSessions();
          return;
        }

        const remoteSessions = (response.data || []).map(normalizeSession);
        const remoteIds = new Set(remoteSessions.map(s => String(s.id)));

        // Merge local sessions that haven't been synced to remote yet
        const merged = [
          ...remoteSessions,
          ...localOnly.filter(s => !remoteIds.has(String(s.id)))
        ];

        sessions = merged;
        sortSessions();
        saveLocalSessions();
      }

      async function upsertRunRecord(run) {
        writeLocalRun(run);

        if (!supabaseClient || usingLocalStore) {
          markRunUnsynced(run.id);
          return { storage: "local" };
        }

        const runPayload = {
          ...run,
          error: run?.error && typeof run.error === "object" ? JSON.stringify(run.error) : run.error,
        };

        const { error } = await supabaseClient
          .from(COUNCIL_RUNS_TABLE)
          .upsert([runPayload], { onConflict: "id" });

        if (error) {
          markRunUnsynced(run.id);
          return { storage: "local", error };
        }

        clearRunUnsynced(run.id);
        return { storage: "supabase" };
      }

      async function insertRunMessage(message) {
        appendLocalMessage(message);

        if (!supabaseClient || usingLocalStore) {
          markRunUnsynced(message.run_id);
          return { storage: "local" };
        }

        const { error } = await supabaseClient
          .from(COUNCIL_MESSAGES_TABLE)
          .insert([message]);

        if (error) {
          markRunUnsynced(message.run_id);
          return { storage: "local", error };
        }

        clearRunUnsynced(message.run_id);
        return { storage: "supabase" };
      }

      async function updateSessionState(sessionId, patch) {
        const idx = sessions.findIndex((s) => String(s.id) === String(sessionId));
        if (idx === -1) return;

        sessions[idx] = { ...sessions[idx], ...patch };
        saveLocalSessions();

        if (!supabaseClient || usingLocalStore) return;

        const { error } = await supabaseClient
          .from(COUNCIL_TABLE)
          .update(patch)
          .eq("id", sessionId);

        if (error) {
          usingLocalStore = true;
        }
      }

      async function loadRunArtifactsForSession(session) {
        const runId = String(session?.last_run_id || "");
        if (!runId) return;

        let run = runsById.get(runId) || null;
        let messages = messagesByRun.get(runId) || [];

        if (supabaseClient && !usingLocalStore) {
          const [runRes, msgRes] = await Promise.all([
            supabaseClient
              .from(COUNCIL_RUNS_TABLE)
              .select("id, session_id, status, started_at, ended_at, created_by, error")
              .eq("id", runId)
              .maybeSingle(),
            supabaseClient
              .from(COUNCIL_MESSAGES_TABLE)
              .select("id, run_id, agent_slug, role, content, created_at")
              .eq("run_id", runId)
              .order("created_at", { ascending: true }),
          ]);

          if (!runRes.error && runRes.data) {
            run = { ...runRes.data };
            if (typeof run.error === "string" && run.error.trim().startsWith("{")) {
              try { run.error = JSON.parse(run.error); } catch {}
            }
            runsById.set(runId, run);
          }

          if (!msgRes.error && Array.isArray(msgRes.data)) {
            messages = msgRes.data;
            messagesByRun.set(runId, messages);
          }
        }

        if (!run) run = readLocalRun(runId);
        if (!messages.length) messages = readLocalMessages(runId);

        if (run) {
          session.run_status = run.status || session.run_status;
          session.run_started_at = run.started_at || session.run_started_at;
          session.run_finished_at = run.ended_at || session.run_finished_at;
        }
      }

      async function syncRunToSupabase(runId) {
        if (!supabaseClient) return { ok: false, reason: "supabase_unavailable" };

        const run = runsById.get(runId) || readLocalRun(runId);
        if (!run) return { ok: false, reason: "run_missing" };

        let linkedSession = sessions.find((s) => String(s.last_run_id || "") === String(runId)) || null;

        // Migrate legacy local-* session IDs to UUID before syncing.
        if (linkedSession && !isUuid(linkedSession.id)) {
          const oldId = String(linkedSession.id);
          const migratedId = generateUuid();
          linkedSession = { ...linkedSession, id: migratedId };

          sessions = sessions.map((s) => String(s.id) === oldId ? linkedSession : s);
          saveLocalSessions();

          if (String(run.session_id || "") === oldId) {
            run.session_id = migratedId;
            writeLocalRun(run);
          }
        }

        // Ensure session exists in Supabase before syncing runs/messages.
        if (linkedSession && isUuid(linkedSession.id)) {
          const sessionPayload = {
            id: linkedSession.id,
            title: linkedSession.title,
            topic: linkedSession.topic || topicFromSession(linkedSession),
            meeting_at: linkedSession.meeting_at || linkedSession.created_at || nowIso(),
            participants: Array.isArray(linkedSession.participants) ? linkedSession.participants : [],
            participant_bindings: Array.isArray(linkedSession.participant_bindings) ? linkedSession.participant_bindings : [],
            notes: linkedSession.notes || "",
            transcript: Array.isArray(linkedSession.transcript) ? linkedSession.transcript : [],
            last_run_id: run.id,
            run_status: linkedSession.run_status || run.status,
            run_started_at: linkedSession.run_started_at || run.started_at || null,
            run_finished_at: linkedSession.run_finished_at || run.ended_at || null,
          };

          const sessionUpsertRes = await supabaseClient
            .from(COUNCIL_TABLE)
            .upsert([sessionPayload], { onConflict: "id" });

          if (sessionUpsertRes.error) {
            return { ok: false, reason: sessionUpsertRes.error.message || "session_upsert_failed" };
          }

          run.session_id = linkedSession.id;
          writeLocalRun(run);
        }

        const canonicalRunId = isUuid(run?.id) ? run.id : generateUuid();
        if (String(run.id || "") !== String(canonicalRunId)) {
          run.id = canonicalRunId;
          if (linkedSession) {
            linkedSession.last_run_id = canonicalRunId;
            sessions = sessions.map((s) => String(s.id) === String(linkedSession.id) ? linkedSession : s);
            saveLocalSessions();
          }
          writeLocalRun(run);
        }

        const messages = messagesByRun.get(runId) || readLocalMessages(runId);
        const sanitizedMessages = Array.isArray(messages)
          ? messages.map((msg) => ({
              ...msg,
              id: isUuid(msg?.id) ? msg.id : generateUuid(),
              run_id: canonicalRunId,
            }))
          : [];

        const runPayload = {
          ...run,
          id: canonicalRunId,
          session_id: isUuid(run?.session_id) ? run.session_id : (linkedSession?.id || null),
          error: run?.error && typeof run.error === "object" ? JSON.stringify(run.error) : run.error,
        };

        const runRes = await supabaseClient
          .from(COUNCIL_RUNS_TABLE)
          .upsert([runPayload], { onConflict: "id" });

        if (runRes.error) {
          return { ok: false, reason: runRes.error.message || "run_upsert_failed" };
        }

        if (sanitizedMessages.length > 0) {
          const msgRes = await supabaseClient
            .from(COUNCIL_MESSAGES_TABLE)
            .upsert(sanitizedMessages, { onConflict: "id" });

          if (msgRes.error) {
            return { ok: false, reason: msgRes.error.message || "message_upsert_failed" };
          }
        }

        if (linkedSession) {
          const sessionUpdate = {
            last_run_id: runPayload.id,
            run_status: linkedSession.run_status || runPayload.status,
            run_started_at: linkedSession.run_started_at || runPayload.started_at || null,
            run_finished_at: linkedSession.run_finished_at || runPayload.ended_at || null,
            topic: linkedSession.topic || topicFromSession(linkedSession),
          };

          const sessionRes = await supabaseClient
            .from(COUNCIL_TABLE)
            .update(sessionUpdate)
            .eq("id", linkedSession.id);

          if (sessionRes.error) {
            return { ok: false, reason: sessionRes.error.message || "session_update_failed" };
          }
        }

        clearRunUnsynced(runId);
        return { ok: true };
      }

      async function syncPendingLocalRuns() {
        if (!supabaseClient || usingLocalStore) return;
        const pending = readJson(LOCAL_UNSYNCED_RUNS_KEY, []);
        if (!Array.isArray(pending) || pending.length === 0) return;

        for (const runId of pending) {
          const result = await syncRunToSupabase(runId);
          if (result.ok) clearRunUnsynced(runId);
        }
      }

      async function invokeRuntime(tool, action, args, options = {}) {
        const payload = { tool };
        if (action) payload.action = action;
        if (typeof args !== "undefined") payload.args = args;
        if (typeof options.sessionKey === "string" && options.sessionKey.length > 0) payload.sessionKey = options.sessionKey;
        if (typeof options.dryRun === "boolean") payload.dryRun = options.dryRun;

        const port = Number(options.port || 18789);
        const requestUrl = `${RUNTIME_PROXY_PATH}?port=${encodeURIComponent(String(port))}`;

        const response = await fetch(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const raw = await response.text();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }

        if (!response.ok) {
          throw new Error(data?.error?.message || `Runtime invoke HTTP ${response.status}`);
        }

        if (!data?.ok) {
          throw new Error(data?.error?.message || "Runtime invocation failed");
        }

        return data.result;
      }

      async function listRuntimeSessions(port = 18789) {
        const result = await invokeRuntime("sessions_list", "json", {}, { dryRun: false, port });
        const details = result?.details || {};
        return Array.isArray(details.sessions) ? details.sessions : [];
      }

      async function resolveSessionKeyForAgentSlug(agentSlug, port = 18789) {
        const sessions = await listRuntimeSessions(port);
        const normalized = String(agentSlug || "").trim();
        if (!normalized) return "";

        const direct = sessions.find((s) => {
          const key = String(s?.key || "");
          return key.startsWith(`agent:${normalized}:`);
        });
        if (direct?.key) return String(direct.key);

        const byLabel = sessions.find((s) => String(s?.label || "") === normalized);
        if (byLabel?.key) return String(byLabel.key);

        const mainFallback = sessions.find((s) => String(s?.key || "") === "agent:main:main");
        if (mainFallback?.key) return String(mainFallback.key);

        return "";
      }

      async function probeRuntimeCapabilities(port = 18789, force = false) {
        const cacheKey = String(port);
        const cached = runtimeToolCache.get(cacheKey);
        if (!force && cached && Date.now() - cached.checkedAt < 30_000) {
          return cached;
        }

        const caps = {
          checkedAt: Date.now(),
          reachable: false,
          sessions_list: false,
          sessions_send: false,
          sessions_spawn: false,
          process: false,
          subagents: false,
          errors: [],
        };

        const probes = [
          { name: "sessions_list", call: () => invokeRuntime("sessions_list", "json", {}, { dryRun: false, port }) },
          { name: "sessions_send", call: () => invokeRuntime("sessions_send", null, { label: "workspace-manager", message: "capability probe" }, { dryRun: true, port }) },
          { name: "sessions_spawn", call: () => invokeRuntime("sessions_spawn", null, { task: "capability probe", label: "council-capability-probe", runtime: "subagent", agentId: "workspace-manager", mode: "run", cleanup: "delete" }, { dryRun: true, port }) },
          { name: "process", call: () => invokeRuntime("process", null, { action: "list" }, { dryRun: true, port }) },
          { name: "subagents", call: () => invokeRuntime("subagents", null, { action: "list" }, { dryRun: true, port }) },
        ];

        for (const probe of probes) {
          try {
            await probe.call();
            caps[probe.name] = true;
            if (probe.name === "sessions_list") caps.reachable = true;
          } catch (err) {
            caps.errors.push(`${probe.name}: ${err.message}`);
          }
        }

        runtimeToolCache.set(cacheKey, caps);
        return caps;
      }

      function stringifyRuntimeResult(result) {
        if (typeof result === "string") return result;
        if (result == null) return "No response payload returned.";
        if (typeof result === "object") {
          if (typeof result.reply === "string") return result.reply;
          if (typeof result.response === "string") return result.response;
          if (typeof result.message === "string") return result.message;
          if (Array.isArray(result.messages) && result.messages.length > 0) {
            return result.messages.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
          }
        }
        const raw = JSON.stringify(result, null, 2);
        return raw.length > 5000 ? `${raw.slice(0, 5000)}...` : raw;
      }

      function buildDispatchPrompt(session, targetSlug, participants, history = []) {
        const historyText = history.length > 0
          ? "\n\n--- PREVIOUS COUNCIL CONTRIBUTIONS ---\n" + 
            history.map(h => `[${h.speaker}]: ${h.text}`).join("\n\n") + 
            "\n--- END OF CONTRIBUTIONS ---\n"
          : "";

        return [
          `Council Run ID: ${session.last_run_id}`,
          `Session Title: ${session.title}`,
          `Topic: ${topicFromSession(session)}`,
          `Participants: ${participants.map((slug) => participantDisplay(slug)).join(", ")}`,
          `Target Agent: ${targetSlug}`,
          `Notes: ${session.notes || "No additional notes."}`,
          historyText,
          "Please review the contributions above (if any) and provide your perspective. Respond with your actionable contribution and one clear next action.",
        ].filter(Boolean).join("\n");
      }

      async function dispatchCouncilRun(runId, session) {
        const participants = participantsFromSession(session);
        const topic = topicFromSession(session);
        const controller = activeRunControllers.get(runId);
        const history = [];

        await insertRunMessage({
          id: generateUuid(),
          run_id: runId,
          agent_slug: "system",
          role: "system",
          content: `Council topic: ${topic}`,
          created_at: nowIso(),
        });

        const failedAgents = [];
        let successCount = 0;

        for (const slug of participants) {
          if (controller?.stopped || activeRunControllers.get(runId)?.stopped) {
            return {
              status: "stopped",
              errorObject: {
                failed_agents: failedAgents,
                success_count: successCount,
                failure_count: failedAgents.length,
              },
            };
          }

          const targetPort = runtimePortForAgentSlug(slug);
          const prompt = buildDispatchPrompt(session, slug, participants, history);

          const recordFailure = async (tool, message) => {
            const failure = {
              agent_slug: slug,
              port: targetPort,
              tool,
              error_type: classifyDispatchError(message),
              message: String(message || "unknown error"),
            };
            failedAgents.push(failure);
            await insertRunMessage({
              id: generateUuid(),
              run_id: runId,
              agent_slug: slug,
              role: "system",
              content: `Dispatch skipped/failed for ${slug} (${tool}@${targetPort}): ${failure.message}`,
              created_at: nowIso(),
            });
          };

          let caps;
          try {
            caps = await probeRuntimeCapabilities(targetPort);
          } catch (err) {
            await recordFailure("sessions_list", err.message || "capability probe failed");
            continue;
          }

          if (!caps?.reachable) {
            await recordFailure("sessions_list", `Gateway ${targetPort} unreachable`);
            continue;
          }

          if (!caps.sessions_send) {
            await recordFailure("sessions_send", `Tool missing on gateway ${targetPort}`);
            continue;
          }

          let sessionKey = "";
          try {
            sessionKey = await resolveSessionKeyForAgentSlug(slug, targetPort);
          } catch (err) {
            await recordFailure("sessions_list", err.message || "session lookup failed");
            continue;
          }

          if (!sessionKey) {
            await recordFailure("sessions_send", `No session found for ${slug} on gateway ${targetPort}`);
            continue;
          }

          try {
            const result = await invokeRuntime(
              "sessions_send",
              null,
              { sessionKey, message: prompt, timeoutSeconds: 300 },
              { dryRun: false, port: targetPort }
            );

            if (controller?.stopped || activeRunControllers.get(runId)?.stopped) {
              return {
                status: "stopped",
                errorObject: {
                  failed_agents: failedAgents,
                  success_count: successCount,
                  failure_count: failedAgents.length,
                },
              };
            }

            const detailStatus = String(result?.details?.status || result?.status || "").toLowerCase();
            if (detailStatus === "error" || detailStatus === "forbidden" || detailStatus === "timeout") {
              await recordFailure("sessions_send", result?.details?.error || result?.error || `dispatch returned status=${detailStatus}`);
              continue;
            }

            const replyText = result?.details?.reply || stringifyRuntimeResult(result);
            successCount += 1;
            
            // Add to history for the next agent
            history.push({ speaker: participantDisplay(slug), text: replyText });

            await insertRunMessage({
              id: generateUuid(),
              run_id: runId,
              agent_slug: slug,
              role: "agent",
              content: replyText,
              created_at: nowIso(),
            });
          } catch (err) {
            await recordFailure("sessions_send", err.message || "send failed");
          }
        }

        const errorObject = {
          failed_agents: failedAgents,
          success_count: successCount,
          failure_count: failedAgents.length,
        };

        if (successCount === 0) {
          return { status: "failed", errorObject };
        }

        if (failedAgents.length > 0) {
          return { status: "completed", errorObject };
        }

        return { status: "completed", errorObject: null };
      }

      // ── Render stats ──────────────────────────────────────────────────────
      function renderStats() {
        const total = sessions.length;

        const weekStart = startOfWeek(new Date());
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const weekCount = sessions.filter(s => {
          const d = asDate(s.meeting_at);
          return d >= weekStart && d < weekEnd;
        }).length;

        const participantSet = new Set();
        sessions.forEach((s) => participantsFromSession(s).forEach((slug) => participantSet.add(slug)));

        if (statTotalEl) statTotalEl.textContent = String(total);
        if (statWeekEl) statWeekEl.textContent = String(weekCount);
        if (statAgentsEl) statAgentsEl.textContent = String(participantSet.size);
        if (statLastEl) statLastEl.textContent = total > 0 ? fmtDateTime(sessions[0].meeting_at) : "—";
      }

      // ── List view ─────────────────────────────────────────────────────────
      function renderListView() {
        if (!viewListEl) return;

        if (sessions.length === 0) {
          viewListEl.innerHTML = '<div class="council-card p-6 text-center text-sm text-slate-400">No council sessions yet.</div>';
          return;
        }

        viewListEl.innerHTML = sessions.map((s, idx) => {
          const slugs = participantsFromSession(s);
          const participantsHtml = slugs.slice(0, 5).map((slug) => {
            const color = agentColor(slug);
            return `<span class="council-tag" style="border-color:${color}66;color:${color};">${esc(agentEmoji(slug))} ${esc(participantDisplay(slug))}</span>`;
          }).join("");

          const moreCount = Math.max(0, slugs.length - 5);
          const runMeta = runStatusMeta(s.run_status);

          return `
            <article class="council-card p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-[10px] uppercase tracking-wider text-slate-500">Session #${idx + 1}</p>
                  <h4 class="mt-0.5 truncate text-sm font-bold text-white">${esc(s.title)}</h4>
                  <p class="mt-1 text-[11px] text-slate-400">${esc(fmtDateTime(s.meeting_at))}</p>
                </div>
                <div class="flex items-center gap-2">
                  <span class="rounded-full border px-2 py-0.5 text-[10px] font-semibold ${runMeta.klass}">${esc(runMeta.label)}</span>
                  <button class="council-open-btn rounded-lg border border-violet-400/35 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300 transition hover:bg-violet-500/20" data-open-id="${esc(s.id)}">Open</button>
                  <button class="council-delete-btn rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" data-delete-id="${esc(s.id)}">Delete</button>
                </div>
              </div>

              <p class="mt-2 text-xs text-slate-300">${esc((topicFromSession(s) || "No topic.").slice(0, 220))}</p>

              <div class="mt-3 flex flex-wrap gap-1.5">
                ${participantsHtml}
                ${moreCount > 0 ? `<span class="council-tag">+${moreCount} more</span>` : ""}
              </div>
            </article>`;
        }).join("");
      }

      // ── Weekly view ───────────────────────────────────────────────────────
      function renderWeeklyView() {
        if (!viewWeeklyEl) return;

        const start = startOfWeek(new Date());
        start.setDate(start.getDate() + (weekOffset * 7));
        const days = Array.from({length: 7}, (_, i) => {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          return d;
        });

        const end = new Date(start);
        end.setDate(end.getDate() + 7);

        const inWeek = sessions.filter(s => {
          const d = asDate(s.meeting_at);
          return d >= start && d < end;
        });

        const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

        viewWeeklyEl.innerHTML = `
          <div class="council-calendar">
            <div class="council-calendar-head flex items-center justify-between px-4 py-3">
              <button id="council-week-prev" class="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-xs text-slate-300">←</button>
              <p class="text-sm font-semibold text-white">${esc(fmtDate(days[0]))} — ${esc(fmtDate(days[6]))}</p>
              <button id="council-week-next" class="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-xs text-slate-300">→</button>
            </div>
            <div class="council-grid-7">
              ${dayNames.map(n => `<div class="council-day-name">${n}</div>`).join("")}
            </div>
            <div class="council-grid-7">
              ${days.map(day => {
                const dayStr = day.toDateString();
                const events = inWeek.filter(s => asDate(s.meeting_at).toDateString() === dayStr);
                return `
                  <div class="council-week-cell">
                    <div class="council-day-label">${day.getDate()}</div>
                    ${events.map(e => `<div class="council-event-chip" data-open-id="${esc(e.id)}">${esc(e.title.slice(0, 36))}</div>`).join("")}
                  </div>`;
              }).join("")}
            </div>
          </div>`;

        document.getElementById("council-week-prev")?.addEventListener("click", () => { weekOffset -= 1; renderWeeklyView(); });
        document.getElementById("council-week-next")?.addEventListener("click", () => { weekOffset += 1; renderWeeklyView(); });
      }

      // ── Monthly view ──────────────────────────────────────────────────────
      function renderMonthlyView() {
        if (!viewMonthlyEl) return;

        const base = new Date();
        base.setDate(1);
        base.setMonth(base.getMonth() + monthOffset);
        base.setHours(0,0,0,0);

        const month = base.getMonth();
        const year = base.getFullYear();

        const firstWeekday = (base.getDay() + 6) % 7; // Mon=0
        const gridStart = new Date(base);
        gridStart.setDate(1 - firstWeekday);

        const cells = Array.from({ length: 42 }, (_, i) => {
          const d = new Date(gridStart);
          d.setDate(gridStart.getDate() + i);
          return d;
        });

        const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

        viewMonthlyEl.innerHTML = `
          <div class="council-calendar">
            <div class="council-calendar-head flex items-center justify-between px-4 py-3">
              <button id="council-month-prev" class="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-xs text-slate-300">←</button>
              <p class="text-sm font-semibold text-white">${base.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
              <button id="council-month-next" class="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-xs text-slate-300">→</button>
            </div>
            <div class="council-grid-7">
              ${dayNames.map(n => `<div class="council-day-name">${n}</div>`).join("")}
            </div>
            <div class="council-grid-7">
              ${cells.map(day => {
                const isOutside = day.getMonth() !== month;
                const events = sessions.filter(s => asDate(s.meeting_at).toDateString() === day.toDateString());
                const chips = events.slice(0,2).map(e => `<div class="council-event-chip" data-open-id="${esc(e.id)}">${esc(e.title.slice(0, 24))}</div>`).join("");
                const more = events.length > 2 ? `<div class="text-[10px] text-slate-500">+${events.length - 2} more</div>` : "";
                return `
                  <div class="council-month-cell ${isOutside ? "outside" : ""}">
                    <div class="council-day-label">${day.getDate()}</div>
                    ${chips}
                    ${more}
                  </div>`;
              }).join("")}
            </div>
          </div>`;

        document.getElementById("council-month-prev")?.addEventListener("click", () => { monthOffset -= 1; renderMonthlyView(); });
        document.getElementById("council-month-next")?.addEventListener("click", () => { monthOffset += 1; renderMonthlyView(); });
      }

      // ── Detail view ───────────────────────────────────────────────────────
      function renderTranscriptCards(runMessages, fallbackTranscript) {
        if (Array.isArray(runMessages) && runMessages.length > 0) {
          return runMessages.map((msg) => {
            const slug = msg.agent_slug || "system";
            const color = slug === "system" ? "#94a3b8" : agentColor(slug);
            const speaker = slug === "system" ? "System" : participantDisplay(slug);
            return `
              <div class="council-transcript-card" style="border-left:3px solid ${color};">
                <div class="flex items-center justify-between gap-2">
                  <p class="council-speaker-label" style="color:${color};">${esc(speaker)}</p>
                  <span class="text-[10px] text-slate-500">${esc(msg.role || "agent")}</span>
                </div>
                <p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-200">${esc(msg.content || "")}</p>
                <p class="mt-1 text-[10px] text-slate-500">${esc(fmtDateTime(msg.created_at))}</p>
              </div>`;
          }).join("");
        }

        const transcript = Array.isArray(fallbackTranscript) ? fallbackTranscript : [];
        if (!transcript.length) {
          return '<div class="council-transcript-card text-xs text-slate-500">No transcript blocks yet.</div>';
        }

        return transcript.map((item) => {
          const color = agentColor(item.speaker || "");
          return `
            <div class="council-transcript-card" style="border-left:3px solid ${color};">
              <div class="flex items-center justify-between gap-2">
                <p class="council-speaker-label" style="color:${color};">${esc(participantDisplay(item.speaker || "Unknown"))}</p>
                <span class="text-[10px] text-slate-500">${esc(item.role || "agent")}</span>
              </div>
              <p class="mt-1 text-xs leading-relaxed text-slate-200">${esc(item.text || "")}</p>
            </div>`;
        }).join("");
      }

      function renderDetail(session) {
        if (!detailContentEl) return;

        const slugs = participantsFromSession(session);
        const participantsHtml = slugs.map((slug) => {
          const color = agentColor(slug);
          return `<span class="council-tag" style="border-color:${color}66;color:${color};" title="${esc(slug)}">${esc(agentEmoji(slug))} ${esc(participantDisplay(slug))}</span>`;
        }).join("");

        const runId = String(session.last_run_id || "");
        const run = runId ? (runsById.get(runId) || null) : null;
        const runStatus = run?.status || session.run_status || "idle";
        const runMeta = runStatusMeta(runStatus);
        const runMessages = runId ? (messagesByRun.get(runId) || []) : [];
        const participantStates = runId ? (participantStatesByRun.get(runId) || []) : [];
        const isRunning = ["queued", "running"].includes(String(runStatus).toLowerCase());

        const unsyncedRuns = readJson(LOCAL_UNSYNCED_RUNS_KEY, []);
        const needsSync = runId ? (Array.isArray(unsyncedRuns) && unsyncedRuns.includes(runId)) : false;

        detailContentEl.innerHTML = `
          <article class="council-card p-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="text-lg font-bold text-white">${esc(session.title)}</h3>
                <p class="mt-1 text-xs text-slate-400">${esc(fmtDateTime(session.meeting_at))}</p>
                <p class="mt-1 text-xs text-slate-300">Topic: ${esc(topicFromSession(session) || "(missing)")}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full border px-2 py-1 text-[11px] font-semibold ${runMeta.klass}">${esc(runMeta.label)}</span>
                <button id="council-start-run-btn" class="rounded-lg border border-emerald-400/35 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300 ${isRunning ? "opacity-40 cursor-not-allowed" : ""}" ${isRunning ? "disabled" : ""}>▶ Start Council Run</button>
                <button id="council-stop-run-btn" class="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300 ${!isRunning ? "opacity-40 cursor-not-allowed" : ""}" ${!isRunning ? "disabled" : ""}>⏹ Stop Run</button>
                <button id="council-sync-run-btn" class="rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-300 ${!runId ? "opacity-40 cursor-not-allowed" : ""}" ${!runId ? "disabled" : ""}>⟳ Sync</button>
                <button id="council-delete-session-btn" class="rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-1 text-[11px] font-semibold text-rose-300">🗑 Delete Session</button>
              </div>
            </div>

            <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div class="rounded-xl border border-white/10 bg-slate-900/45 p-3">
                <p class="text-[10px] uppercase tracking-wider text-slate-500">Run ID</p>
                <p class="mt-1 break-all font-mono text-[11px] text-slate-200">${esc(runId || "—")}</p>
              </div>
              <div class="rounded-xl border border-white/10 bg-slate-900/45 p-3">
                <p class="text-[10px] uppercase tracking-wider text-slate-500">Started</p>
                <p class="mt-1 text-[11px] text-slate-200">${esc(session.run_started_at ? fmtDateTime(session.run_started_at) : "—")}</p>
              </div>
              <div class="rounded-xl border border-white/10 bg-slate-900/45 p-3">
                <p class="text-[10px] uppercase tracking-wider text-slate-500">Finished</p>
                <p class="mt-1 text-[11px] text-slate-200">${esc(session.run_finished_at ? fmtDateTime(session.run_finished_at) : "—")}</p>
                ${needsSync ? '<p class="mt-1 text-[10px] text-amber-300">Local changes pending sync</p>' : ""}
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1.5">
              ${participantsHtml || '<span class="text-xs text-slate-500">No participants</span>'}
            </div>

            <div class="mt-3 rounded-xl border border-white/10 bg-slate-900/45 p-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-500">Live Participation</p>
              <div class="mt-2 flex flex-wrap gap-2">
                ${participantStates.length > 0
                  ? participantStates.map((item) => {
                      const meta = runStatusMeta(item.state || "idle");
                      return `<span class="rounded-full border px-2 py-1 text-[11px] font-semibold ${meta.klass}" title="${esc(item.details || "")}">${esc(participantDisplay(item.agent_slug || item.participant || "Unknown"))}: ${esc(meta.label)}</span>`;
                    }).join("")
                  : '<span class="text-xs text-slate-500">No live participant states yet.</span>'}
              </div>
            </div>

            <div class="mt-4 rounded-xl border border-white/10 bg-slate-900/45 p-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-500">Summary / Notes</p>
              <p class="mt-1 text-sm text-slate-200">${esc(session.notes || "No summary provided.")}</p>
            </div>

            <div class="mt-4 space-y-2.5">
              ${renderTranscriptCards(runMessages, session.transcript)}
            </div>
          </article>`;

        document.getElementById("council-start-run-btn")?.addEventListener("click", () => startCouncilRun(session.id));
        document.getElementById("council-stop-run-btn")?.addEventListener("click", () => stopCouncilRun(session.id));
        document.getElementById("council-sync-run-btn")?.addEventListener("click", () => manualSyncSessionRun(session.id));
        document.getElementById("council-delete-session-btn")?.addEventListener("click", () => deleteCouncilSession(session.id));
      }

      async function openDetail(sessionId) {
        const session = sessions.find((x) => String(x.id) === String(sessionId));
        if (!session || !detailPanelEl || !detailContentEl) return;

        selectedSessionId = String(session.id);

        viewListEl?.classList.add("hidden");
        viewWeeklyEl?.classList.add("hidden");
        viewMonthlyEl?.classList.add("hidden");
        detailPanelEl.classList.remove("hidden");

        await loadRunArtifactsForSession(session);
        renderDetail(session);
      }

      async function startCouncilRun(sessionId) {
        const session = sessions.find((x) => String(x.id) === String(sessionId));
        if (!session) return;

        const topic = topicFromSession(session);
        const participants = participantsFromSession(session);

        if (!topic) {
          window.alert("Council run requires a topic. Add notes/topic first.");
          return;
        }

        if (participants.length < 2) {
          window.alert("Council run requires at least 2 participants.");
          return;
        }

        if (["queued", "running"].includes(String(session.run_status || "").toLowerCase())) {
          window.alert("A run is already in progress for this session.");
          return;
        }

        try {
          const response = await fetch("/api/council/run/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: session.id,
              title: session.title,
              topic,
              notes: session.notes || "",
              participants,
              participant_bindings: session.participant_bindings || [],
              meeting_at: session.meeting_at,
            }),
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload?.ok || !payload?.run?.id) {
            throw new Error(payload?.error?.message || `Council start failed (${response.status})`);
          }

          const runId = String(payload.run.id);
          const startedAt = String(payload.run.created_at || nowIso());

          const run = {
            id: runId,
            session_id: session.id,
            status: String(payload.run.status || "queued"),
            started_at: startedAt,
            ended_at: null,
            created_by: "dashboard",
            error: null,
          };
          runsById.set(runId, run);
          await upsertRunRecord(run);

          session.last_run_id = runId;
          session.run_status = run.status;
          session.run_started_at = startedAt;
          session.run_finished_at = "";
          session.participant_bindings = (session.participant_bindings || []).map((binding) => ({ ...binding, session_key: runId }));

          await updateSessionState(session.id, {
            last_run_id: runId,
            run_status: run.status,
            run_started_at: startedAt,
            run_finished_at: null,
            participant_bindings: session.participant_bindings,
          });

          participantStatesByRun.set(
            runId,
            participants.map((slug) => ({
              agent_slug: slug,
              participant: participantDisplay(slug),
              state: "waiting",
              details: "Queued",
              session_key: "",
              created_at: nowIso(),
            })),
          );

          startCouncilEventStream(runId, session.id);
          renderDetail(session);
        } catch (err) {
          window.alert(err?.message || "Failed to start council run.");
        }
      }

      async function stopCouncilRun(sessionId) {
        const session = sessions.find((x) => String(x.id) === String(sessionId));
        if (!session) return;

        const runId = String(session.last_run_id || "");
        if (!runId) return;

        try {
          const response = await fetch("/api/council/run/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ run_id: runId }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error?.message || `Council stop failed (${response.status})`);
          }

          await insertRunMessage({
            id: generateUuid(),
            run_id: runId,
            agent_slug: "system",
            role: "system",
            content: "Run stop requested.",
            created_at: nowIso(),
          });

          const run = runsById.get(runId);
          if (run && !["completed", "failed", "stopped"].includes(String(run.status || "").toLowerCase())) {
            run.status = "stopped";
            run.ended_at = nowIso();
            runsById.set(runId, run);
          }

          session.run_status = "stopped";
          session.run_finished_at = nowIso();
          await updateSessionState(session.id, {
            run_status: "stopped",
            run_finished_at: session.run_finished_at,
          });

          closeCouncilEventStream(runId);
          renderDetail(session);
        } catch (err) {
          window.alert(err?.message || "Failed to stop council run.");
        }
      }

      async function manualSyncSessionRun(sessionId) {
        const session = sessions.find((x) => String(x.id) === String(sessionId));
        if (!session) return;

        const runId = String(session.last_run_id || "");
        if (!runId) {
          window.alert("No run to sync for this session.");
          return;
        }

        const result = await syncRunToSupabase(runId);
        if (!result.ok) {
          window.alert(`Sync failed: ${result.reason}`);
          return;
        }

        await loadRunArtifactsForSession(session);
        renderDetail(session);
      }

      function closeDeleteModal(confirmed = false) {
        if (!deleteModalEl) return;
        deleteModalEl.classList.add("hidden");
        deleteModalEl.classList.remove("flex");
        if (typeof deleteConfirmResolver === "function") {
          const resolve = deleteConfirmResolver;
          deleteConfirmResolver = null;
          resolve(Boolean(confirmed));
        }
      }

      function askDeleteConfirmation(sessionTitle) {
        if (!deleteModalEl || !deleteModalTextEl) {
          return Promise.resolve(window.confirm(`Delete session "${sessionTitle}"? This cannot be undone.`));
        }

        if (typeof deleteConfirmResolver === "function") {
          const pendingResolve = deleteConfirmResolver;
          deleteConfirmResolver = null;
          pendingResolve(false);
        }

        deleteModalTextEl.textContent = `Delete session "${sessionTitle}"? This cannot be undone.`;
        deleteModalEl.classList.remove("hidden");
        deleteModalEl.classList.add("flex");

        return new Promise((resolve) => {
          deleteConfirmResolver = resolve;
        });
      }

      async function deleteCouncilSession(sessionId) {
        const session = sessions.find((x) => String(x.id) === String(sessionId));
        if (!session) return;

        const confirmDelete = await askDeleteConfirmation(session.title || "Untitled session");
        if (!confirmDelete) return;

        const runIds = new Set();
        if (session.last_run_id) runIds.add(String(session.last_run_id));

        // Local cleanup first so UI responds instantly.
        sessions = sessions.filter((s) => String(s.id) !== String(sessionId));
        saveLocalSessions();

        runIds.forEach((runId) => {
          runsById.delete(runId);
          messagesByRun.delete(runId);
          localStorage.removeItem(localRunKey(runId));
          localStorage.removeItem(localMessagesKey(runId));
          clearRunUnsynced(runId);
          activeRunControllers.delete(runId);
        });

        if (selectedSessionId && String(selectedSessionId) === String(sessionId)) {
          closeDetail();
        }

        renderAll();

        if (!supabaseClient || usingLocalStore || !isUuid(session.id)) {
          return;
        }

        // Remove remote artifacts (messages -> runs -> session)
        let remoteError = null;
        const runLookup = await supabaseClient
          .from(COUNCIL_RUNS_TABLE)
          .select("id")
          .eq("session_id", session.id);

        if (!runLookup.error && Array.isArray(runLookup.data)) {
          runLookup.data.forEach((row) => {
            if (row?.id) runIds.add(String(row.id));
          });
        }

        const runIdList = Array.from(runIds).filter(Boolean);

        if (runIdList.length > 0) {
          const msgDelete = await supabaseClient
            .from(COUNCIL_MESSAGES_TABLE)
            .delete()
            .in("run_id", runIdList);
          if (msgDelete.error && !remoteError) remoteError = msgDelete.error;
        }

        const runDelete = await supabaseClient
          .from(COUNCIL_RUNS_TABLE)
          .delete()
          .eq("session_id", session.id);
        if (runDelete.error && !remoteError) remoteError = runDelete.error;

        const sessionDelete = await supabaseClient
          .from(COUNCIL_TABLE)
          .delete()
          .eq("id", session.id);
        if (sessionDelete.error && !remoteError) remoteError = sessionDelete.error;

        if (remoteError) {
          window.alert(`Deleted locally, but cloud delete had an issue: ${remoteError.message || "unknown error"}`);
        }
      }

      function closeDetail() {
        selectedSessionId = null;
        detailPanelEl?.classList.add("hidden");
        renderActiveView();
      }

      // ── Active view switch ────────────────────────────────────────────────
      function renderActiveView() {
        if (!detailPanelEl?.classList.contains("hidden")) return;

        viewListEl?.classList.toggle("hidden", activeView !== "list");
        viewWeeklyEl?.classList.toggle("hidden", activeView !== "weekly");
        viewMonthlyEl?.classList.toggle("hidden", activeView !== "monthly");

        viewBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.view === activeView));

        if (activeView === "list") renderListView();
        if (activeView === "weekly") renderWeeklyView();
        if (activeView === "monthly") renderMonthlyView();
      }

      function renderAll() {
        sortSessions();
        renderStats();
        renderListView();
        renderWeeklyView();
        renderMonthlyView();
        renderActiveView();
      }

      // ── Modal / create session ────────────────────────────────────────────
      function renderParticipantPicker() {
        if (!participantPickerEl) return;
        participantPickerEl.innerHTML = CEIL_AGENTS.map(agent => {
          const active = selectedParticipants.has(agent.name);
          const slug = toParticipantSlug(agent.name) || "unmapped";
          return `<button type="button" class="council-pill-toggle ${active ? "active" : ""}" data-participant="${esc(agent.name)}" data-slug="${esc(slug)}">${agent.emoji} ${esc(agent.name)}</button>`;
        }).join("");

        participantPickerEl.querySelectorAll(".council-pill-toggle").forEach(btn => {
          btn.addEventListener("click", () => {
            const name = btn.dataset.participant;
            if (!name) return;
            if (selectedParticipants.has(name)) selectedParticipants.delete(name);
            else selectedParticipants.add(name);
            btn.classList.toggle("active", selectedParticipants.has(name));
          });
        });
      }

      function openModal() {
        if (!modalEl) return;
        titleInputEl.value = "";
        dateInputEl.value = toInputDate(new Date());
        timeInputEl.value = toInputTime(new Date());
        notesInputEl.value = "";
        selectedParticipants = new Set(["Workspace Orchestrator", "Workspace Manager", "Senku Ishigami"]);
        renderParticipantPicker();
        modalEl.classList.remove("hidden");
        modalEl.classList.add("flex");
      }

      function closeModal() {
        if (!modalEl) return;
        modalEl.classList.add("hidden");
        modalEl.classList.remove("flex");
      }

      async function createSession() {
        const title = titleInputEl.value.trim();
        if (!title) {
          titleInputEl.focus();
          return;
        }

        const d = dateInputEl.value;
        const t = timeInputEl.value || "09:00";
        const meetingAt = new Date(`${d}T${t}:00`);
        const participants = [...selectedParticipants].map(toParticipantSlug).filter(Boolean);
        const topic = notesInputEl.value.trim() || title;

        const bindings = participants.map((slug) => ({
          participant: participantDisplay(slug),
          agent_slug: slug,
          session_label: slug,
          session_key: "",
        }));

        const newSession = normalizeSession({
          id: generateUuid(),
          title,
          topic,
          meeting_at: Number.isNaN(meetingAt.getTime()) ? nowIso() : meetingAt.toISOString(),
          participants,
          participant_bindings: bindings,
          notes: notesInputEl.value.trim(),
          transcript: [],
          created_at: nowIso(),
          last_run_id: "",
          run_status: "",
          run_started_at: "",
          run_finished_at: "",
        });

        // Try Supabase first if available
        if (supabaseClient && !usingLocalStore) {
          const payload = {
            title: newSession.title,
            topic: newSession.topic,
            meeting_at: newSession.meeting_at,
            participants: newSession.participants,
            participant_bindings: newSession.participant_bindings,
            notes: newSession.notes,
            transcript: newSession.transcript,
            last_run_id: "",
            run_status: "",
            run_started_at: null,
            run_finished_at: null,
          };

          const extendedSelect = "id, title, topic, meeting_at, participants, participant_bindings, notes, transcript, created_at, last_run_id, run_status, run_started_at, run_finished_at";
          let insertRes = await supabaseClient
            .from(COUNCIL_TABLE)
            .insert([payload])
            .select(extendedSelect)
            .single();

          if (insertRes.error) {
            console.warn("Supabase insert error (extended):", insertRes.error);
            const fallbackPayload = {
              title: newSession.title,
              meeting_at: newSession.meeting_at,
              participants: newSession.participants,
              participant_bindings: newSession.participant_bindings,
              notes: newSession.notes,
              transcript: newSession.transcript,
            };

            insertRes = await supabaseClient
              .from(COUNCIL_TABLE)
              .insert([fallbackPayload])
              .select("id, title, meeting_at, participants, participant_bindings, notes, transcript, created_at")
              .single();
          }

          if (!insertRes.error && insertRes.data) {
            sessions.unshift(normalizeSession(insertRes.data));
            saveLocalSessions();
          } else {
            console.error("Supabase insert failed:", insertRes.error);
            sessions.unshift(newSession);
            saveLocalSessions();
          }
        } else {
          sessions.unshift(newSession);
          saveLocalSessions();
        }

        closeModal();
        renderAll();
      }

      // ── Event wiring ──────────────────────────────────────────────────────
      viewBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          activeView = btn.dataset.view || "list";
          detailPanelEl?.classList.add("hidden");
          renderActiveView();
        });
      });

      newBtnEl?.addEventListener("click", openModal);
      modalCancelEl?.addEventListener("click", closeModal);
      modalEl?.addEventListener("click", e => { if (e.target === modalEl) closeModal(); });
      modalSaveEl?.addEventListener("click", createSession);
      backBtnEl?.addEventListener("click", closeDetail);

      deleteModalCancelEl?.addEventListener("click", () => closeDeleteModal(false));
      deleteModalConfirmEl?.addEventListener("click", () => closeDeleteModal(true));
      deleteModalEl?.addEventListener("click", (e) => {
        if (e.target === deleteModalEl) closeDeleteModal(false);
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && deleteModalEl && !deleteModalEl.classList.contains("hidden")) {
          closeDeleteModal(false);
        }
      });

      document.addEventListener("click", e => {
        const deleteBtn = e.target.closest("[data-delete-id]");
        if (deleteBtn && panelCouncil.contains(deleteBtn)) {
          deleteCouncilSession(deleteBtn.dataset.deleteId);
          return;
        }

        const openBtn = e.target.closest("[data-open-id]");
        if (!openBtn) return;
        if (!panelCouncil.contains(openBtn)) return;
        openDetail(openBtn.dataset.openId);
      });

      // ── Load + hooks ──────────────────────────────────────────────────────
      async function loadCouncil() {
        await loadSessions();
        await syncPendingLocalRuns();
        loaded = true;
        renderAll();

        if (selectedSessionId && !detailPanelEl?.classList.contains("hidden")) {
          await openDetail(selectedSessionId);
        }
      }

      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          if (btn.dataset.tab === "council") setTimeout(loadCouncil, 70);
        });
      });

      if (panelCouncil.classList.contains("active")) {
        setTimeout(loadCouncil, 100);
      }

      if (supabaseClient) {
        supabaseClient
          .channel("council-live")
          .on("postgres_changes", { event: "*", schema: "public", table: COUNCIL_TABLE }, () => {
            if (panelCouncil.classList.contains("active")) {
              setTimeout(loadCouncil, 260);
            }
          })
          .on("postgres_changes", { event: "*", schema: "public", table: COUNCIL_RUNS_TABLE }, () => {
            if (panelCouncil.classList.contains("active") && selectedSessionId) {
              setTimeout(() => openDetail(selectedSessionId), 260);
            }
          })
          .on("postgres_changes", { event: "*", schema: "public", table: COUNCIL_MESSAGES_TABLE }, () => {
            if (panelCouncil.classList.contains("active") && selectedSessionId) {
              setTimeout(() => openDetail(selectedSessionId), 260);
            }
          })
          .subscribe();
      }

    })();
