import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  LINUX_INHIBIT_WHO,
  LINUX_INHIBIT_BACKENDS,
  resolveLinuxInhibitor,
  buildBackstopCommand,
  buildLinuxHolderInvocation,
  buildLinuxReason,
  parseInhibitList,
  isIdleBlocked,
  parseProcStartTime,
} from '../../scripts/lib/core.mjs';

// The Linux backend is built out of pure functions taking an injected `resolveBin`, so the full
// backend/config matrix is asserted here on any OS. Only the launch itself needs a real Linux
// host, and that is covered by the integration test at the bottom (skipped elsewhere).

// A fake PATH: `resolveBin` finds only the named binaries.
const pathWith = (...names) => (name) => (names.includes(name) ? `/usr/bin/${name}` : null);

// --- backend resolution order ---

test('resolveLinuxInhibitor: prefers systemd-inhibit when several are present', () => {
  const found = resolveLinuxInhibitor({ resolveBin: pathWith('systemd-inhibit', 'elogind-inhibit', 'gnome-session-inhibit') });
  assert.deepEqual(found, { name: 'systemd-inhibit', path: '/usr/bin/systemd-inhibit' });
});

test('resolveLinuxInhibitor: falls back to elogind-inhibit (Void/Artix/Devuan/Alpine)', () => {
  const found = resolveLinuxInhibitor({ resolveBin: pathWith('elogind-inhibit', 'gnome-session-inhibit') });
  assert.equal(found.name, 'elogind-inhibit');
});

test('resolveLinuxInhibitor: falls back to gnome-session-inhibit last', () => {
  assert.equal(resolveLinuxInhibitor({ resolveBin: pathWith('gnome-session-inhibit') }).name, 'gnome-session-inhibit');
});

test('resolveLinuxInhibitor: no backend installed -> null (caller degrades to a no-op)', () => {
  assert.equal(resolveLinuxInhibitor({ resolveBin: () => null }), null);
});

test('LINUX_INHIBIT_BACKENDS: the documented preference order', () => {
  assert.deepEqual(LINUX_INHIBIT_BACKENDS, ['systemd-inhibit', 'elogind-inhibit', 'gnome-session-inhibit']);
});

// --- backstop command (max_lifetime_hours parity: systemd-inhibit has no timeout flag) ---

test('buildBackstopCommand: a sleep of maxHours in seconds', () => {
  assert.deepEqual(buildBackstopCommand({ maxHours: 8 }), ['sleep', '28800']);
  assert.deepEqual(buildBackstopCommand({ maxHours: 1 }), ['sleep', '3600']);
});

test('buildBackstopCommand: fractional hours round to whole seconds', () => {
  assert.deepEqual(buildBackstopCommand({ maxHours: 1.5 }), ['sleep', '5400']);
});

test('buildBackstopCommand: a non-finite maxHours throws rather than emitting garbage', () => {
  assert.throws(() => buildBackstopCommand({ maxHours: NaN }), TypeError);
});

// --- reason string (what desktop UIs render) ---

test('buildLinuxReason: reads as a continuation of WHO, not a repeat of it', () => {
  // Plasma's battery applet renders "<WHO> is blocking screen locking. (<WHY>)".
  assert.equal(buildLinuxReason({ sessionId: 'abc', keepDisplay: false }), 'Working on session abc');
});

test('buildLinuxReason: keep_display_on tags the reason so --list shows what was asked', () => {
  assert.equal(buildLinuxReason({ sessionId: 'abc', keepDisplay: true }), 'Working on session abc [display]');
});

// --- holder invocation per backend ---

const INHIBITOR = { name: 'systemd-inhibit', path: '/usr/bin/systemd-inhibit' };
const REASON = 'Working on session AAA';

test('buildLinuxHolderInvocation: systemd-inhibit argv (idle, block, who/why, backstop)', () => {
  const inv = buildLinuxHolderInvocation({ inhibitor: INHIBITOR, reason: REASON, maxHours: 8 });
  assert.equal(inv.command, '/usr/bin/systemd-inhibit');
  assert.deepEqual(inv.args, [
    '--what=idle',
    `--who=${LINUX_INHIBIT_WHO}`,
    `--why=${REASON}`,
    '--mode=block',
    'sleep',
    '28800',
  ]);
});

