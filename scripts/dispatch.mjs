#!/usr/bin/env node
// Universal cross-platform entry point for every claude-keep-awake hook.
//
// Invoked by hooks.json as:  node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" <block|unblock>
// No `shell` field is used -- `node` is the single portable runtime that branches per-OS, so
// the same command works on Windows, WSL2, macOS, and Linux (see the v1.2.0 design notes).
//
// Responsibilities: read the hook's stdin JSON for the session id, detect the environment,
// read the user options, and run the per-session lock model (block/unblock). All real I/O is
// concentrated here; the decision logic lives in ./lib (pure, unit-tested).
//
// INVARIANT: a hook must never block Claude. Everything is wrapped so we ALWAYS exit 0, and we
// never emit a blocking decision. A missing `node`, missing `powershell.exe`, disabled WSL
// interop, or an unsupported OS all degrade to a benign no-op.

import { readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync, utimesSync, accessSync, constants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  detectEnvironment,
  isInteropAvailable,
  sessionIdFromHookInput,
  toBoolFlag,
  toLifetimeHours,
  serializeLock,
  parseLock,
  buildStartProcessLauncher,
  encodePowerShellCommand,
  parseHolderLaunch,
  buildVerifyAndKillCommand,
  parseProbeOutput,
  formatStatusReport,
  resolveLinuxInhibitor,
  parseInhibitList,
  isIdleBlocked,
  parseProcStartTime,
  parseLidState,
  LINUX_INHIBIT_WHO,
} from './lib/core.mjs';
import { runDispatch } from './lib/dispatch-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Read a file as text, returning null on any failure (used both for /proc detection and the
// holder body). Detection MUST tolerate absence -- /proc does not exist on Windows.
function readFileText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// Read the hook event JSON from stdin. Hooks deliver it on a closed pipe, so a synchronous
// read returns immediately; guard against a TTY (manual run) where it would otherwise block.
function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

// Per-user lock dir. Overridable via CLAUDE_KEEP_AWAKE_DIR (used for isolated testing so we
// never collide with a real session's locks); defaults under the OS temp dir.
function lockDir() {
  const dir = process.env.CLAUDE_KEEP_AWAKE_DIR || join(tmpdir(), 'claude-keep-awake');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(dir, sessionId) {
  return join(dir, `${sessionId}.lock`);
}

// fs-backed implementation of the lock store contract consumed by runDispatch.
function makeStore(dir) {
  return {
    list() {
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith('.lock'))
          .map((f) => f.slice(0, -'.lock'.length));
      } catch {
        return [];
      }
    },
    read(sessionId) {
      return parseLock(readFileText(lockPath(dir, sessionId)));
    },
    write(sessionId, record) {
      writeFileSync(lockPath(dir, sessionId), serializeLock(record));
    },
    remove(sessionId) {
      try {
        unlinkSync(lockPath(dir, sessionId));
      } catch {
        /* already gone */
      }
    },
    touch(sessionId) {
      try {
        const now = new Date();
        utimesSync(lockPath(dir, sessionId), now, now);
      } catch {
        /* lock vanished between read and touch; harmless */
      }
    },
  };
}

// Run a short PowerShell command, capturing stdout. On win32 this is the local powershell.exe;
// on wsl it is the host's powershell.exe over interop. Returns { status, stdout } (status null
// if the launch itself failed, e.g. powershell.exe not found / interop disabled).
function runPowerShell(command) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: res.error ? null : res.status, stdout: res.stdout || '' };
}

// Launch the detached holder via Start-Process and return its identity { pid, procStart } (on
// wsl, the real Windows host PID + its start time). procStart is captured from the same
// -PassThru launch -- no extra process query. Returns null if the launch failed.
function launchHolder(invocation) {
  const { status, stdout } = runPowerShell(buildStartProcessLauncher(invocation));
  if (status !== 0) return null;
  const { pid, procStart } = parseHolderLaunch(stdout);
  return pid ? { pid, procStart } : null;
}

// ---------------------------------------------------------------------------
// Linux: PATH lookup, lid discovery, detached inhibitor launch
// ---------------------------------------------------------------------------

