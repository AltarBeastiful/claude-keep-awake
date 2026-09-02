import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSessionTitle,
  sanitizeReasonLabel,
  shortSessionId,
  SHORT_SESSION_ID_LENGTH,
  buildReason,
  buildLinuxReason,
  formatStatusReport,
  MAX_SESSION_TITLE,
  LINUX_INHIBIT_WHO,
} from '../../scripts/lib/core.mjs';
import { planHolder, runDispatch } from '../../scripts/lib/dispatch-core.mjs';

// Shape taken from a real transcript: Claude Code writes the session name as its own record
// type and re-emits it on every re-title, so the last one is the current name.
const titleRecord = (name, sessionId = 'c4b94408') =>
  JSON.stringify({ type: 'ai-title', aiTitle: name, sessionId });
const otherRecord = (type = 'user') => JSON.stringify({ type, timestamp: '2026-08-20T14:51:53.828Z' });

// --- sanitizeReasonLabel ---

test('sanitizeReasonLabel: passes an ordinary name through unchanged', () => {
  assert.equal(sanitizeReasonLabel('Test something'), 'Test something');
});

test('sanitizeReasonLabel: flattens newlines and control characters to single spaces', () => {
  // The result is a world-readable system string and a process argv, so it must stay one line.
  assert.equal(sanitizeReasonLabel('Fix the\nparser\tbug'), 'Fix the parser bug');
  assert.equal(sanitizeReasonLabel('a\u0000\u0007\u007fb'), 'a b');
  assert.equal(sanitizeReasonLabel('\u001b[31mred\u001b[0m'), '[31mred [0m');
  assert.equal(sanitizeReasonLabel('  spaced   out  '), 'spaced out');
});

test('sanitizeReasonLabel: truncates a long name and marks the truncation', () => {
  const out = sanitizeReasonLabel('x'.repeat(200));
  assert.ok(out.length <= MAX_SESSION_TITLE + 3);
  assert.ok(out.endsWith('...'));
});

test('sanitizeReasonLabel: empty, whitespace-only, and non-strings -> empty', () => {
  for (const v of ['', '   ', '\n\n', null, undefined]) {
    assert.equal(sanitizeReasonLabel(v), '', `expected ${JSON.stringify(v)} -> ''`);
  }
});

// --- extractSessionTitle ---

test('extractSessionTitle: finds the name in a transcript chunk', () => {
  const chunk = [otherRecord(), titleRecord('Test something'), otherRecord('assistant')].join('\n');
  assert.equal(extractSessionTitle(chunk), 'Test something');
});

test('extractSessionTitle: the LAST record wins, because re-titling re-emits it', () => {
  const chunk = [titleRecord('First guess'), otherRecord(), titleRecord('Better name')].join('\n');
  assert.equal(extractSessionTitle(chunk), 'Better name');
});

test('extractSessionTitle: a truncated leading line (tail read) is skipped, not fatal', () => {
  // dispatch.mjs reads only the tail of the transcript, so line one is normally a fragment.
  // Worse: the fragment is itself half of an ai-title record, so it passes the string
  // pre-filter and has to be rejected by the JSON parse.
  const chunk = ['-title","aiTitle":"Stale half-line","sessionId":"c4b94408"}', titleRecord('Real name')].join('\n');
  assert.equal(extractSessionTitle(chunk), 'Real name');
});

test('extractSessionTitle: no title record, empty input, or junk -> empty', () => {
  assert.equal(extractSessionTitle([otherRecord(), otherRecord('assistant')].join('\n')), '');
  for (const v of ['', null, undefined, 'not json at all']) {
    assert.equal(extractSessionTitle(v), '', `expected ${JSON.stringify(v)} -> ''`);
  }
});

test('extractSessionTitle: a record merely mentioning ai-title is not mistaken for one', () => {
  // The cheap string pre-filter must not be the thing that decides; `type` has to match.
  const decoy = JSON.stringify({ type: 'user', text: 'what does "ai-title" mean?', aiTitle: 'nope' });
  assert.equal(extractSessionTitle(decoy), '');
});

test('extractSessionTitle: sanitizes on the way out', () => {
  assert.equal(extractSessionTitle(titleRecord('Multi\nline  name')), 'Multi line name');
});

// --- shortSessionId ---

