const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const utils = require('../dashboard-utils.js');

const AGENTS = [
  {
    name: 'Workspace Manager',
    aliases: ['workspace-manager', 'workspace manager', 'workspace_manager'],
    color: '#4F46E5',
  },
  {
    name: 'Senku Ishigami',
    aliases: ['senku-ishigami', 'senku ishigami', 'senku'],
    color: '#EC4899',
  },
  {
    name: 'Security & Compliance',
    aliases: ['security-compliance', 'security and compliance', 'security/compliance'],
    color: '#EF4444',
  },
];

const RUNTIME_CONFIG = {
  participantToSlug: {
    'Workspace Manager': 'workspace-manager',
    'Senku Ishigami': 'senku-ishigami',
  },
  canonicalSlugs: ['workspace-manager', 'senku-ishigami', 'security-compliance'],
};

test('normalizeAgentName trims, compresses spaces, and lowercases', () => {
  assert.equal(utils.normalizeAgentName('  Senku   Ishigami  '), 'senku ishigami');
});

test('agentSlugFromName respects participant mapping and canonical slugs', () => {
  assert.equal(utils.agentSlugFromName('Workspace Manager', RUNTIME_CONFIG), 'workspace-manager');
  assert.equal(utils.agentSlugFromName('Security / Compliance', RUNTIME_CONFIG), 'security-compliance');
  assert.equal(utils.agentSlugFromName('Unknown Agent', RUNTIME_CONFIG), null);
});

test('sessionLabelForName falls back to normalized hyphenated label', () => {
  assert.equal(utils.sessionLabelForName('New Agent Name', RUNTIME_CONFIG), 'new-agent-name');
});

test('escapeHtml escapes critical characters', () => {
  assert.equal(utils.escapeHtml(`<'\"&>`), '&lt;&#39;&quot;&amp;&gt;');
});

test('hexToRgba converts hex and falls back for invalid input', () => {
  assert.equal(utils.hexToRgba('#ffffff', 0.5), 'rgba(255, 255, 255, 0.5)');
  assert.equal(utils.hexToRgba('#fff', 0.3), 'rgba(124,58,237,0.3)');
});

test('createAgentResolver matches direct aliases and fuzzy log names', () => {
  const resolver = utils.createAgentResolver(AGENTS);
  assert.equal(resolver.resolveAgentFromLogName('senku-ishigami').name, 'Senku Ishigami');
  assert.equal(resolver.resolveAgentFromLogName('nightly run by workspace-manager').name, 'Workspace Manager');
  assert.equal(resolver.getAgentMeta('security/compliance').name, 'Security & Compliance');
  assert.equal(resolver.resolveAgentFromLogName('totally unknown'), null);
});

test('getStatusBadge classifies failed, completion-like, and fallback states', () => {
  assert.equal(utils.getStatusBadge('failed').label, 'failed');
  assert.match(utils.getStatusBadge('failed').klass, /red/);
  assert.match(utils.getStatusBadge('completed').klass, /emerald/);

  for (const status of ['success', 'done', 'resolved', 'PASS']) {
    assert.match(
      utils.getStatusBadge(status).klass,
      /emerald/,
      `${status} should render with a success badge`,
    );
  }

  assert.match(utils.getStatusBadge('queued').klass, /slate/);
});

test('startOfTodayISO and startOfWeekISO reset to local day/week boundaries', () => {
  const input = new Date('2026-03-08T15:22:11.000Z');
  const today = new Date(utils.startOfTodayISO(input));
  const week = new Date(utils.startOfWeekISO(input));

  assert.equal(today.getHours(), 0);
  assert.equal(today.getMinutes(), 0);
  assert.equal(today.getSeconds(), 0);
  assert.equal(today.getMilliseconds(), 0);
  assert.equal(today.getFullYear(), input.getFullYear());
  assert.equal(today.getMonth(), input.getMonth());
  assert.equal(today.getDate(), input.getDate());

  assert.equal(week.getHours(), 0);
  assert.equal(week.getMinutes(), 0);
  assert.equal(week.getSeconds(), 0);
  assert.equal(week.getMilliseconds(), 0);
  assert.equal(week.getDay(), 1);
});

test('housekeeping and completion helpers classify tasks correctly', () => {
  assert.equal(utils.isHousekeepingTask({ task_description: 'Heartbeat check' }), true);
  assert.equal(utils.isCompletedLikeStatus('resolved'), true);
  assert.equal(utils.isCompletedLikeStatus('PASS'), true);
  assert.equal(utils.isCompletedLikeStatus('running'), false);
  assert.equal(
    utils.isCountableTask({ task_description: 'Build dashboard widgets', status: 'completed' }),
    true,
  );
  assert.equal(
    utils.isCountableTask({ task_description: 'Build dashboard widgets', status: 'done' }),
    true,
  );
  assert.equal(
    utils.isCountableTask({ task_description: 'Supabase logging smoke test', status: 'completed' }),
    false,
  );
});


test('completion query clause covers shared completion-like status tokens', () => {
  assert.deepEqual(utils.getCompletedLikeStatusTokens(), ['complete', 'success', 'done', 'resolved', 'pass']);
  assert.equal(
    utils.getCompletedLikeStatusOrClause('status'),
    'status.ilike.%complete%,status.ilike.%success%,status.ilike.%done%,status.ilike.%resolved%,status.ilike.%pass%',
  );
});

test('formatTimestamp returns fallback for empty or invalid values', () => {
  assert.equal(utils.formatTimestamp(''), 'No data yet');
  assert.equal(utils.formatTimestamp('not-a-date'), 'No data yet');
});

test('Toronto runtime keeps day/week boundary helpers aligned across DST', () => {
  const script = `
    const assert = require('node:assert/strict');
    const utils = require('./dashboard-utils.js');
    const input = new Date('2026-03-08T16:22:11.000Z');
    const today = new Date(utils.startOfTodayISO(input));
    const week = new Date(utils.startOfWeekISO(input));
    assert.equal(today.toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(week.toISOString(), '2026-03-02T05:00:00.000Z');
    console.log(JSON.stringify({ today: today.toISOString(), week: week.toISOString() }));
  `;

  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, TZ: 'America/Toronto' },
    encoding: 'utf8',
  });

  const parsed = JSON.parse(output.trim());
  assert.deepEqual(parsed, {
    today: '2026-03-08T05:00:00.000Z',
    week: '2026-03-02T05:00:00.000Z',
  });
});