// Minimal `which`: first executable named `name` on PATH, or null. Avoids shelling out to
// which/command -v (one less process, and no shell quoting).
function resolveBin(name) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here; keep looking */
    }
  }
  return null;
}

// The ACPI lid state file, if this machine has a lid. The directory name is firmware-defined
// (LID, LID0, LID1...), so enumerate rather than guess. null on desktops and on kernels
// without the ACPI button driver -- the holder then uses a plain backstop with no lid watch.
function findLidPath() {
  const base = '/proc/acpi/button/lid';
  try {
    for (const entry of readdirSync(base)) {
      const path = join(base, entry, 'state');
      if (readFileText(path) !== null) return path;
    }
  } catch {
    /* no lid */
  }
  return null;
}

// Launch the detached inhibitor and return its identity { pid, procStart }.
//
// - `detached: true` puts the holder in its own process group (so pgid === pid) AND detaches it
//   from this hook's lifetime, which is what lets it outlive the hook the way Start-Process
//   does on Windows.
// - `stdio: 'ignore'` is load-bearing: a detached child inheriting the hook's stdout pipe holds
//   that pipe open, and Claude Code waits for EOF -- the hook would appear to hang.
// - The 'error' listener is required too; an unhandled 'error' event on a ChildProcess throws.
function launchPosixHolder({ command, args }) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* exec failed; reported via the absent pid below */ });
    if (!child.pid) return null;
    child.unref();
    // uv_spawn has already fork+exec'd by the time spawn() returns, so /proc/<pid> exists.
    return { pid: child.pid, procStart: parseProcStartTime(readFileText(`/proc/${child.pid}/stat`)) };
  } catch {
    return null;
  }
}