test('shortSessionId: a UUID cuts at its first segment, git-short-SHA style', () => {
  assert.equal(shortSessionId('c4b94408-3b66-4843-8d0f-a9ab78500c53'), 'c4b94408');
  assert.equal(shortSessionId('59b6a369-0a3c-4a60-9153-99954ff09ddb'), '59b6a369');
  assert.equal(shortSessionId('c4b94408-3b66-4843-8d0f-a9ab78500c53').length, SHORT_SESSION_ID_LENGTH);
});

test('shortSessionId: a short non-UUID id is left alone', () => {
  // The 'default' fallback and test ids are not UUIDs and must not be mangled into nonsense.
  assert.equal(shortSessionId('default'), 'default');
  assert.equal(shortSessionId('abc'), 'abc');
  assert.equal(shortSessionId('AAA'), 'AAA');
});

test('shortSessionId: a long unhyphenated id is still capped', () => {
  assert.equal(shortSessionId('a'.repeat(40)), 'a'.repeat(SHORT_SESSION_ID_LENGTH));
});

test('shortSessionId: empty and nullish -> empty', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(shortSessionId(v), '', `expected ${JSON.stringify(v)} -> ''`);
  }
});

test('shortSessionId: distinct sessions stay distinguishable at 8 characters', () => {
  const a = shortSessionId('c4b94408-3b66-4843-8d0f-a9ab78500c53');
  const b = shortSessionId('59b6a369-0a3c-4a60-9153-99954ff09ddb');
  assert.notEqual(a, b);
});

// --- reason strings ---

test('buildLinuxReason: a real UUID is shortened, not carried in full', () => {
  const why = buildLinuxReason({
    sessionId: 'c4b94408-3b66-4843-8d0f-a9ab78500c53',
    sessionTitle: 'Test something',
  });
  assert.equal(why, 'Working on Test something (c4b94408)');
  assert.ok(!why.includes('a9ab78500c53'), 'the full id belongs on the lock file, not in --list');
  // The full id is still recoverable: /keep-awake-status prints it, and it names the lock file.
});

test('buildLinuxReason: leads with the name and keeps the id', () => {
  assert.equal(
    buildLinuxReason({ sessionId: 'c4b94408', sessionTitle: 'Test something' }),
    'Working on Test something (c4b94408)',
  );
});

test('buildLinuxReason: no name yet -> exactly the string it has always been', () => {
  // Claude Code assigns the name after the first exchange, so the first turn of a new session
  // has nothing to show. That case must not regress.
  assert.equal(buildLinuxReason({ sessionId: 'abc', keepDisplay: false }), 'Working on session abc');
  assert.equal(buildLinuxReason({ sessionId: 'abc', sessionTitle: '', keepDisplay: false }), 'Working on session abc');
  assert.equal(buildLinuxReason({ sessionId: 'abc', keepDisplay: true }), 'Working on session abc [display]');
});

test('buildLinuxReason: the [display] tag stays last so it reads as a suffix', () => {
  assert.equal(
    buildLinuxReason({ sessionId: 'abc', sessionTitle: 'Some name', keepDisplay: true }),
    'Working on Some name (abc) [display]',
  );
});

test('buildReason (windows): same pair, same no-name fallback', () => {
  assert.equal(
    buildReason({ sessionId: 'abc', sessionTitle: 'Test something' }),
    'Claude Code keep-awake: Test something (abc)',
  );
  assert.equal(buildReason({ sessionId: 'abc', keepDisplay: false }), 'Claude Code keep-awake (session abc)');
  assert.equal(
    buildReason({ sessionId: 'abc', sessionTitle: 'Test something', keepDisplay: true }),
    'Claude Code keep-awake: Test something (abc) [display]',
  );
});

test('a hostile name cannot break out of the reason string', () => {
  const nasty = 'evil\n--what=sleep\nx';
  const why = buildLinuxReason({ sessionId: 'abc', sessionTitle: nasty });
  assert.ok(!why.includes('\n'), 'must stay one line');
  // It is only ever text inside --why, and the holder is spawned with an argv array (no shell),
  // so this is defence in depth rather than the only thing standing in the way.
  assert.equal(why, 'Working on evil --what=sleep x (abc)');
});

// --- planHolder wiring ---