// This is the load-bearing assertion of the whole backend. `--what=sleep --mode=block` tells
// logind to refuse suspend outright, which takes away `systemctl suspend`, the power menu, and
// lid close. `idle` is the inhibition a media player holds: it stops the machine idling into
// suspend and leaves every deliberate suspend path working.
test('buildLinuxHolderInvocation: inhibits idle ONLY, never sleep', () => {
  for (const keepDisplay of [false, true]) {
    const inv = buildLinuxHolderInvocation({
      inhibitor: INHIBITOR,
      reason: buildLinuxReason({ sessionId: 'AAA', keepDisplay }),
      maxHours: 8,
    });
    const what = inv.args.find((a) => a.startsWith('--what='));
    assert.equal(what, '--what=idle');
    assert.ok(!what.includes('sleep'), 'a sleep inhibition would break lid close and `systemctl suspend`');
  }
});

test('buildLinuxHolderInvocation: keep_display_on does not change --what (documented side-effect)', () => {
  // On Linux an idle inhibition already suppresses display-off; the option only tags the reason
  // string, which is what shows up in `systemd-inhibit --list`.
  const off = buildLinuxHolderInvocation({ inhibitor: INHIBITOR, reason: 'r', maxHours: 8 });
  const on = buildLinuxHolderInvocation({ inhibitor: INHIBITOR, reason: 'r [display]', maxHours: 8 });
  assert.deepEqual(
    off.args.filter((a) => a.startsWith('--what=')),
    on.args.filter((a) => a.startsWith('--what=')),
  );
  assert.ok(on.args.includes('--why=r [display]'));
});

test('buildLinuxHolderInvocation: elogind-inhibit shares the systemd CLI surface', () => {
  const inv = buildLinuxHolderInvocation({
    inhibitor: { name: 'elogind-inhibit', path: '/usr/bin/elogind-inhibit' },
    reason: REASON,
    maxHours: 2,
  });
  assert.equal(inv.command, '/usr/bin/elogind-inhibit');
  assert.ok(inv.args.includes('--what=idle'));
  assert.ok(inv.args.includes('--mode=block'));
  assert.deepEqual(inv.args.slice(-2), ['sleep', '7200']);
});

test('buildLinuxHolderInvocation: gnome-session-inhibit uses its own flag spelling', () => {
  const inv = buildLinuxHolderInvocation({
    inhibitor: { name: 'gnome-session-inhibit', path: '/usr/bin/gnome-session-inhibit' },
    reason: REASON,
    maxHours: 8,
  });
  assert.deepEqual(inv.args, [
    '--app-id',
    LINUX_INHIBIT_WHO,
    '--reason',
    REASON,
    '--inhibit',
    'idle',
    'sleep',
    '28800',
  ]);
  // `--inhibit suspend` would stop GNOME suspending on lid close; idle only, same as logind.
  assert.ok(!inv.args.includes('suspend'));
});

// --- `systemd-inhibit --list` parsing (the status differential) ---

const LIST = `WHO                          UID  USER PID  COMM            WHAT                          WHY                                     MODE
NetworkManager               0    root 1645 NetworkManager  sleep                         NetworkManager needs to turn off nets   delay
Claude Code                  1000 remi 4114007 systemd-inhibit idle                       Working on session AAA                  block
PowerDevil                   1000 remi 2930 org_kde_powerde handle-power-key:handle-lid-switch KDE handles power events           block

4 inhibitors listed.`;

test('parseInhibitList: reads every row, skipping the header and footer', () => {
  const rows = parseInhibitList(LIST);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.who), ['NetworkManager', 'Claude Code', 'PowerDevil']);
});

test('parseInhibitList: keeps multi-word WHO and WHY intact', () => {
  const ours = parseInhibitList(LIST).find((r) => r.who === LINUX_INHIBIT_WHO);
  assert.equal(ours.pid, 4114007);
  assert.equal(ours.comm, 'systemd-inhibit');
  assert.equal(ours.what, 'idle');
  assert.equal(ours.mode, 'block');
  assert.equal(ours.why, 'Working on session AAA');
});

test('parseInhibitList: garbage in -> empty list, not a throw', () => {
  assert.deepEqual(parseInhibitList('command not found'), []);
  assert.deepEqual(parseInhibitList(''), []);
  assert.deepEqual(parseInhibitList(null), []);
});

test('isIdleBlocked: true only for a blocking idle inhibitor', () => {
  assert.equal(isIdleBlocked(parseInhibitList(LIST)), true);
  assert.equal(isIdleBlocked([{ what: 'sleep', mode: 'block' }]), false);
  assert.equal(isIdleBlocked([{ what: 'idle', mode: 'delay' }]), false);
  assert.equal(isIdleBlocked([]), false);
});

