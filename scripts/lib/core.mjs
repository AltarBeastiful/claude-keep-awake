// Pure, dependency-injected helpers for the claude-keep-awake cross-platform dispatcher.
//
// Everything here is side-effect-free: callers pass in `env`, a `readFileText` reader,
// and a `platform` string, so the same logic is exercised identically on every OS and in
// unit tests. The thin entry point (dispatch.mjs) supplies the real implementations.

// ---------------------------------------------------------------------------
// Option normalization (ports the v1.1.0 _common.ps1 converters)
// ---------------------------------------------------------------------------

// Normalize a user-config string (from a CLAUDE_PLUGIN_OPTION_* env var) to a bool.
// Empty/unrecognized falls back to `fallback`, so the plugin still works if the value was
// skipped or substituted as empty.
export function toBoolFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  switch (String(value).trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true;
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false;
    default:
      return fallback;
  }
}

// Normalize a user-config string to a backstop duration in hours, clamped to [min, max].
// Empty/non-numeric falls back to `default`.
export function toLifetimeHours(value, { default: dflt = 8, min = 1, max = 24 } = {}) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ---------------------------------------------------------------------------
// Session id handling
// ---------------------------------------------------------------------------

// session_id is normally a UUID, but sanitize anyway so it is always a safe filename and
// carries no shell/PowerShell-meaningful characters. Empty/whitespace collapses to 'default'
// so block and unblock still pair up (degrading to global, non-isolated behavior).
export function sanitizeSessionId(id) {
  const s = id === undefined || id === null ? '' : String(id);
  if (s.trim() === '') return 'default';
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Read the hook JSON from stdin and return its sanitized session_id. Falls back to 'default'
// when stdin is empty or unparseable (e.g. invoked outside a hook).
export function sessionIdFromHookInput(raw) {
  if (!raw) return 'default';
  try {
    const parsed = JSON.parse(raw);
    return sanitizeSessionId(parsed && parsed.session_id);
  } catch {
    return 'default';
  }
}

// Parse the hook stdin JSON. Returns null on empty or unparseable input (e.g. a manual run
// outside a hook), which every caller below treats as "no information".
export function parseHookInput(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // A hook payload is always a JSON object; an array or scalar is not one.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background work outliving the turn
// ---------------------------------------------------------------------------

// Task statuses that mean the work is over. Claude Code's vocabulary is
// pending | running | completed | failed | killed | paused; the first, second and last are all
// still in flight. Anything unrecognized (a status a future version adds) counts as in flight
// too, so the unknown case errs toward staying awake -- the same bias as the pending-permission
// case in the README.
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'killed'];

// The in-flight subset of a Stop payload's `background_tasks`.
//
// Claude Code documents the field as: "In-flight background work (running/pending +
// backgrounded) registered in this session. Lets hooks distinguish 'session is done' from
// 'session is paused waiting for background work to wake it'. Empty array when nothing is in
// flight." Entries are { id, type, status, description, command?, agent_type?, server?, tool?,
// name? }, where `type` is a friendly label: 'shell', 'subagent', 'monitor', 'workflow'.
//
// A missing field (an older Claude Code that does not send it) yields [], so the release path
// behaves exactly as it did before this signal existed.
export function inFlightBackgroundTasks(input) {
  const tasks = input && Array.isArray(input.background_tasks) ? input.background_tasks : [];
  return tasks.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    return !TERMINAL_TASK_STATUSES.includes(String(t.status ?? '').trim().toLowerCase());
  });
}

