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