test('planHolder (linux): the name reaches the inhibitor argv', () => {
  const inv = planHolder({
    env: 'linux',
    sessionId: 'abc',
    sessionTitle: 'Test something',
    keepDisplay: false,
    maxHours: 8,
    resolveBin: (n) => (n === 'systemd-inhibit' ? '/usr/bin/systemd-inhibit' : null),
  });
  assert.equal(inv.args.find((a) => a.startsWith('--why=')), '--why=Working on Test something (abc)');
  assert.equal(inv.args.find((a) => a.startsWith('--who=')), `--who=${LINUX_INHIBIT_WHO}`);
  assert.equal(inv.args.find((a) => a.startsWith('--what=')), '--what=idle', 'still idle, never sleep');
});

// --- lock model: when the name is read, and where it is recorded ---

function harness() {
  const locks = new Map();
  const spawns = [];
  let pid = 5000;
  let titleReads = 0;
  const live = new Set();
  const deps = {
    store: {
      list: () => [...locks.keys()],
      read: (sid) => locks.get(sid) ?? null,
      write: (sid, record) => locks.set(sid, record),
      remove: (sid) => locks.delete(sid),
      touch: () => {},
    },
    isAlive: (p) => live.has(p),
    spawn: (inv) => { spawns.push(inv); const p = pid++; live.add(p); return { pid: p, procStart: 1000 + p }; },
    kill: (rec) => live.delete(rec.pid),
    now: () => new Date(Date.UTC(2026, 7, 20, 12, 0, 0)),
    log: () => {},
    holderBody: '',
    resolveBin: (n) => (n === 'systemd-inhibit' ? '/usr/bin/systemd-inhibit' : null),
    readSessionTitle: () => { titleReads += 1; return 'Test something'; },
  };
  return { deps, locks, spawns, reads: () => titleReads };
}

const opts = { keepDisplay: false, maxHours: 8 };

test('block: records the name in the lock alongside the pid', () => {
  const h = harness();
  runDispatch({ action: 'block', env: 'linux', sessionId: 'AAA', options: opts, deps: h.deps });
  assert.equal(h.deps.store.read('AAA').title, 'Test something');
});

test('block: reads the transcript only when a holder actually launches', () => {
  // Every turn after the first takes the idempotent path, which must not pay for a file read.
  const h = harness();
  runDispatch({ action: 'block', env: 'linux', sessionId: 'AAA', options: opts, deps: h.deps });
  assert.equal(h.reads(), 1);
  runDispatch({ action: 'block', env: 'linux', sessionId: 'AAA', options: opts, deps: h.deps });
  runDispatch({ action: 'block', env: 'linux', sessionId: 'AAA', options: opts, deps: h.deps });
  assert.equal(h.reads(), 1, 'the idempotent path must not touch the transcript');
  assert.equal(h.spawns.length, 1);
});

test('block: a dispatcher with no readSessionTitle dep still works (no name recorded)', () => {
  const h = harness();
  delete h.deps.readSessionTitle;
  const r = runDispatch({ action: 'block', env: 'linux', sessionId: 'AAA', options: opts, deps: h.deps });
  assert.equal(r.result, 'started');
  assert.equal(h.deps.store.read('AAA').title, undefined);
});

// --- status report ---

test('formatStatusReport: names the session when the lock recorded one', () => {
  const out = formatStatusReport({
    env: 'linux',
    state: { supported: true, backend: 'systemd-inhibit', systemBlocked: true, notes: [] },
    locks: [{ sessionId: 'c4b94408', alive: true, record: { platform: 'linux', pid: 42, startedAt: 'T', title: 'Test something' } }],
  });
  assert.match(out, /session c4b94408 {2}name Test something {2}platform linux {2}pid 42/);
});

test('formatStatusReport: a lock with no name prints the line it always printed', () => {
  const out = formatStatusReport({
    env: 'linux',
    state: { supported: true, backend: 'systemd-inhibit', systemBlocked: true, notes: [] },
    locks: [{ sessionId: 'c4b94408', alive: true, record: { platform: 'linux', pid: 42, startedAt: 'T' } }],
  });
  assert.match(out, /session c4b94408 {2}platform linux {2}pid 42/);
  assert.ok(!out.includes('name'), 'no empty "name" field when there is no name');
});
