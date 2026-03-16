(function () {
      "use strict";

      const osListEl = document.getElementById("business-os-list");
      const createBtn = document.getElementById("business-os-create-btn");
      const modalEl = document.getElementById("business-os-modal");
      const modalTitleEl = document.getElementById("bos-modal-title");
      const modalStepEl = document.getElementById("bos-modal-step-label");
      const modalBodyEl = document.getElementById("bos-modal-body");
      const modalFooterEl = document.getElementById("bos-modal-footer");
      const closeBtn = document.getElementById("bos-close-btn");

      if (!osListEl || !createBtn || !modalEl || !modalBodyEl || !modalFooterEl || !modalTitleEl || !modalStepEl) {
        return;
      }

      const BUSINESS_OS_API = "/api/business-os";
      const BUSINESS_OS_PROVISIONING_API = "/api/business-os/provisioning-runs";

      const TEMPLATE_DEFS = [
        {
          id: "app-studio",
          icon: "💻",
          name: "App Studio OS",
          desc: "Build software products with frontend, backend, QA, and DevOps teams.",
          tags: ["Frontend", "Backend", "QA", "DevOps"],
        },
        {
          id: "content-factory",
          icon: "📝",
          name: "Content Factory OS",
          desc: "Produce content at scale with writers, designers, and strategists.",
          tags: ["Content", "Creative", "Strategy"],
        },
        {
          id: "ecom-listing",
          icon: "🛒",
          name: "Ecom Listing OS",
          desc: "Manage product listings, pricing, and inventory operations.",
          tags: ["Listings", "Pricing", "Inventory"],
        },
        {
          id: "local-lead",
          icon: "📍",
          name: "Local Lead Gen OS",
          desc: "Generate and qualify leads for local businesses.",
          tags: ["Outreach", "Follow-up", "Scheduling"],
        },
        {
          id: "paperwork-assassin",
          icon: "📎",
          name: "Paperwork Assassin OS",
          desc: "Review, file, and manage compliance-heavy document workflows.",
          tags: ["Review", "Filing", "Compliance"],
        },
        {
          id: "custom",
          icon: "✨",
          name: "Custom OS",
          desc: "Build your own custom operating system from scratch.",
          tags: ["General"],
        },
      ];

      const PROVISION_STEPS = [
        { title: "Validate Payload", detail: "Checking configuration", routeKey: "coordination" },
        { title: "Scaffold Structure", detail: "Setting up OS framework", routeKey: "provisioning" },
        { title: "Create Manager", detail: "Creating OS manager agent", routeKey: "provisioning" },
        { title: "Create Leadership", detail: "Creating CTO/CMO/CRO roles", routeKey: "coordination" },
        { title: "Create Department Agents", detail: "Spawning specialist agents", routeKey: "provisioning" },
        { title: "Assign Monitor", detail: "Connecting monitoring layer", routeKey: "monitor" },
        { title: "Finalize", detail: "Running final checks", routeKey: "quality" },
        { title: "Ready", detail: "OS is ready to use", routeKey: "workspace-manager" },
      ];

      const DEFAULT_OS = [
        { id: "ceil-os", name: "Ceil OS", template: "custom", status: "Active", color: "#10B981" },
        { id: "growth-os", name: "Growth OS", template: "content-factory", status: "Standby", color: "#6366F1" },
        { id: "operations-os", name: "Operations OS", template: "app-studio", status: "Standby", color: "#06B6D4" },
        { id: "revenue-os", name: "Revenue OS", template: "local-lead", status: "Draft", color: "#F59E0B" },
        { id: "compliance-os", name: "Compliance OS", template: "paperwork-assassin", status: "Draft", color: "#EF4444" },
      ];

      let osList = [];
      let wizard = null;
      let provisionTimer = null;
      let pendingOsId = null;
      let pendingProvisionRunId = null;

      function esc(v) {
        return String(v ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function byId(id) {
        return TEMPLATE_DEFS.find(t => t.id === id) || TEMPLATE_DEFS[TEMPLATE_DEFS.length - 1];
      }

      function resolveRouteOwner(routeKey) {
        const matrix = AGENT_RUNTIME_CONFIG?.routingMatrix || {};
        if (matrix[routeKey]?.primary) return matrix[routeKey].primary;
        if (AGENT_RUNTIME_CONFIG?.canonicalSlugs?.includes(routeKey)) return routeKey;
        return "workspace-manager";
      }

      async function requestBusinessOs(url, options) {
        const response = await fetch(url, {
          headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
          ...options,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = payload?.error?.message || payload?.message || `Business OS request failed (${response.status})`;
          throw new Error(message);
        }
        return payload;
      }

      async function syncProvisioningRun(patch) {
        if (!pendingProvisionRunId) return null;
        return requestBusinessOs(`${BUSINESS_OS_PROVISIONING_API}/${encodeURIComponent(pendingProvisionRunId)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
      }

      async function loadOsList() {
        try {
          const payload = await requestBusinessOs(BUSINESS_OS_API, { method: "GET" });
          const items = Array.isArray(payload?.items) ? payload.items : [];
          osList = items.length ? items : [...DEFAULT_OS];
        } catch (error) {
          console.warn("Failed to load Business OS list; using local defaults.", error);
          osList = [...DEFAULT_OS];
        }
        renderFlyoutList();
      }

      function statusMeta(status) {
        if (status === "Active") return { text: "Active", color: "#6EE7B7" };
        if (status === "Provisioning") return { text: "Provisioning", color: "#67E8F9" };
        if (status === "Draft") return { text: "Draft", color: "#FCD34D" };
        return { text: status || "Standby", color: "#94A3B8" };
      }

      function renderFlyoutList() {
        osListEl.innerHTML = osList.map(item => {
          const meta = statusMeta(item.status);
          return `
            <div class="business-os-item">
              <div class="flex items-center gap-2">
                <span class="business-os-dot" style="background:${item.color || "#64748B"};"></span>
                <div>
                  <p class="text-xs font-semibold text-slate-100">${esc(item.name)}</p>
                  <p class="text-[10px] text-slate-500">${esc(byId(item.template || "custom").name)}</p>
                </div>
              </div>
              <span class="text-[10px] font-semibold" style="color:${meta.color};">${esc(meta.text)}</span>
            </div>`;
        }).join("");
      }

      function syncModalVisibility(isVisible) {
        modalEl.classList.toggle("hidden", !isVisible);
        modalEl.classList.toggle("flex", isVisible);
        modalEl.setAttribute("aria-hidden", isVisible ? "false" : "true");
        if (!isVisible) {
          modalEl.style.display = "none";
          document.body.classList.remove("overflow-hidden");
        } else {
          modalEl.style.display = "flex";
          document.body.classList.add("overflow-hidden");
        }
      }

      function showModal() {
        syncModalVisibility(true);
      }

      function hideModal() {
        syncModalVisibility(false);
      }

      function canCloseWizard() {
        return !(wizard && wizard.step === 4 && wizard.provision && !wizard.provision.done);
      }

      function openWizard() {
        wizard = {
          step: 1,
          templateId: "custom",
          name: "",
          description: "",
          manager: "",
          cto: "",
          cmo: "",
          cro: "",
          provision: null,
        };
        pendingOsId = null;
        pendingProvisionRunId = null;
        renderWizard();
        showModal();
      }

      function closeWizard() {
        if (!canCloseWizard()) return;
        if (provisionTimer) {
          clearInterval(provisionTimer);
          provisionTimer = null;
        }
        wizard = null;
        pendingOsId = null;
        pendingProvisionRunId = null;
        hideModal();
      }

      function setStep(step) {
        if (!wizard) return;
        wizard.step = step;
        renderWizard();
      }

      function renderFooter(actionsHtml) {
        modalFooterEl.innerHTML = actionsHtml;
      }

      function renderStep1() {
        modalTitleEl.textContent = "Choose a Template";
        modalStepEl.textContent = "Step 1 of 3";

        modalBodyEl.innerHTML = `
          <div class="business-os-template-grid">
            ${TEMPLATE_DEFS.map(tpl => `
              <article class="business-os-template-card ${wizard.templateId === tpl.id ? "selected" : ""}" data-template-id="${tpl.id}">
                <div class="flex items-start gap-3">
                  <div class="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-lg">${tpl.icon}</div>
                  <div>
                    <h4 class="text-base font-bold text-white">${esc(tpl.name)}</h4>
                    <p class="mt-0.5 text-xs text-slate-300">${esc(tpl.desc)}</p>
                    <div class="mt-1">
                      ${tpl.tags.map(tag => `<span class="business-os-chip">${esc(tag)}</span>`).join("")}
                    </div>
                  </div>
                </div>
              </article>`).join("")}
          </div>`;

        renderFooter(`
          <button id="bos-cancel-btn" class="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/5">Cancel</button>
          <button id="bos-next-btn" class="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-400">Next →</button>
        `);

        modalBodyEl.querySelectorAll("[data-template-id]").forEach(card => {
          card.addEventListener("click", () => {
            wizard.templateId = card.dataset.templateId;
            renderStep1();
          });
        });

        document.getElementById("bos-cancel-btn")?.addEventListener("click", closeWizard);
        document.getElementById("bos-next-btn")?.addEventListener("click", () => setStep(2));
      }

      function renderStep2() {
        const tpl = byId(wizard.templateId);
        modalTitleEl.textContent = "Name Your OS";
        modalStepEl.textContent = "Step 2 of 3";

        modalBodyEl.innerHTML = `
          <div class="space-y-4">
            <div class="business-os-panel flex items-center justify-between gap-3">
              <div>
                <p class="text-[10px] uppercase tracking-wider text-slate-500">Template</p>
                <p class="text-sm font-semibold text-white">${esc(tpl.name)}</p>
              </div>
              <button id="bos-change-template" class="text-xs font-semibold text-cyan-300 hover:text-cyan-200">Change</button>
            </div>

            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-300">OS Name *</label>
              <input id="bos-name" class="business-os-field" type="text" placeholder="e.g., My App Studio" value="${esc(wizard.name)}" />
            </div>

            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-300">Description</label>
              <textarea id="bos-desc" class="business-os-field resize-none" rows="4" placeholder="What will this OS do?">${esc(wizard.description)}</textarea>
            </div>
          </div>`;

        renderFooter(`
          <button id="bos-back-btn" class="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/5">← Back</button>
          <button id="bos-next-btn" class="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-400">Next →</button>
        `);

        document.getElementById("bos-change-template")?.addEventListener("click", () => setStep(1));
        document.getElementById("bos-back-btn")?.addEventListener("click", () => setStep(1));
        document.getElementById("bos-next-btn")?.addEventListener("click", () => {
          wizard.name = (document.getElementById("bos-name")?.value || "").trim();
          wizard.description = (document.getElementById("bos-desc")?.value || "").trim();
          if (!wizard.name) {
            document.getElementById("bos-name")?.focus();
            return;
          }
          setStep(3);
        });
      }

      function renderStep3() {
        modalTitleEl.textContent = "Assign Leadership";
        modalStepEl.textContent = "Step 3 of 3";

        modalBodyEl.innerHTML = `
          <div class="space-y-4">
            <div class="business-os-panel">
              <p class="text-sm font-semibold text-amber-300">Leadership Team</p>
              <p class="mt-1 text-xs text-slate-300">Manager is required. CTO/CMO/CRO are optional for larger OS setups.</p>
            </div>

            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-300">Manager *</label>
              <input id="bos-manager" class="business-os-field" type="text" placeholder="e.g., Alex" value="${esc(wizard.manager)}" />
              <p class="mt-1 text-[11px] text-slate-500">The OS Manager oversees all operations</p>
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label class="mb-1 block text-xs font-semibold text-slate-300">CTO (optional)</label>
                <input id="bos-cto" class="business-os-field" type="text" placeholder="e.g., Elon" value="${esc(wizard.cto)}" />
              </div>
              <div>
                <label class="mb-1 block text-xs font-semibold text-slate-300">CMO (optional)</label>
                <input id="bos-cmo" class="business-os-field" type="text" placeholder="e.g., Gary" value="${esc(wizard.cmo)}" />
              </div>
              <div>
                <label class="mb-1 block text-xs font-semibold text-slate-300">CRO (optional)</label>
                <input id="bos-cro" class="business-os-field" type="text" placeholder="e.g., Warren" value="${esc(wizard.cro)}" />
              </div>
            </div>
          </div>`;

        renderFooter(`
          <button id="bos-back-btn" class="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/5">← Back</button>
          <button id="bos-create-os-btn" class="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-400">Create OS</button>
        `);

        document.getElementById("bos-back-btn")?.addEventListener("click", () => setStep(2));
        document.getElementById("bos-create-os-btn")?.addEventListener("click", () => {
          wizard.manager = (document.getElementById("bos-manager")?.value || "").trim();
          wizard.cto = (document.getElementById("bos-cto")?.value || "").trim();
          wizard.cmo = (document.getElementById("bos-cmo")?.value || "").trim();
          wizard.cro = (document.getElementById("bos-cro")?.value || "").trim();

          if (!wizard.manager) {
            document.getElementById("bos-manager")?.focus();
            return;
          }

          startProvisioning();
        });
      }

      function addLog(line) {
        if (!wizard || !wizard.provision) return;
        const ts = new Date().toLocaleTimeString();
        wizard.provision.logs.push(`[${ts}] ${line}`);
        if (wizard.provision.logs.length > 120) {
          wizard.provision.logs.shift();
        }
      }

      async function ensurePendingOsEntry() {
        const colorMap = {
          "app-studio": "#6366F1",
          "content-factory": "#EC4899",
          "ecom-listing": "#F59E0B",
          "local-lead": "#10B981",
          "paperwork-assassin": "#8B5CF6",
          "custom": "#06B6D4",
        };

        const generatedId = `os-${Date.now()}`;
        const slug = (wizard.name || "business-os").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || generatedId;
        const selectedAt = new Date().toISOString();
        const created = await requestBusinessOs(BUSINESS_OS_API, {
          method: "POST",
          body: JSON.stringify({
            id: generatedId,
            slug,
            name: wizard.name,
            description: wizard.description,
            template: wizard.templateId,
            template_selection: {
              template_id: wizard.templateId,
              selected_at: selectedAt,
              source: "wizard",
            },
            status: "Provisioning",
            color: colorMap[wizard.templateId] || "#06B6D4",
            workspace_id: generatedId,
            business_id: generatedId,
            manager: wizard.manager,
            cto: wizard.cto,
            cmo: wizard.cmo,
            cro: wizard.cro,
            provisioning: {
              status: "queued",
              progress: 2,
              step: "validate-payload",
              template_id: wizard.templateId,
              deep_research_required: true,
              deep_research_status: "queued",
              last_event_at: selectedAt,
            },
          }),
        });

        const run = await requestBusinessOs(BUSINESS_OS_PROVISIONING_API, {
          method: "POST",
          body: JSON.stringify({
            business_os_id: created.id,
            workspace_id: created.workspace_id || created.id,
            business_id: created.business_id || created.id,
            status: "running",
            progress: 2,
            current_step: "validate-payload",
            template_selection: {
              template_id: wizard.templateId,
              selected_at: selectedAt,
              source: "wizard",
            },
            deep_research: {
              required: true,
              status: "queued",
            },
            wizard_payload: {
              name: wizard.name,
              description: wizard.description,
              manager: wizard.manager,
              leadership: { cto: wizard.cto, cmo: wizard.cmo, cro: wizard.cro },
              slug,
            },
            steps: PROVISION_STEPS.map((step, index) => ({ ...step, state: index === 0 ? "running" : "pending" })),
            logs: [],
          }),
        });

        pendingOsId = created.id;
        pendingProvisionRunId = run.id;
        osList = [created].concat(osList.filter(item => item.id !== created.id));
        renderFlyoutList();
      }

      async function finalizeProvisioning() {
        if (!wizard || !wizard.provision || !pendingOsId) return;
        wizard.provision.done = true;
        wizard.provision.progress = 100;

        try {
          if (pendingProvisionRunId) {
            await syncProvisioningRun({
              status: "completed",
              progress: 100,
              current_step: "ready",
              completed_at: new Date().toISOString(),
              deep_research: { required: true, status: "queued" },
              steps: wizard.provision.steps,
              logs: wizard.provision.logs,
            });
          }
          const updated = await requestBusinessOs(`${BUSINESS_OS_API}/${encodeURIComponent(pendingOsId)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "Active", color: "#10B981" }),
          });
          osList = [updated].concat(osList.filter(item => item.id !== updated.id));
          renderFlyoutList();
        } catch (error) {
          console.warn("Failed to finalize Business OS status.", error);
        }
        renderStep4();
      }

      async function provisionTick() {
        if (!wizard || !wizard.provision) return;
        const p = wizard.provision;

        const runningIdx = p.steps.findIndex(s => s.state === "running");
        if (runningIdx !== -1) {
          p.steps[runningIdx].state = "done";
        }

        if (p.currentIndex < p.steps.length) {
          const step = p.steps[p.currentIndex];
          step.state = "running";
          const ownerSlug = resolveRouteOwner(step.routeKey);
          addLog(`[INFO] ${step.title}... ${step.detail} [owner:${ownerSlug}]`);

          p.progress = Math.max(6, Math.round(((p.currentIndex + 1) / p.steps.length) * 100));
          p.currentIndex += 1;
          if (pendingProvisionRunId) {
            syncProvisioningRun({
              status: p.currentIndex >= p.steps.length ? "running" : "running",
              progress: p.progress,
              current_step: step.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "running",
              steps: p.steps,
              logs: p.logs,
              deep_research: {
                required: true,
                status: p.currentIndex > 1 ? "planned" : "queued",
              },
            }).catch(error => console.warn("Failed to sync provisioning run.", error));
          }
          renderStep4();

          if (p.currentIndex >= p.steps.length) {
            clearInterval(provisionTimer);
            provisionTimer = null;

            setTimeout(() => {
              const last = p.steps[p.steps.length - 1];
              if (last) last.state = "done";
              addLog("[SUCCESS] Provisioning complete. OS is ready to use.");
              finalizeProvisioning();
            }, 850);
          }
        }
      }

      async function startProvisioning() {
        if (!wizard) return;

        wizard.step = 4;
        wizard.provision = {
          progress: 2,
          currentIndex: 0,
          done: false,
          steps: PROVISION_STEPS.map(s => ({ ...s, state: "pending" })),
          logs: [],
        };

        try {
          await ensurePendingOsEntry();
        } catch (error) {
          console.warn("Failed to create Business OS record.", error);
          wizard.provision = null;
          wizard.step = 3;
          pendingProvisionRunId = null;
          renderWizard();
          return;
        }

        addLog("[INFO] Starting OS provisioning sequence...");
        addLog(`[INFO] Failure policy: retries=${AGENT_RUNTIME_CONFIG.failurePolicy.retries}, backoff=${AGENT_RUNTIME_CONFIG.failurePolicy.backoffMs.join("/")}ms, timeout=${AGENT_RUNTIME_CONFIG.failurePolicy.hardTimeoutMs}ms`);
        addLog(`[INFO] Template selected: ${byId(wizard.templateId).name}`);
        addLog("[INFO] Deep research foundation staged for future orchestration.");
        addLog(`[INFO] Manager assigned: ${wizard.manager}`);
        if (wizard.cto || wizard.cmo || wizard.cro) {
          addLog(`[INFO] Leadership payload -> CTO:${wizard.cto || "—"} | CMO:${wizard.cmo || "—"} | CRO:${wizard.cro || "—"}`);
        } else {
          addLog("[INFO] Leadership payload -> Manager only (lean mode)");
        }

        renderStep4();

        provisionTimer = setInterval(() => { provisionTick(); }, 1150);
        setTimeout(() => { provisionTick(); }, 350);
      }

      function renderStep4() {
        if (!wizard || !wizard.provision) return;

        const p = wizard.provision;
        modalTitleEl.textContent = wizard.name || "Provisioning";
        modalStepEl.textContent = p.done ? "Provisioning complete" : "Provisioning in progress";

        modalBodyEl.innerHTML = `
          <div class="space-y-4">
            <div class="business-os-panel">
              <div class="mb-2 flex items-center justify-between">
                <p class="text-sm font-bold text-slate-100">${esc(wizard.name || "New OS")}</p>
                <p class="text-sm font-bold text-emerald-300">${p.progress}%</p>
              </div>
              <div class="business-os-progress-track">
                <div class="business-os-progress-bar" style="width:${p.progress}%;"></div>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div class="business-os-panel">
                <h4 class="mb-2 text-sm font-bold text-white">Provisioning Steps</h4>
                ${p.steps.map((step, i) => {
                  const cls = step.state === "done" ? "done" : step.state === "running" ? "running" : "";
                  const marker = step.state === "done" ? "✓" : step.state === "running" ? "◔" : `${i + 1}`;
                  return `
                    <div class="business-os-provision-step ${cls}">
                      <div class="flex items-start gap-2">
                        <span class="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/20 text-[11px] font-bold text-slate-200">${marker}</span>
                        <div>
                          <p class="text-xs font-semibold text-slate-100">${esc(step.title)}</p>
                          <p class="text-[11px] text-slate-400">${esc(step.detail)}</p>
                          <p class="mt-0.5 text-[10px] text-cyan-300">owner: ${esc(resolveRouteOwner(step.routeKey))}</p>
                        </div>
                      </div>
                    </div>`;
                }).join("")}
              </div>

              <div>
                <h4 class="mb-2 text-sm font-bold text-white">Live Logs</h4>
                <div id="bos-log-box" class="business-os-log-box">
                  ${p.logs.map(line => `<div class="business-os-log-line">${esc(line)}</div>`).join("")}
                </div>
              </div>
            </div>
          </div>`;

        renderFooter(`
          <div></div>
          ${p.done
            ? '<button id="bos-finish-btn" class="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-400">Finish</button>'
            : '<button class="rounded-xl border border-white/15 px-5 py-2 text-sm font-semibold text-slate-400" disabled>Provisioning…</button>'
          }
        `);

        const logBox = document.getElementById("bos-log-box");
        if (logBox) {
          logBox.scrollTop = logBox.scrollHeight;
        }

        document.getElementById("bos-finish-btn")?.addEventListener("click", () => {
          wizard = null;
          pendingOsId = null;
          hideModal();
        });
      }

      function renderWizard() {
        if (!wizard) return;

        if (closeBtn) {
          closeBtn.disabled = !canCloseWizard();
          closeBtn.style.opacity = canCloseWizard() ? "1" : "0.35";
          closeBtn.style.cursor = canCloseWizard() ? "pointer" : "not-allowed";
        }

        if (wizard.step === 1) renderStep1();
        if (wizard.step === 2) renderStep2();
        if (wizard.step === 3) renderStep3();
        if (wizard.step === 4) renderStep4();
      }

      function initializeModalState() {
        wizard = null;
        pendingOsId = null;
        pendingProvisionRunId = null;
        if (provisionTimer) {
          clearInterval(provisionTimer);
          provisionTimer = null;
        }
        syncModalVisibility(false);
      }

      // ── Events ──────────────────────────────────────────────────────────
      createBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openWizard();
      });

      closeBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        closeWizard();
      });
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) {
          closeWizard();
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modalEl.classList.contains("hidden")) {
          closeWizard();
        }
      });

      // initial
      initializeModalState();
      loadOsList();

    })();
