const test = require('node:test');
const assert = require('node:assert/strict');
const dashboardDom = require('../dashboard-dom.js');
const utils = require('../dashboard-utils.js');

function fakeElement({ active = false } = {}) {
  return {
    textContent: '',
    innerHTML: '',
    classList: {
      contains(name) {
        return active && name === 'active';
      },
    },
  };
}

const deps = {
  escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  },
  formatTimestamp(value) {
    return value ? `fmt:${value}` : 'No data yet';
  },
  hexToRgba(hex, alpha) {
    return `rgba(${hex},${alpha})`;
  },
  getAgentMeta(name) {
    return name === 'Senku Ishigami' ? { color: '#EC4899' } : null;
  },
  getStatusBadge(status) {
    return { label: status || 'N/A', klass: 'badge-class' };
  },
};

test('renderAgentsView updates stats, cards, activity, model usage, and triggers stagger when active', () => {
  const refs = {
    statTotalTodayEl: fakeElement(),
    statTotalWeekEl: fakeElement(),
    statMostActiveEl: fakeElement(),
    statSuccessRateEl: fakeElement(),
    agentCardsGridEl: fakeElement(),
    recentActivityEl: fakeElement(),
    modelUsageBodyEl: fakeElement(),
  };

  let staggerCount = 0;
  dashboardDom.renderAgentsView(
    refs,
    {
      totalToday: 3,
      totalWeek: 12,
      mostActive: 'Senku Ishigami (2)',
      successRate: '91.7%',
      agentSummaries: [
        {
          name: 'Senku Ishigami',
          subtitle: 'Scientific Execution',
          emoji: '🧪',
          color: '#EC4899',
          tasksToday: 2,
          latest: {
            model_used: 'gpt-5.4',
            task_description: 'Built DOM smoke layer',
            created_at: '2026-03-08T17:00:00Z',
          },
        },
      ],
      recentLogs: [
        {
          agent_name: 'Senku Ishigami',
          task_description: 'Built DOM smoke layer',
          model_used: 'gpt-5.4',
          status: 'completed',
          created_at: '2026-03-08T17:00:00Z',
        },
      ],
    },
    {
      ...deps,
      getPanelAgents: () => fakeElement({ active: true }),
      staggerActivePanelCards: () => {
        staggerCount += 1;
      },
    },
  );

  assert.equal(refs.statTotalTodayEl.textContent, '3');
  assert.equal(refs.statTotalWeekEl.textContent, '12');
  assert.equal(refs.statMostActiveEl.textContent, 'Senku Ishigami (2)');
  assert.equal(refs.statSuccessRateEl.textContent, '91.7%');
  assert.match(refs.agentCardsGridEl.innerHTML, /Senku Ishigami/);
  assert.match(refs.agentCardsGridEl.innerHTML, /Built DOM smoke layer/);
  assert.match(refs.recentActivityEl.innerHTML, /badge-class/);
  assert.match(refs.modelUsageBodyEl.innerHTML, /gpt-5.4/);
  assert.equal(staggerCount, 1);
});

test('renderRecentActivity and renderModelUsage expose empty states', () => {
  const recentActivityEl = fakeElement();
  const modelUsageBodyEl = fakeElement();

  dashboardDom.renderRecentActivity({ recentActivityEl }, [], deps);
  dashboardDom.renderModelUsage({ modelUsageBodyEl }, [], deps);

  assert.match(recentActivityEl.innerHTML, /No data yet/);
  assert.match(modelUsageBodyEl.innerHTML, /No data yet/);
});

test('renderRecentActivity uses success-colored badges for completion-like statuses', () => {
  for (const status of ['success', 'done', 'resolved', 'PASS']) {
    const recentActivityEl = fakeElement();

    dashboardDom.renderRecentActivity(
      { recentActivityEl },
      [
        {
          agent_name: 'Senku Ishigami',
          task_description: `Handled ${status}`,
          model_used: 'gpt-5.4',
          status,
          created_at: '2026-03-08T17:00:00Z',
        },
      ],
      {
        ...deps,
        getStatusBadge: utils.getStatusBadge,
      },
    );

    assert.match(recentActivityEl.innerHTML, /bg-emerald-500\/20/, `${status} should render as success`);
    assert.match(recentActivityEl.innerHTML, new RegExp(`>\\s*${status}\\s*<`));
  }
});

test('renderOrg populates org metrics and node HTML and wires toggles', () => {
  const refs = {
    orgStatTotalEl: fakeElement(),
    orgStatActiveEl: fakeElement(),
    orgStatSuccessEl: fakeElement(),
    orgStatTasksEl: fakeElement(),
    orgOrchEl: fakeElement(),
    orgManagerEl: fakeElement(),
    orgChiefsEl: fakeElement(),
    orgExecEl: fakeElement(),
  };

  let wired = 0;
  dashboardDom.renderOrg(
    refs,
    {
      CEIL_AGENTS: [{ name: 'Workspace Orchestrator' }, { name: 'Senku Ishigami' }, { name: 'OS Monitor' }],
      TIER2_ORCHESTRATOR: { agentName: 'Workspace Orchestrator' },
      TIER3_MANAGER: { agentName: 'Workspace Manager' },
      TIER4_CHIEFS: [{ agentName: 'Senku Ishigami' }],
      TIER5_EXECUTION: [{ agentName: 'OS Monitor' }],
    },
    new Map([
      ['Workspace Orchestrator', { tasksToday: 1, latest: { model_used: 'gpt-5.4' } }],
      ['Workspace Manager', { tasksToday: 2, latest: { model_used: 'gpt-5.3' } }],
      ['Senku Ishigami', { tasksToday: 3, latest: { model_used: 'gpt-5.4' } }],
      ['OS Monitor', { tasksToday: 1, latest: { model_used: 'gpt-4.1' } }],
    ]),
    { activeToday: 4, successRate: '88.0%', totalToday: 7 },
    {
      buildTier2Node: (def, stats) => `tier2:${def.agentName}:${stats.tasksToday}`,
      buildTier3Node: (def, stats) => `tier3:${def.agentName}:${stats.tasksToday}`,
      buildChiefCard: (def, stats) => `chief:${def.agentName}:${stats.tasksToday}`,
      buildExecCard: (def, stats) => `exec:${def.agentName}:${stats.tasksToday}`,
      wireToggles: () => {
        wired += 1;
      },
    },
  );

  assert.equal(refs.orgStatTotalEl.textContent, '3');
  assert.equal(refs.orgStatActiveEl.textContent, '4');
  assert.equal(refs.orgStatSuccessEl.textContent, '88.0%');
  assert.equal(refs.orgStatTasksEl.textContent, '7');
  assert.match(refs.orgOrchEl.innerHTML, /tier2:Workspace Orchestrator:1/);
  assert.match(refs.orgManagerEl.innerHTML, /tier3:Workspace Manager:2/);
  assert.match(refs.orgChiefsEl.innerHTML, /chief:Senku Ishigami:3/);
  assert.match(refs.orgExecEl.innerHTML, /exec:OS Monitor:1/);
  assert.equal(wired, 1);
});
