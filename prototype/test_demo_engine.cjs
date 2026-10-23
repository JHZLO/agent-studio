const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {}, structuredClone, setTimeout, clearTimeout };
vm.runInNewContext(readFileSync(__dirname + '/demo-engine.js', 'utf8'), context);
const { initialState, initializeFlows, DemoEngine } = context.window.StudioDemo;

test('Existing single-flow data keeps its agent order and presets', () => {
  const state = initialState();
  state.agents[0].name = 'Custom planner';
  state.workflow = ['reviewer', 'planner'];
  delete state.flows;
  delete state.activeFlowId;
  initializeFlows(state);
  assert.equal(state.flows[0].workflow.join(','), 'reviewer,planner');
  assert.equal(state.agents[0].name, 'Custom planner');
  assert.equal(state.activeFlowId, state.flows[0].id);
  assert.equal('workflow' in state, false);
});

test('A running task keeps its project, environment, flow and agent snapshots', t => {
  const state = initialState();
  const project = { id: 'project-1', name: 'Project', execution: { mode: 'worktree', baseRef: 'refs/heads/main' } };
  const flow = state.flows[0];
  let run;
  const engine = new DemoEngine(value => { run = value; });
  t.after(() => engine.dispose());
  engine.start({ id: 'test-run', brief: 'Test task', agents: state.agents, project, flow, approvalRequired: true });
  project.execution.mode = 'local';
  flow.name = 'Renamed later';
  flow.workflow.length = 0;
  state.agents[0].name = 'Edited later';
  assert.equal(run.project.execution.mode, 'worktree');
  assert.equal(run.flow.name, 'Feature delivery');
  assert.equal(run.flow.workflow.length, 6);
  assert.equal(run.steps[0].agent.name, 'Planner');
});
