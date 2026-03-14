const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('org chart today agent_logs query includes fields required for countable-task rollups', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(
    html,
    /from\("agent_logs"\)\s*\.select\("agent_name, task_description, status, created_at"\)\s*\.gte\("created_at", todayISO\)\s*\.limit\(5000\)/,
  );
});
