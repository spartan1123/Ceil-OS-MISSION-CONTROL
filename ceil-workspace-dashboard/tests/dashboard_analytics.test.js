const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('../dashboard-analytics.js');
const utils = require('../dashboard-utils.js');

const AGENTS = [
  { name: 'Workspace Manager', emoji: '🧭' },
  { name: 'Senku Ishigami', emoji: '🧪' },
  { name: 'Security & Compliance', emoji: '🛡️' },
];

const resolver = utils.createAgentResolver([
  { name: 'Workspace Manager', aliases: ['workspace-manager', 'workspace manager'] },
  { name: 'Senku Ishigami', aliases: ['senku-ishigami', 'senku'] },
  { name: 'Security & Compliance', aliases: ['security-compliance', 'security/compliance'] },
]);

test('buildDefaultAgentSummaries seeds agents with null latest and zero tasks', () => {
  const rows = analytics.buildDefaultAgentSummaries(AGENTS);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].latest, null);
  assert.equal(rows[0].tasksToday, 0);
});

test('chooseLatestMeaningfulEntry upgrades housekeeping entries to meaningful entries', () => {
  const current = { task_description: 'Heartbeat check' };
  const candidate = { task_description: 'Build dashboard analytics layer' };
  const chosen = analytics.chooseLatestMeaningfulEntry(current, candidate, utils.isHousekeepingTask);
  assert.equal(chosen, candidate);
});

test('computeSuccessRate formats percentage and handles empty totals', () => {
  assert.equal(analytics.computeSuccessRate(10, 7), '70.0%');
  assert.equal(analytics.computeSuccessRate(0, 0), 'N/A');
});

test('formatMostActive returns formatted winner or N/A', () => {
  assert.equal(
    analytics.formatMostActive([
      { name: 'Workspace Manager', tasksToday: 1 },
      { name: 'Senku Ishigami', tasksToday: 3 },
    ]),
    'Senku Ishigami (3)',
  );
  assert.equal(analytics.formatMostActive([{ name: 'Workspace Manager', tasksToday: 0 }]), 'N/A');
});

test('summarizeAgentLogsForAgents aggregates latest meaningful entry and countable tasks', () => {
  const summary = analytics.summarizeAgentLogsForAgents({
    agents: AGENTS,
    latestEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Heartbeat', model_used: 'x', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Shipped analytics extraction', model_used: 'x', status: 'completed', created_at: '2026-03-08T09:00:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Coordinated deployment', model_used: 'y', status: 'completed', created_at: '2026-03-08T11:00:00Z' },
    ],
    todayEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Shipped analytics extraction', status: 'completed', created_at: '2026-03-08T09:00:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Heartbeat', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Coordinated deployment', status: 'success', created_at: '2026-03-08T11:00:00Z' },
      { agent_name: 'security-compliance', task_description: 'Policy sync', status: 'running', created_at: '2026-03-08T11:30:00Z' },
    ],
    todayTotalRows: 4,
    weekTotalCount: 12,
    weekSuccessCount: 9,
    resolveAgentFromLogName: resolver.resolveAgentFromLogName,
    isCountableTask: utils.isCountableTask,
    isHousekeepingTask: utils.isHousekeepingTask,
    normalizeAgentName: utils.normalizeAgentName,
  });

  const senku = summary.agentSummaries.find((agent) => agent.name === 'Senku Ishigami');
  const manager = summary.agentSummaries.find((agent) => agent.name === 'Workspace Manager');
  const security = summary.agentSummaries.find((agent) => agent.name === 'Security & Compliance');

  assert.equal(summary.totalToday, 2);
  assert.equal(summary.totalWeek, 12);
  assert.equal(summary.successfulWeek, 9);
  assert.equal(summary.successRate, '75.0%');
  assert.equal(summary.mostActive, 'Workspace Manager (1)');
  assert.equal(senku.latest.task_description, 'Shipped analytics extraction');
  assert.equal(senku.tasksToday, 1);
  assert.equal(manager.tasksToday, 1);
  assert.equal(security.tasksToday, 0);
  assert.deepEqual(summary.unmatchedTodayNames, []);
});

test('summarizeAgentLogsForAgents reports unmatched names when rows exist but none map countably', () => {
  const summary = analytics.summarizeAgentLogsForAgents({
    agents: AGENTS,
    latestEntries: [],
    todayEntries: [
      { agent_name: 'unknown-bot', task_description: 'Completed mystery work', status: 'completed', created_at: '2026-03-08T09:00:00Z' },
    ],
    todayTotalRows: 1,
    weekTotalCount: 1,
    weekSuccessCount: 1,
    resolveAgentFromLogName: resolver.resolveAgentFromLogName,
    isCountableTask: utils.isCountableTask,
    isHousekeepingTask: utils.isHousekeepingTask,
    normalizeAgentName: utils.normalizeAgentName,
  });

  assert.equal(summary.totalToday, 0);
  assert.deepEqual(summary.unmatchedTodayNames, ['unknown-bot']);
});

