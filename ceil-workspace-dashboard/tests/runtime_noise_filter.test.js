const test = require("node:test");
const assert = require("node:assert/strict");
const missionQueue = require("../dashboard-mission-queue.js");

test("filterTasks excludes runtime-derived synthetic tasks", () => {
  const tasks = [
    { id: "1", title: "Real task", status: "planning" },
    { id: "2", title: "Runtime derived", runtime_derived: true, status: "in_progress" },
    { id: "3", title: "Synthetic task", synthetic: true, status: "assigned" },
    { id: "4", title: "Runtime source", source: "runtime", status: "assigned" },
    { id: "5", title: "Another real task", status: "inbox" },
  ];

  const filtered = missionQueue.filterTasks(tasks, {});
  const ids = filtered.map((t) => t.id);

  assert.deepEqual(ids, ["1", "5"], "Should only include non-synthetic, non-runtime tasks");
});

test("filterTasks excludes runtime source with case-insensitive matching", () => {
  const tasks = [
    { id: "1", title: "Runtime as string", source: "runtime" },
    { id: "2", title: "Runtime with uppercase", source: "RUNTIME" },
    { id: "3", title: "Normal source", source: "manual" },
  ];

  const filtered = missionQueue.filterTasks(tasks, {});
  const ids = filtered.map((t) => t.id);

  assert.deepEqual(ids, ["3"], "Should exclude runtime-source tasks regardless of source casing");
});

test("inferAgentActivityState returns standby for runtime-derived agents", () => {
  const tasks = [];
  
  const runtimeDerivedAgent = { id: "a-1", runtime_derived: true, status: "active" };
  const syntheticAgent = { id: "a-2", synthetic: true, status: "working" };
  const runtimeSourceAgent = { id: "a-3", source: "runtime", status: "busy" };
  const normalAgent = { id: "a-4", status: "active" };

  assert.equal(missionQueue.inferAgentActivityState(runtimeDerivedAgent, tasks), "standby");
  assert.equal(missionQueue.inferAgentActivityState(syntheticAgent, tasks), "standby");
  assert.equal(missionQueue.inferAgentActivityState(runtimeSourceAgent, tasks), "standby");
  assert.equal(missionQueue.inferAgentActivityState(normalAgent, tasks), "working");
});

test("inferAgentActivityState handles case-insensitive runtime source", () => {
  const tasks = [];
  
  const lowerRuntime = { id: "a-1", source: "runtime", status: "active" };
  const upperRuntime = { id: "a-2", source: "RUNTIME", status: "active" };
  const mixedRuntime = { id: "a-3", source: "Runtime", status: "active" };

  assert.equal(missionQueue.inferAgentActivityState(lowerRuntime, tasks), "standby");
  assert.equal(missionQueue.inferAgentActivityState(upperRuntime, tasks), "standby");
  assert.equal(missionQueue.inferAgentActivityState(mixedRuntime, tasks), "standby");
});

test("filterTasks still respects other filters after synthetic exclusion", () => {
  const tasks = [
    { id: "1", title: "Real planning", status: "planning", assigned_agent_id: "agent-1" },
    { id: "2", title: "Synthetic planning", synthetic: true, status: "planning" },
    { id: "3", title: "Real done", status: "done", assigned_agent_id: "agent-1" },
    { id: "4", title: "Runtime inbox", runtime_derived: true, status: "inbox" },
  ];

  const filtered = missionQueue.filterTasks(tasks, { status: "planning", assignee: "agent-1" });
  const ids = filtered.map((t) => t.id);

  assert.deepEqual(ids, ["1"], "Should apply both synthetic exclusion and user filters");
});

test("filterAgentsByLane respects synthetic agent filtering via inferAgentActivityState", () => {
  const agents = [
    { id: "a-1", status: "active" },
    { id: "a-2", synthetic: true, status: "active" },
    { id: "a-3", status: "standby" },
    { id: "a-4", runtime_derived: true, status: "working" },
  ];
  const tasks = [];

  // Synthetic agents should be in standby lane
  const standbyAgents = missionQueue.filterAgentsByLane(agents, "standby", tasks);
  const workingAgents = missionQueue.filterAgentsByLane(agents, "working", tasks);

  assert.equal(standbyAgents.length, 3, "Should include normal standby + synthetic agents");
  assert.equal(workingAgents.length, 1, "Should only include non-synthetic active agents");
  assert.deepEqual(workingAgents.map((a) => a.id), ["a-1"]);
});