// One-line, log-safe summary of in-flight tasks: "shell(running): npm test, subagent(running)".
// Newlines are collapsed so a task description can never forge extra log lines.
export function summarizeBackgroundTasks(tasks, { max = 3 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const shown = list.slice(0, max).map((t) => {
    const type = String(t.type ?? 'task').replace(/\s+/g, ' ').trim() || 'task';
    const status = String(t.status ?? '?').replace(/\s+/g, ' ').trim() || '?';
    const what = String(t.command ?? t.description ?? '').replace(/\s+/g, ' ').trim();
    return `${type}(${status})${what ? `: ${what.slice(0, 60)}` : ''}`;
  });
  if (list.length > shown.length) shown.push(`+${list.length - shown.length} more`);
  return shown.join(', ');
}

// Decide whether an `unblock` should be deferred instead of performed.
//
// A turn ending is not the same thing as the session being idle. A backgrounded shell or
// subagent outlives the turn, so releasing on `Stop` lets the machine idle-sleep in the middle
// of it -- and that cannot self-heal, because the sleeping machine suspends the very task whose
// completion notification would have re-armed the holder.
//
// Only `Stop` defers. `SessionEnd` must always release: the session is gone, so nothing will
// ever come back to release it. An absent or unrecognized `hook_event_name` also releases,
// preserving the previous behavior. The max-lifetime backstop stays the final ceiling, and the
// stale-lock sweep in `block` still reaps a holder whose process died.
export function shouldDeferRelease(input) {
  if (!input || input.hook_event_name !== 'Stop') return { defer: false, tasks: [] };
  const tasks = inFlightBackgroundTasks(input);
  return { defer: tasks.length > 0, tasks };
}

// ---------------------------------------------------------------------------
// Status reporting (cross-platform /keep-awake-status)
// ---------------------------------------------------------------------------

// Parse the two marker lines emitted by the Windows power-state probe, tolerating any
// surrounding noise (Add-Type "Preparing modules" progress, CLIXML). Returns nulls for any
// marker not found (state unknown).
export function parseProbeOutput(stdout) {
  const text = String(stdout || '');
  const read = (key) => {
    const m = text.match(new RegExp(`${key}=(True|False)`, 'i'));
    return m ? m[1].toLowerCase() === 'true' : null;
  };
  return { systemBlocked: read('SYSTEM_REQUIRED'), displayOn: read('DISPLAY_REQUIRED') };
}

// Build the human-readable status report. Pure: callers supply the detected env, the probed
// power state, and the lock list (each annotated with liveness).
//
// state fields beyond `supported` are all optional, so each backend reports only what it can
// actually observe: Windows/WSL2 have a display verdict, Linux has a backend name.
export function formatStatusReport({ env, state, locks, now }) {
  const lines = [];
  lines.push(`Environment          : ${env}`);

  if (state && state.supported) {
    if (state.backend) lines.push(`Backend              : ${state.backend}`);
    lines.push(`System sleep blocked : ${state.systemBlocked === null ? 'unknown' : state.systemBlocked ? 'True' : 'False'}`);
    if (state.displayOn !== undefined) {
      lines.push(`Display kept on      : ${state.displayOn === null ? 'unknown' : state.displayOn ? 'True' : 'False'}`);
    }
    if (env === 'wsl') {
      lines.push('(WSL2: the Windows HOST is kept awake via interop, not the Linux VM.)');
    }
    for (const note of state.notes || []) lines.push(note);
  } else {
    lines.push(`Platform '${env}' backend: not implemented -- keep-awake is a no-op here.`);
    for (const note of (state && state.notes) || []) lines.push(note);
  }

  lines.push('Active keep-awake workers:');
  if (!locks || locks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const l of locks) {
      const r = l.record || {};
      lines.push(`  session ${l.sessionId}  platform ${r.platform ?? '?'}  pid ${r.pid ?? '?'}  alive ${l.alive ? 'True' : 'False'}  (started ${r.startedAt ?? '?'})`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

// Read a /proc file as text, tolerating absence: the injected reader returns null when the
// path is missing or unreadable (e.g. on Windows, where /proc does not exist at all).
function readProc(readFileText, path) {
  try {
    const text = readFileText(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// True if we are running inside WSL2 (a Linux userland hosted by Windows). Detected by, in
// order: the interop env vars WSL injects, then the "microsoft" marker the WSL kernel carries
// in /proc/sys/kernel/osrelease. Either signal alone is sufficient.
function isWsl({ env, readFileText }) {
  if (env && (env.WSL_INTEROP || env.WSL_DISTRO_NAME)) return true;
  const osrelease = readProc(readFileText, '/proc/sys/kernel/osrelease');
  if (osrelease && /microsoft/i.test(osrelease)) return true;
  return false;
}

// Classify the runtime into one of the four backends the dispatcher knows about.
// `platform` is a process.platform value ('win32' | 'darwin' | 'linux' | ...).
export function detectEnvironment({ platform, env, readFileText }) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') {
    return isWsl({ env, readFileText }) ? 'wsl' : 'linux';
  }
  // Unknown platform: hand it back verbatim so the dispatcher treats it as an unsupported
  // (no-op) backend rather than guessing.
  return platform;
}

// ---------------------------------------------------------------------------
// Lock record (per-session, JSON; carried over from v1.1.0, now platform-agnostic)
// ---------------------------------------------------------------------------

// Serialize a lock record to the text written into <session>.lock.
export function serializeLock(record) {
  return JSON.stringify(record);
}

// Parse a lock file's text back to a record, tolerating garbage: returns null for
// non-JSON, non-objects, or records without a usable numeric pid (so callers treat a
// corrupt lock the same as a missing one and reap it).
export function parseLock(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.pid)) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// PowerShell holder construction (shared by win32 + wsl, delivered via -EncodedCommand)
// ---------------------------------------------------------------------------

// The human-readable reason string surfaced by Windows power tooling (powercfg /requests).
export function buildReason({ sessionId, keepDisplay }) {
  let reason = `Claude Code keep-awake (session ${sessionId})`;
  if (keepDisplay) reason += ' [display]';
  return reason;
}

// PowerShell single-quoted string literal: wrap in single quotes and double any embedded
// single quotes (PS escaping). Session ids are pre-sanitized, but escape anyway for safety.
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Build the prelude that defines the holder's inputs as safe PowerShell literals. It is
// prepended to holder.ps1's body so the encoded command is fully self-contained (no params,
// no env dependence). maxHours is validated to a finite number before being emitted bare.
export function buildHolderPrelude({ reason, keepDisplay, maxHours }) {
  const hours = Number(maxHours);
  if (!Number.isFinite(hours)) throw new TypeError(`maxHours must be finite, got ${maxHours}`);
  return [
    `$Reason = ${psSingleQuote(reason)}`,
    `$KeepDisplay = $${keepDisplay ? 'true' : 'false'}`,
    `$MaxHours = ${hours}`,
    '',
  ].join('\n');
}

// Encode a PowerShell script for `powershell.exe -EncodedCommand`: base64 of the script's
// UTF-16LE (little-endian) bytes -- the exact form PowerShell decodes.
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// Build the command + argv to launch the encoded holder. Identical for native Windows and
// WSL2 (interop requires the `.exe` suffix; on Windows `powershell.exe` resolves on PATH).
export function buildPowerShellHolderInvocation({ script }) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellCommand(script)],
  };
}

// Build the short-lived PowerShell launcher that starts the detached holder and prints its
// real PID to stdout. Start-Process is the survival mechanism proven by v1.1.0 (a
// Start-Process'd background process outlives the hook that launched it, unlike a process tied
// into the launcher's job object); -PassThru yields the holder's true OS PID. The same
// launcher works for native Windows and for WSL2 over interop -- in the WSL2 case the printed
// PID is the real Windows holder PID, so unblock can release it with Stop-Process -Id.
export function buildStartProcessLauncher({ command, args }) {
  const argList = args.map((a) => psSingleQuote(a)).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${psSingleQuote(command)} -ArgumentList @(${argList}) -WindowStyle Hidden -PassThru`,
    // Capture the holder's start time from the SAME -PassThru result (no extra process query)
    // so unblock can prove the recorded PID is still our holder before terminating it -- a
    // recycled PID gets a different start time. Guarded: a missing StartTime can't fail launch.
    '$ticks = try { $p.StartTime.Ticks } catch { 0 }',
    "[Console]::Out.Write([string]$p.Id + ' ' + [string]$ticks)",
  ].join('\n');
}

// Parse the launcher's stdout ("<pid> <startTicks>") into { pid, procStart }. pid is a Number;
// procStart is kept as a STRING because .NET DateTime.Ticks (~6.4e17) exceeds JS's safe-integer
// limit and would round if parsed -- breaking the exact equality the kill-time check relies on.
// Either field is null if absent/unparseable.
export function parseHolderLaunch(stdout) {
  const text = String(stdout || '');
  const pidM = text.match(/(\d+)/);
  const pid = pidM ? Number.parseInt(pidM[1], 10) : null;
  const bothM = text.match(/(\d+)\s+(\d+)/);
  const procStart = bothM ? bothM[2] : null;
  return { pid, procStart };
}

// Build a PowerShell command that terminates the holder ONLY if the live process with this PID
// still has the recorded start time. Run at unblock (the one place we kill), this closes the
// PID-reuse hole: a recycled PID belonging to an unrelated process never matches and is never
// terminated. Checked and killed in one call, so there's no check-then-kill race.
export function buildVerifyAndKillCommand(pid, procStart) {
  return [
    `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($proc) {',
    '  $ticks = try { $proc.StartTime.Ticks } catch { -1 }',
    `  if ($ticks -eq ${procStart}) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`,
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Linux inhibitor construction (bare-metal Linux; NOT WSL2, which delegates to the host)
// ---------------------------------------------------------------------------

// The WHO field every Claude holder registers under. Constant (no session id) so `status` can
// pick our rows out of `--list` by exact match; the session id travels in WHY instead.
export const LINUX_INHIBIT_WHO = 'Claude Code';

// The WHY field. Desktop UIs render an inhibition as "<WHO> is blocking screen locking.
// (<WHY>)" -- Plasma's battery applet does exactly this -- so WHY reads as a continuation of
// WHO rather than repeating it, the way vlc reports "Playing some media.".
export function buildLinuxReason({ sessionId, keepDisplay }) {
  return `Working on session ${sessionId}${keepDisplay ? ' [display]' : ''}`;
}

// Inhibit backends in preference order. All three take "hold this inhibition for as long as
// COMMAND runs", so the holder is `<backend> <flags> <backstop-command>` and releasing is just
// terminating it.
//
//   systemd-inhibit        systemd (the overwhelming majority of desktop Linux)
//   elogind-inhibit        elogind: Void, Artix, Gentoo OpenRC, Devuan, Alpine -- same CLI
//   gnome-session-inhibit  GNOME's own session API, for GNOME setups that drive their idle
//                          timer from gnome-session rather than from logind
//
// Every backend inhibits *idle* only -- never `sleep`. See buildLinuxHolderInvocation.
export const LINUX_INHIBIT_BACKENDS = ['systemd-inhibit', 'elogind-inhibit', 'gnome-session-inhibit'];

// Pick the first available backend. `resolveBin(name)` is injected (a PATH lookup in
// dispatch.mjs) so this stays pure and testable off-Linux. Returns null when none is present,
// which the caller turns into the existing benign no-op.
export function resolveLinuxInhibitor({ resolveBin }) {
  if (typeof resolveBin !== 'function') return null;
  for (const name of LINUX_INHIBIT_BACKENDS) {
    const path = resolveBin(name);
    if (path) return { name, path };
  }
  return null;
}

// None of these tools can hold an inhibition without wrapping a command, so the command IS the
// max-lifetime backstop: the inhibition lives exactly as long as this `sleep` does. That is
// also how `max_lifetime_hours` parity is reached, since systemd-inhibit has no timeout flag.
export function buildBackstopCommand({ maxHours }) {
  const hours = Number(maxHours);
  if (!Number.isFinite(hours)) throw new TypeError(`maxHours must be finite, got ${maxHours}`);
  return ['sleep', String(Math.max(1, Math.round(hours * 3600)))];
}

// Build the detached holder invocation for bare-metal Linux.
//
// `--what=idle`, deliberately, for every configuration. This is the same inhibition a media
// player holds while playing, and the difference from `sleep` is not cosmetic:
//
//   * `idle` says the true thing -- this session is not inactive -- and it is what every
//     desktop idle timer (logind's IdleAction, KDE PowerDevil, GNOME) consults. It stops the
//     machine idling into suspend, and leaves every *deliberate* suspend path working:
//     `systemctl suspend`, the power menu, and closing the lid all still suspend.
//   * `sleep` would take those away. `--what=sleep --mode=block` tells logind to refuse
//     suspend outright, so closing the lid would silently do nothing and a laptop would cook
//     in a bag. Plasma's battery applet spells the difference out: an `idle` inhibition reads
//     "blocking screen locking", a `sleep:idle` one reads "blocking sleep and screen locking".
//   * `keep_display_on` is not a separate lever here: an idle inhibition already suppresses
//     display-off (and, on Plasma, screen locking) on the desktops that honor it. The option
//     still tags the reason string so `--list` shows what the session asked for.
export function buildLinuxHolderInvocation({ inhibitor, reason, maxHours }) {
  const backstop = buildBackstopCommand({ maxHours });

  if (inhibitor.name === 'gnome-session-inhibit') {
    return {
      command: inhibitor.path,
      args: ['--app-id', LINUX_INHIBIT_WHO, '--reason', reason, '--inhibit', 'idle', ...backstop],
    };
  }

  // systemd-inhibit / elogind-inhibit share this CLI surface exactly.
  return {
    command: inhibitor.path,
    args: ['--what=idle', `--who=${LINUX_INHIBIT_WHO}`, `--why=${reason}`, '--mode=block', ...backstop],
  };
}

// Parse `systemd-inhibit --list` / `elogind-inhibit --list` into rows. The columns are
// whitespace-separated but WHO and WHY may themselves contain spaces, so anchor on the
// unambiguous middle (UID, USER, PID -- digits, word, digits) and on the MODE terminator.
// Header and the "N inhibitors listed." footer simply don't match and are dropped.
export function parseInhibitList(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(.*?)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*?)\s+(block|delay)\s*$/);
    if (!m) continue;
    rows.push({
      who: m[1].trim(),
      uid: Number.parseInt(m[2], 10),
      user: m[3],
      pid: Number.parseInt(m[4], 10),
      comm: m[5],
      what: m[6],
      why: m[7].trim(),
      mode: m[8],
    });
  }
  return rows;
}