test('buildOrgChartStats returns per-agent stats and derived metrics', () => {
  const org = analytics.buildOrgChartStats({
    agents: AGENTS,
    latestEntries: [
      { agent_name: 'senku-ishigami', model_used: 'x', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'workspace-manager', model_used: 'y', status: 'completed', created_at: '2026-03-08T11:00:00Z' },
    ],
    todayEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Shipped', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Heartbeat', status: 'completed', created_at: '2026-03-08T10:30:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Coordinated', status: 'success', created_at: '2026-03-08T11:00:00Z' },
    ],
    weekTotalCount: 8,
    weekSuccessCount: 6,
    resolveAgentFromLogName: resolver.resolveAgentFromLogName,
    isCountableTask: utils.isCountableTask,
  });

  assert.equal(org.metrics.activeToday, 2);
  assert.equal(org.metrics.totalToday, 2);
  assert.equal(org.metrics.totalWeek, 8);
  assert.equal(org.metrics.successRate, '75.0%');
  assert.equal(org.statsByName.get('Senku Ishigami').tasksToday, 1);
  assert.equal(org.statsByName.get('Workspace Manager').latest.model_used, 'y');
});

test('buildOrgChartStats keeps housekeeping out of totals and leaves zero-task agents on standby', () => {
  const org = analytics.buildOrgChartStats({
    agents: AGENTS,
    latestEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Heartbeat', model_used: 'gpt-heartbeat', status: 'completed', created_at: '2026-03-08T10:30:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Ship org chart fix', model_used: 'gpt-ship', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Coordinate release', model_used: 'gpt-manage', status: 'completed', created_at: '2026-03-08T11:00:00Z' },
    ],
    todayEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Ship org chart fix', status: 'completed', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Heartbeat', status: 'completed', created_at: '2026-03-08T10:30:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Coordinate release', status: 'success', created_at: '2026-03-08T11:00:00Z' },
      { agent_name: 'security-compliance', task_description: 'Supabase logging smoke test', status: 'completed', created_at: '2026-03-08T11:30:00Z' },
      { agent_name: 'security-compliance', task_description: 'Policy review still running', status: 'running', created_at: '2026-03-08T11:45:00Z' },
    ],
    weekTotalCount: 10,
    weekSuccessCount: 7,
    resolveAgentFromLogName: resolver.resolveAgentFromLogName,
    isCountableTask: utils.isCountableTask,
  });

  const senku = org.statsByName.get('Senku Ishigami');
  const manager = org.statsByName.get('Workspace Manager');
  const security = org.statsByName.get('Security & Compliance');

  assert.equal(senku.tasksToday, 1);
  assert.equal(manager.tasksToday, 1);
  assert.equal(security.tasksToday, 0);
  assert.equal(org.metrics.totalToday, 2);
  assert.equal(org.metrics.activeToday, 2);
  assert.equal(senku.tasksToday > 0, true);
  assert.equal(security.tasksToday > 0, false);
  assert.equal(senku.latest.model_used, 'gpt-heartbeat');
  assert.equal(manager.latest.model_used, 'gpt-manage');
});


test('completion-like statuses stay countable across analytics rollups', () => {
  const summary = analytics.summarizeAgentLogsForAgents({
    agents: AGENTS,
    latestEntries: [],
    todayEntries: [
      { agent_name: 'senku-ishigami', task_description: 'Ship PASS fix', status: 'PASS', created_at: '2026-03-08T08:00:00Z' },
      { agent_name: 'workspace-manager', task_description: 'Wrap rollout', status: 'done', created_at: '2026-03-08T09:00:00Z' },
      { agent_name: 'security-compliance', task_description: 'Close review', status: 'resolved', created_at: '2026-03-08T10:00:00Z' },
      { agent_name: 'senku-ishigami', task_description: 'Ship follow-up', status: 'completed', created_at: '2026-03-08T11:00:00Z' },
    ],
    todayTotalRows: 4,
    weekTotalCount: 6,
    weekSuccessCount: 4,
    resolveAgentFromLogName: resolver.resolveAgentFromLogName,
    isCountableTask: utils.isCountableTask,
    isHousekeepingTask: utils.isHousekeepingTask,
    normalizeAgentName: utils.normalizeAgentName,
  });

  assert.equal(summary.totalToday, 4);
  assert.equal(summary.successRate, '66.7%');
  assert.equal(summary.mostActive, 'Senku Ishigami (2)');
  assert.equal(summary.agentSummaries.find((agent) => agent.name === 'Senku Ishigami').tasksToday, 2);
  assert.equal(summary.agentSummaries.find((agent) => agent.name === 'Workspace Manager').tasksToday, 1);
  assert.equal(summary.agentSummaries.find((agent) => agent.name === 'Security & Compliance').tasksToday, 1);
});