test('isIdleBlocked: matches a whole element of a colon-joined WHAT, not a substring', () => {
  assert.equal(isIdleBlocked([{ what: 'sleep:idle', mode: 'block' }]), true);
  // "handle-lid-switch" contains no idle element, and neither does this decoy.
  assert.equal(isIdleBlocked([{ what: 'idleness', mode: 'block' }]), false);
});

// --- /proc/<pid>/stat field 22 (the PID-reuse-safe identity) ---

test('parseProcStartTime: reads field 22 as an exact string', () => {
  const stat = '4114007 (systemd-inhibit) S 1 4114007 4114007 0 -1 4194304 ' +
    // fields 9..21
    '511 0 0 0 1 0 0 0 20 0 1 0 ' +
    '60432625 12345 678 18446744073709551615';
  assert.equal(parseProcStartTime(stat), '60432625');
});

test('parseProcStartTime: tolerates a comm containing spaces and parens', () => {
  const stat = '77 (my (weird) proc) S 1 77 77 0 -1 4194304 ' +
    '511 0 0 0 1 0 0 0 20 0 1 0 ' +
    '99887766 1 2 3';
  assert.equal(parseProcStartTime(stat), '99887766');
});

test('parseProcStartTime: missing/garbled input -> null (never a wrong identity)', () => {
  assert.equal(parseProcStartTime(null), null);
  assert.equal(parseProcStartTime(''), null);
  assert.equal(parseProcStartTime('no parens here'), null);
  assert.equal(parseProcStartTime('1 (short) S 1 1'), null);
});

// ---------------------------------------------------------------------------
// Integration: a real inhibitor on a real host. Skipped everywhere else.
// ---------------------------------------------------------------------------

// A tiny local PATH scan: dispatch.mjs is deliberately not imported (it runs on invocation),
// and this keeps the test self-contained.
function realResolveBin(name) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const realBin = process.platform === 'linux' ? resolveLinuxInhibitor({ resolveBin: realResolveBin }) : null;
// gnome-session-inhibit's `--list` has a different format we don't parse, so the assertions
// below only apply to the systemd/elogind backends.
const canIntegrate = Boolean(realBin) && realBin.name !== 'gnome-session-inhibit';

// PIDs whose parent is `ppid`, read straight from /proc (field 4 of stat, after the comm).
function childrenOf(ppid) {
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue; // exited between readdir and read
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (Number.parseInt(fields[1], 10) === ppid) found.push(Number.parseInt(entry, 10));
  }
  return found;
}

const settle = () => new Promise((r) => setTimeout(r, 500));

test('integration: a launched holder registers an idle inhibitor and releases on group kill', { skip: !canIntegrate }, async () => {
  const reason = buildLinuxReason({ sessionId: `test-${process.pid}`, keepDisplay: false });
  const inv = buildLinuxHolderInvocation({ inhibitor: realBin, reason, maxHours: 0.05 });

  const child = spawn(inv.command, inv.args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  assert.ok(child.pid, 'holder should launch');
  child.unref();

  const list = () => execFileSync(realBin.path, ['--list'], { encoding: 'utf8', env: { ...process.env, SYSTEMD_PAGER: 'cat' } });
  await settle();

  const rows = parseInhibitList(list());
  const ours = rows.find((r) => r.pid === child.pid);
  assert.ok(ours, 'our holder should appear in --list');
  // Exactly `idle`, not `sleep:idle`: the machine must still suspend on a lid close.
  assert.equal(ours.what, 'idle');
  assert.equal(ours.mode, 'block');
  assert.equal(ours.why, reason);
  assert.equal(ours.who, LINUX_INHIBIT_WHO);
  assert.ok(isIdleBlocked(rows));

  // The identity unblock verifies before signalling.
  const procStart = parseProcStartTime(readFileSync(`/proc/${child.pid}/stat`, 'utf8'));
  assert.match(procStart ?? '', /^\d+$/);

  // The wrapped backstop runs as a child of the inhibitor, which is why unblock signals the
  // whole group: killing the leader alone releases the inhibition but strands this process.
  const backstop = childrenOf(child.pid);
  assert.equal(backstop.length, 1, 'the inhibitor wraps exactly one backstop process');

  process.kill(-child.pid, 'SIGTERM');
  await settle();

  assert.ok(!parseInhibitList(list()).some((r) => r.pid === child.pid), 'inhibitor should be released');
  assert.throws(() => process.kill(backstop[0], 0), 'the wrapped backstop must not outlive the holder');
});
