import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHookInput,
  inFlightBackgroundTasks,
  summarizeBackgroundTasks,
  shouldDeferRelease,
  TERMINAL_TASK_STATUSES,
} from '../../scripts/lib/core.mjs';

// Shape taken from Claude Code's own Stop hook schema: background_tasks is an optional array of
// { id, type, status, description, command?, agent_type?, server?, tool?, name? }, documented as
// "In-flight background work (running/pending + backgrounded) registered in this session".
const stop = (tasks) => ({
  hook_event_name: 'Stop',
  session_id: 'abc',
  stop_hook_active: false,
  ...(tasks === undefined ? {} : { background_tasks: tasks }),
});

const SHELL = { id: 't1', type: 'shell', status: 'running', description: 'long build', command: 'npm run build' };
const SUBAGENT = { id: 't2', type: 'subagent', status: 'pending', description: 'reviewing', agent_type: 'code-reviewer' };

// --- parseHookInput ---

test('parseHookInput: valid object round-trips; junk and empties -> null', () => {
  assert.deepEqual(parseHookInput('{"a":1}'), { a: 1 });
  for (const raw of ['', undefined, null, 'not json', '[]', '"str"', '7', 'null']) {
    assert.equal(parseHookInput(raw), null, `expected ${JSON.stringify(raw)} -> null`);
  }
});

// --- inFlightBackgroundTasks ---

test('inFlightBackgroundTasks: running/pending/paused count as in flight', () => {
  const tasks = ['running', 'pending', 'paused'].map((status, i) => ({ id: `t${i}`, type: 'shell', status }));
  assert.equal(inFlightBackgroundTasks({ background_tasks: tasks }).length, 3);
});

test('inFlightBackgroundTasks: terminal statuses are filtered out', () => {
  const tasks = TERMINAL_TASK_STATUSES.map((status, i) => ({ id: `t${i}`, type: 'shell', status }));
  assert.deepEqual(inFlightBackgroundTasks({ background_tasks: tasks }), []);
});

test('inFlightBackgroundTasks: status matching is case- and whitespace-insensitive', () => {
  const tasks = [{ id: 'a', status: ' COMPLETED ' }, { id: 'b', status: 'Killed' }];
  assert.deepEqual(inFlightBackgroundTasks({ background_tasks: tasks }), []);
});

test('inFlightBackgroundTasks: an unknown status errs toward in flight', () => {
  // A status a future Claude Code adds must not be mistaken for "finished": staying awake is the
  // safe failure, sleeping mid-task is not.
  const tasks = [{ id: 'a', type: 'shell', status: 'throttled' }, { id: 'b', type: 'shell' }];
  assert.equal(inFlightBackgroundTasks({ background_tasks: tasks }).length, 2);
});

test('inFlightBackgroundTasks: absent field, empty array, or non-array -> []', () => {
  for (const input of [{}, null, undefined, { background_tasks: [] }, { background_tasks: 'nope' }]) {
    assert.deepEqual(inFlightBackgroundTasks(input), [], `expected ${JSON.stringify(input)} -> []`);
  }
});

test('inFlightBackgroundTasks: non-object entries are dropped', () => {
  assert.deepEqual(inFlightBackgroundTasks({ background_tasks: [null, 'x', 7] }), []);
});

// --- shouldDeferRelease ---

test('shouldDeferRelease: Stop with in-flight work defers and reports the tasks', () => {
  const { defer, tasks } = shouldDeferRelease(stop([SHELL, SUBAGENT]));
  assert.equal(defer, true);
  assert.equal(tasks.length, 2);
});

test('shouldDeferRelease: Stop with nothing in flight releases', () => {
  assert.equal(shouldDeferRelease(stop([])).defer, false);
  assert.equal(shouldDeferRelease(stop([{ id: 'a', status: 'completed' }])).defer, false);
});

test('shouldDeferRelease: Stop from an older Claude Code (no field) releases as before', () => {
  assert.equal(shouldDeferRelease(stop(undefined)).defer, false);
});

test('shouldDeferRelease: SessionEnd ALWAYS releases, even with work in flight', () => {
  // The session is gone, so nothing will ever come back to release the holder. Deferring here
  // would strand it until the max-lifetime backstop.
  const input = { ...stop([SHELL]), hook_event_name: 'SessionEnd' };
  assert.equal(shouldDeferRelease(input).defer, false);
});

test('shouldDeferRelease: unknown/absent hook_event_name releases (manual run, future events)', () => {
  assert.equal(shouldDeferRelease({ background_tasks: [SHELL] }).defer, false);
  assert.equal(shouldDeferRelease({ hook_event_name: 'SubagentStop', background_tasks: [SHELL] }).defer, false);
  assert.equal(shouldDeferRelease(null).defer, false);
});

// --- summarizeBackgroundTasks (log line only; must never forge log lines) ---

test('summarizeBackgroundTasks: prefers command, falls back to description', () => {
  assert.equal(summarizeBackgroundTasks([SHELL]), 'shell(running): npm run build');
  assert.equal(summarizeBackgroundTasks([SUBAGENT]), 'subagent(pending): reviewing');
});

test('summarizeBackgroundTasks: collapses newlines so a description cannot forge a log line', () => {
  const out = summarizeBackgroundTasks([{ type: 'shell', status: 'running', command: 'a\nkeep-awake: fake' }]);
  assert.ok(!out.includes('\n'));
  assert.equal(out, 'shell(running): a keep-awake: fake');
});

test('summarizeBackgroundTasks: caps the list and counts the remainder', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ type: 'shell', status: 'running', command: `c${i}` }));
  assert.equal(summarizeBackgroundTasks(many), 'shell(running): c0, shell(running): c1, shell(running): c2, +2 more');
});

test('summarizeBackgroundTasks: tolerates missing fields and non-arrays', () => {
  assert.equal(summarizeBackgroundTasks([{}]), 'task(?)');
  assert.equal(summarizeBackgroundTasks(null), '');
});