// True if any listed inhibitor actually blocks idle right now -- the Linux analogue of the
// Windows SYSTEM_REQUIRED probe. `what` is a colon-joined set ("sleep:idle"), so match a whole
// element, not a substring.
export function isIdleBlocked(rows) {
  return (rows || []).some((r) => r.mode === 'block' && String(r.what).split(':').includes('idle'));
}

// Read a process's start time (field 22 of /proc/<pid>/stat) as the PID-reuse-safe identity,
// mirroring what StartTime.Ticks does on Windows. Field 2 is the comm, which is parenthesized
// and may itself contain spaces and parens -- so split only AFTER the last ')'. Returned as a
// STRING so the identity check is exact string equality, as on Windows.
export function parseProcStartTime(statText) {
  if (!statText) return null;
  const text = String(statText);
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  // fields[0] is stat field 3 (state), so stat field 22 is fields[19].
  const starttime = fields[19];
  return /^\d+$/.test(starttime || '') ? starttime : null;
}

// Whether Windows interop is actually usable from this WSL distro. WSL registers a binfmt_misc
// handler (WSLInterop, or WSLInterop-late on newer builds) that lets Linux exec Windows .exe
// files; an entry whose body begins with "enabled" means interop is live. Users can disable
// interop via /etc/wsl.conf, in which case launching powershell.exe would fail -- callers use
// this to degrade to a benign no-op instead.
export function isInteropAvailable({ readFileText }) {
  for (const path of [
    '/proc/sys/fs/binfmt_misc/WSLInterop',
    '/proc/sys/fs/binfmt_misc/WSLInterop-late',
  ]) {
    const body = readProc(readFileText, path);
    if (body && /^\s*enabled/i.test(body)) return true;
  }
  return false;
}
