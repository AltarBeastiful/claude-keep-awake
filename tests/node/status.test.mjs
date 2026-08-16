import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseProbeOutput, formatStatusReport } from '../../scripts/lib/core.mjs';

// --- parseProbeOutput: tolerate CLIXML / progress noise around the two marker lines ---

test('parseProbeOutput: reads SYSTEM_REQUIRED / DISPLAY_REQUIRED booleans', () => {
  const out = 'SYSTEM_REQUIRED=True\nDISPLAY_REQUIRED=False\n';
  assert.deepEqual(parseProbeOutput(out), { systemBlocked: true, displayOn: false });
});

test('parseProbeOutput: ignores surrounding noise (Add-Type progress, CLIXML)', () => {
  const out = '#< CLIXML\n<Objs>...</Objs>SYSTEM_REQUIRED=False\nDISPLAY_REQUIRED=True\ntrailing junk';
  assert.deepEqual(parseProbeOutput(out), { systemBlocked: false, displayOn: true });
});

test('parseProbeOutput: missing markers -> nulls (unknown)', () => {
  assert.deepEqual(parseProbeOutput('nothing useful here'), { systemBlocked: null, displayOn: null });
});

// --- formatStatusReport: human-readable, cross-platform ---

const NOW = new Date('2026-06-14T06:00:00.000Z');

test('formatStatusReport: supported env shows power state and lists workers', () => {
  const report = formatStatusReport({
    env: 'win32',
    state: { supported: true, systemBlocked: true, displayOn: false },
    locks: [
      { sessionId: 'AAA', record: { pid: 100, platform: 'win32', startedAt: '2026-06-14T05:00:00.000Z' }, alive: true },
    ],
    now: NOW,
  });
  assert.match(report, /Environment\s*:\s*win32/);
  assert.match(report, /System sleep blocked\s*:\s*True/);
  assert.match(report, /Display kept on\s*:\s*False/);
  assert.match(report, /session AAA/);
  assert.match(report, /pid 100/);
  assert.match(report, /alive True/i);
});

test('formatStatusReport: wsl notes the host is being kept awake', () => {
  const report = formatStatusReport({
    env: 'wsl',
    state: { supported: true, systemBlocked: true, displayOn: false },
    locks: [],
    now: NOW,
  });
  assert.match(report, /Environment\s*:\s*wsl/);
  assert.match(report, /host/i); // makes clear the HOST is what's kept awake
});

test('formatStatusReport: unsupported env (darwin) says no-op, no power lines', () => {
  const report = formatStatusReport({
    env: 'darwin',
    state: { supported: false },
    locks: [],
    now: NOW,
  });
  assert.match(report, /no-op|not implemented/i);
  assert.doesNotMatch(report, /System sleep blocked/);
});

test('formatStatusReport: linux reports the backend and the idle verdict', () => {
  const report = formatStatusReport({
    env: 'linux',
    state: {
      supported: true,
      backend: 'systemd-inhibit (/usr/bin/systemd-inhibit)',
      systemBlocked: true,
      notes: ['Idle inhibitors held by this plugin: 1'],
    },
    locks: [{ sessionId: 'AAA', record: { pid: 100, platform: 'linux', startedAt: '2026-06-14T05:00:00.000Z' }, alive: true }],
    now: NOW,
  });
  assert.match(report, /Backend\s*:\s*systemd-inhibit/);
  assert.match(report, /System sleep blocked\s*:\s*True/);
  assert.match(report, /Idle inhibitors held by this plugin: 1/);
  // No display verdict on Linux: an idle inhibition covers display-off implicitly, so claiming
  // a separate True/False would be a lie. The README explains the side-effect instead.
  assert.doesNotMatch(report, /Display kept on/);
});

test('formatStatusReport: linux with no inhibit backend still surfaces its note', () => {
  const report = formatStatusReport({
    env: 'linux',
    state: { supported: false, notes: ['(No inhibit backend found: install systemd, elogind, or gnome-session-inhibit.)'] },
    locks: [],
    now: NOW,
  });
  assert.match(report, /no-op|not implemented/i);
  assert.match(report, /No inhibit backend found/);
});

test('formatStatusReport: no workers -> explicit none line', () => {
  const report = formatStatusReport({
    env: 'win32',
    state: { supported: true, systemBlocked: false, displayOn: false },
    locks: [],
    now: NOW,
  });
  assert.match(report, /none/i);
});
