const test = require("node:test");
const assert = require("node:assert/strict");
const missionQueue = require("../dashboard-mission-queue.js");

test("summarizeBoard groups open, active, and done missions", () => {
  const summary = missionQueue.summarizeBoard([
    { status: "planning" },
    { status: "assigned" },
    { status: "in_progress" },
    { status: "verification" },
    { status: "done" },
  ]);

  assert.equal(summary.open, 3);
  assert.equal(summary.active, 2);
  assert.equal(summary.done, 1);
  assert.equal(summary.openPct, "60%");
});

test("filterTasks narrows by assignee, priority, status, and type", () => {
  const tasks = [
    { id: "1", assigned_agent_id: "a1", priority: "urgent", status: "planning", task_type: "general" },
    { id: "2", assigned_agent_id: "a2", priority: "normal", status: "done", task_type: "provision_workspace" },
  ];

  const filtered = missionQueue.filterTasks(tasks, {
    assignee: "a2",
    priority: "normal",
    status: "done",
    type: "provision_workspace",
  });

  assert.deepEqual(filtered.map((task) => task.id), ["2"]);
});

test("inferAgentActivityState marks working when status is active or assignments exist", () => {
  const tasks = [{ id: "t-1", assigned_agent_id: "a-2" }];

  assert.equal(
    missionQueue.inferAgentActivityState({ id: "a-1", status: "active" }, tasks),
    "working",
  );
  assert.equal(
    missionQueue.inferAgentActivityState({ id: "a-2", status: "standby" }, tasks),
    "working",
  );
  assert.equal(
    missionQueue.inferAgentActivityState({ id: "a-3", status: "idle" }, tasks),
    "standby",
  );
});

test("filterAgentsByLane supports all, working, and standby lanes", () => {
  const agents = [
    { id: "a-1", status: "active" },
    { id: "a-2", status: "standby" },
    { id: "a-3", status: "standby" },
  ];
  const tasks = [{ id: "t-1", assigned_agent_id: "a-2" }];

  assert.equal(missionQueue.filterAgentsByLane(agents, "all", tasks).length, 3);
  assert.deepEqual(
    missionQueue.filterAgentsByLane(agents, "working", tasks).map((agent) => agent.id),
    ["a-1", "a-2"],
  );
  assert.deepEqual(
    missionQueue.filterAgentsByLane(agents, "standby", tasks).map((agent) => agent.id),
    ["a-3"],
  );
});

test("filterFeedEvents splits task and agent events", () => {
  const events = [
    { id: "e1", type: "task_updated", task_id: "t1" },
    { id: "e2", type: "agent_status_changed", agent_id: "a1" },
    { id: "e3", type: "workspace_ping" },
  ];

  assert.deepEqual(missionQueue.filterFeedEvents(events, "tasks").map((event) => event.id), ["e1"]);
  assert.deepEqual(missionQueue.filterFeedEvents(events, "agents").map((event) => event.id), ["e2"]);
  assert.deepEqual(missionQueue.filterFeedEvents(events, "all").map((event) => event.id), ["e1", "e2", "e3"]);
});

test("buildPayloadFromForm normalizes empty optional mission fields", () => {
  const payload = missionQueue.buildPayloadFromForm({
    title: "  Stabilize review lane  ",
    description: "   ",
    priority: "high",
    status: "review",
    task_type: "general",
    assigned_agent_id: "",
    due_date: "",
    workspace_id: "default",
  });

  assert.deepEqual(payload, {
    title: "Stabilize review lane",
    description: null,
    priority: "high",
    status: "review",
    task_type: "general",
    assigned_agent_id: null,
    due_date: null,
    workspace_id: "default",
    business_id: "default",
  });
});