// Liveness + termination, keyed by environment.
//   isAlive(pid): a cheap liveness probe used by block's sweep/idempotent fast path -- node's
//     process.kill(pid, 0) on win32 (no PowerShell), interop Get-Process on wsl.
//   kill(record): used only at unblock. Verifies the live PID still has the recorded start
//     time, then terminates -- in ONE PowerShell call, so a recycled PID belonging to an
//     unrelated process is never signalled (PID-reuse-safe), with no check-then-kill race.
function makeLifecycle(env) {
  const verifyAndKill = (record) => {
    if (!record || !record.pid) return;
    if (record.procStart === undefined || record.procStart === null) {
      // No identity captured (e.g. a pre-identity lock). Favor NOT killing over possibly
      // signalling the wrong process; the holder self-releases at its backstop.
      return;
    }
    runPowerShell(buildVerifyAndKillCommand(record.pid, record.procStart));
  };

  // Linux: same contract, /proc instead of PowerShell. The identity is the holder's start time
  // (field 22 of /proc/<pid>/stat), and the signal goes to the whole process GROUP:
  // systemd-inhibit forks the backstop command as a child, so terminating the leader alone
  // releases the inhibition but leaves that child running until its duration expires. Since the
  // holder was spawned detached, its pgid equals its pid.
  const verifyAndKillPosix = (record) => {
    if (!record || !record.pid) return;
    if (record.procStart === undefined || record.procStart === null) return;
    const live = parseProcStartTime(readFileText(`/proc/${record.pid}/stat`));
    if (live === null || live !== String(record.procStart)) return; // dead, or a recycled PID
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch {
      // Group signal refused (e.g. the leader already exited and the group is gone). Fall back
      // to the leader itself: that still releases the inhibition, which is the thing that
      // matters -- the orphaned backstop exits on its own timer.
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };

  if (env === 'wsl') {
    return {
      isAlive: (pid) => runPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`).status === 0,
      kill: verifyAndKill,
    };
  }

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e && e.code === 'EPERM'; // exists, just not signallable by us
    }
  };

  if (env === 'linux') return { isAlive, kill: verifyAndKillPosix };
  return { isAlive, kill: verifyAndKill };
}

// Probe the live Linux inhibition state: which backend is installed, whether anything is
// currently blocking idle, and the lid. The `--list` verdict is the Linux analogue of the
// Windows SYSTEM_REQUIRED probe, so `/keep-awake-status` supports the same differential check
// (True while a turn runs, False after it ends). gnome-session-inhibit's `--list` has a
// different format we don't parse, so there the verdict is honestly reported as unknown.
function probeLinuxState() {
  const inhibitor = resolveLinuxInhibitor({ resolveBin });
  const lid = parseLidState(readFileText(findLidPath() ?? ''));
  const notes = [];

  if (!inhibitor) {
    notes.push('(No inhibit backend found: install systemd, elogind, or gnome-session-inhibit.)');
    return { supported: false, lid, notes };
  }

  let systemBlocked = null;
  let ours = 0;
  if (inhibitor.name !== 'gnome-session-inhibit') {
    const res = spawnSync(inhibitor.path, ['--list'], {
      encoding: 'utf8',
      env: { ...process.env, SYSTEMD_PAGER: 'cat', SYSTEMD_COLORS: '0' },
    });
    if (!res.error && res.status === 0) {
      const rows = parseInhibitList(res.stdout);
      systemBlocked = isIdleBlocked(rows);
      ours = rows.filter((r) => r.who === LINUX_INHIBIT_WHO).length;
    }
  }

  notes.push(`Idle inhibitors held by Claude: ${ours}`);
  notes.push('(An idle inhibition also suppresses display-off and, on Plasma, the screen lock.)');
  if (lid) notes.push('(Closing the lid releases the inhibition, so the machine can suspend.)');

  return { supported: true, backend: `${inhibitor.name} (${inhibitor.path})`, systemBlocked, lid, notes };
}

// Read and print the cross-platform status report (the /keep-awake-status command). Writes to
// stdout so the user sees it; never throws out (a status read must not fail the session).
function runStatus(env, lifecycle) {
  const store = makeStore(lockDir());
  const locks = store.list().map((sessionId) => {
    const record = store.read(sessionId);
    return { sessionId, record, alive: record ? lifecycle.isAlive(record.pid) : false };
  });

  let state;
  if (env === 'win32' || env === 'wsl') {
    // Probe the live power state. On wsl this runs over interop and reports the HOST state.
    const probe = runPowerShell(readFileText(join(HERE, 'windows', 'probe-state.ps1')) ?? '');
    const parsed = parseProbeOutput(probe.stdout);
    state = { supported: true, ...parsed };
  } else if (env === 'linux') {
    state = probeLinuxState();
  } else {
    state = { supported: false };
  }

  process.stdout.write(formatStatusReport({ env, state, locks, now: new Date() }) + '\n');
}

function main() {
  const action = process.argv[2];
  if (action !== 'block' && action !== 'unblock' && action !== 'status') {
    // Misconfigured hook command -- do nothing, but never fail.
    return;
  }

  const env = detectEnvironment({ platform: process.platform, env: process.env, readFileText });
  const lifecycle = makeLifecycle(env);

  if (action === 'status') {
    runStatus(env, lifecycle);
    return;
  }

  const sessionId = sessionIdFromHookInput(readStdin());

  const options = {
    keepDisplay: toBoolFlag(process.env.CLAUDE_PLUGIN_OPTION_KEEP_DISPLAY_ON, false),
    maxHours: toLifetimeHours(process.env.CLAUDE_PLUGIN_OPTION_MAX_LIFETIME_HOURS, { default: 8, min: 1, max: 24 }),
  };

  const deps = {
    store: makeStore(lockDir()),
    isAlive: lifecycle.isAlive,
    // Windows and WSL2 launch through PowerShell's Start-Process; Linux spawns the inhibitor
    // directly (detached, its own process group).
    spawn: env === 'linux' ? launchPosixHolder : launchHolder,
    kill: lifecycle.kill,
    now: () => new Date(),
    log: (msg) => { try { process.stderr.write(`${msg}\n`); } catch { /* ignore */ } },
    holderBody: readFileText(join(HERE, 'windows', 'holder.ps1')) ?? '',
    interopAvailable: env === 'wsl' ? isInteropAvailable({ readFileText }) : false,
    resolveBin,
    lidPath: env === 'linux' ? findLidPath() : null,
  };

  runDispatch({ action, env, sessionId, options, deps });
}

// Only run when invoked directly (keeps the module import-safe for any future test harness).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch {
    // Last-resort guard: a hook must never break Claude.
  }
  process.exit(0);
}
