# keep-awake

[![CI](https://github.com/juemerson-at-purestorage/claude-keep-awake/actions/workflows/ci.yml/badge.svg)](https://github.com/juemerson-at-purestorage/claude-keep-awake/actions/workflows/ci.yml)

A [Claude Code](https://code.claude.com) plugin that keeps your **computer** from going to
sleep while Claude is working, and lets it sleep normally again as soon as the turn ends.

If you kick off a long task and walk away, your machine no longer dozes off mid-run. It is
scoped per Claude session, so running several Claude windows at once is safe: one window
finishing never lets another window's machine sleep.

## Platform support

| Platform | Status | Mechanism |
|----------|--------|-----------|
| **Windows** | ✅ Implemented | `PowerSetRequest(PowerRequestSystemRequired)` held by a detached `powershell.exe` |
| **WSL2** (on Windows) | ✅ Implemented | Delegates to the **Windows host** over interop (a keep-awake *inside* WSL2 can't stop the host sleeping) |
| **Linux** (bare metal) | ✅ Implemented | A detached `systemd-inhibit` (or `elogind-inhibit`, or `gnome-session-inhibit`) holding an **idle** inhibition |
| **macOS** | ⏳ Detected, no-op | Reserved for `caffeinate` — contributions welcome |

On macOS, and on Linux with none of the three inhibit binaries installed, the plugin detects
the environment and exits cleanly (a harmless no-op), so it is safe to install anywhere.

### Requirements

**Node.js must be on your `PATH`.** Every hook runs through a single Node dispatcher
(`scripts/dispatch.mjs`), which is what lets one plugin work across Windows, WSL2, macOS, and
Linux. Node ships with npm installs of Claude Code; if you used the native installer without a
separate Node, install it:

- **Windows:** `winget install OpenJS.NodeJS`
- **macOS:** `brew install node`
- **Linux/WSL2:** your distro's package (e.g. `sudo apt install nodejs`)

If Node isn't present the hooks simply don't run — a benign, non-blocking no-op — and your
machine is never kept awake. (Need a pure-PowerShell, no-Node Windows build? Use the tagged
**v1.1.0** release.)

## How it works

A single Node dispatcher backs every hook and branches per environment — no `shell` field, so
the same `hooks.json` works everywhere:

- On **`UserPromptSubmit`** → `node dispatch.mjs block`: detect the environment, then start a
  detached, session-scoped *holder* that blocks idle system sleep.
- On **`Stop`** and **`SessionEnd`** → `node dispatch.mjs unblock`: stop that session's holder.

The dispatcher records each holder in a per-session JSON lock file
(`<os-temp>/claude-keep-awake/<session_id>.lock`) and releases by the recorded PID.

**Windows.** The holder is a detached `powershell.exe` (launched via `Start-Process`,
delivered as an `-EncodedCommand`) holding a
[`PowerSetRequest`](https://learn.microsoft.com/windows/win32/api/winnt/ne-winnt-power_request_type)
of type `PowerRequestSystemRequired`, which blocks automatic system sleep while still letting
the monitor dim. With [`keep_display_on`](#configuration) it also holds
`PowerRequestDisplayRequired`. Windows clears the request automatically when the holder exits.

**WSL2.** A keep-awake running *inside* WSL2 can't help — when Windows sleeps it suspends the
entire WSL2 VM, and `systemd-inhibit` inside the VM is useless. So the dispatcher delegates to
the **Windows host**: over [interop](https://learn.microsoft.com/windows/wsl/interop) it launches
the *same* `powershell.exe` holder on the host, captures the host's real PID, and on unblock
terminates it by PID (`Stop-Process` over interop). If interop is disabled, it degrades to a
benign no-op.

**Linux.** The holder is a detached
[`systemd-inhibit`](https://www.freedesktop.org/software/systemd/man/systemd-inhibit.html)
holding `--what=idle --mode=block`, which is what every desktop idle timer consults (logind's
own `IdleAction`, KDE PowerDevil, GNOME). If `systemd-inhibit` is absent the dispatcher falls
back to `elogind-inhibit` (Void, Artix, Gentoo OpenRC, Devuan, Alpine; same CLI) and then to
`gnome-session-inhibit`; with none of them installed it is a benign no-op.

**It inhibits `idle`, never `sleep`**, and on Linux that distinction is the whole design. It is
the same inhibition a media player holds while playing, so the behaviour is the one you already
know from watching a video:

| `--what=` | Idle sleep | Screen lock / blank | `systemctl suspend` | Closing the lid |
|---|---|---|---|---|
| `idle` (what this plugin uses, and vlc) | blocked | blocked | works | **suspends** |
| `sleep:idle` | blocked | blocked | refused | does nothing |

`--what=sleep --mode=block` tells logind to refuse suspend outright, which takes away the power
menu and the lid, so a laptop would sit in a bag running hot. Plasma's battery applet names the
two cases in as many words: an `idle` inhibition reads *"is blocking screen locking"*, a
`sleep:idle` one reads *"is blocking sleep and screen locking"*. This plugin is always the
first kind.

`keep_display_on` is not a separate lever on Linux: an idle inhibition already suppresses
display-off, and on Plasma it also suppresses the screen lock. The option still tags the reason
string, so `systemd-inhibit --list` shows what the session asked for.

The reason string names the session, so `--list` tells you which window is holding the machine
awake rather than only that something is:

```
WHO          PID      WHAT  WHY                                    MODE
Claude Code  3552102  idle  Working on Test something (c4b94408)    block
```

The name is the one `/status` shows, followed by a short session id in the style of a git short
SHA. The full id stays on the lock file and in `/keep-awake-status`. The name comes from the
transcript and Claude Code assigns it after the first exchange, so the opening turn of a new
session shows `Working on session c4b94408` instead. Note that the reason string is readable by
every user on the machine, and a session name is derived from what you typed.

### Robustness

- **Idempotent:** re-prompting in a session that already has a live holder just refreshes the
  lock; it never stacks duplicate holders.
- **Stale-lock reaping:** each `block` sweeps lock files whose recorded process is gone.
- **PID-reuse-safe release:** the holder's start time is captured at launch (`StartTime.Ticks`
  on Windows, field 22 of `/proc/<pid>/stat` on Linux) and `unblock` only terminates the PID if
  its live start time still matches — so a recycled PID belonging to an unrelated process is
  never signalled. On Linux the signal goes to the whole process *group*, because
  `systemd-inhibit` runs the backstop as a child that would otherwise be stranded.
- **Max-lifetime backstop:** if a session crashes without firing `Stop`/`SessionEnd`, its
  holder self-releases after a hard ceiling (default 8 hours) instead of surviving until reboot.
- **Hooks never block Claude:** the dispatcher wraps everything and always exits 0; a missing
  `node`/`powershell.exe`, disabled interop, or an unsupported OS all degrade to a no-op.

### When your machine sleeps vs. stays awake

The block is held only while a turn is actively running:

- **Claude is working** (thinking, running commands, including long-running commands and
  subagents) — the system stays awake.
- **The turn finishes with nothing left in flight** — the holder is released (on `Stop`), so
  your machine sleeps normally. Nothing to do; this is automatic, so walking away after Claude
  is done does *not* keep the machine up.
- **The turn finishes but background work is still running** — a backgrounded shell
  (`run_in_background`), subagent, monitor or workflow — the machine **stays awake**. `Stop`
  reports that work in `background_tasks`, so the release is deferred until a later `Stop` finds
  nothing in flight. Without this the machine could idle-sleep in the middle of a background
  build, and it could not recover on its own: sleeping suspends the very task whose completion
  notification would have re-armed the holder. `SessionEnd` always releases regardless — once
  the session is gone nothing would ever come back to do it.
- **Claude is paused mid-turn waiting for you to approve a permission prompt** — the machine
  **stays awake** while the prompt is pending. This is deliberate: Claude Code fires no hook
  at the instant you approve, and a pending permission prompt is indistinguishable from a
  long-running command in the hook stream, so releasing during the wait could let the machine
  sleep *in the middle of the command you just approved*. Staying awake is the safe choice. If
  you've stepped away and don't intend to approve, cancel the turn (Esc) — that returns to the
  waiting-for-prompt state above, and the machine can sleep.

## Install

```
/plugin marketplace add github:juemerson-at-purestorage/claude-keep-awake
/plugin install keep-awake@claude-keep-awake
```

> The repository is both the plugin and its own marketplace, so a single
> `marketplace add` is enough.

Make sure [Node.js is installed](#requirements), then restart Claude Code (or reload) so the
hooks register. Nothing else to configure — there are no paths to set up.

## Configuration

The plugin works out of the box; these options are optional. Claude Code prompts for them
when you enable the plugin and stores them in your `settings.json` under `pluginConfigs`.

| Option | Default | What it does |
|--------|---------|--------------|
| **Keep the display on too** (`keep_display_on`) | off | Also keeps the monitor lit while Claude works, not just the system awake. **Does not prevent the lock screen** on Windows (see below). No effect on Linux, where the idle inhibition already covers the display. |
| **Max keep-awake hours** (`max_lifetime_hours`) | `8` | Safety backstop: a holder self-releases after this many hours (range 1–24) if a session ever crashes without cleaning up. No normal turn comes close. |

> **On Windows, `keep_display_on` keeps the screen powered, not unlocked.** It prevents the
> monitor from dimming/turning off on the power-idle timer, but it does **not** stop your
> screensaver or your organization's inactivity policy from locking the machine — those run off
> the *input*-idle timer, which power requests don't touch. So expect: system never sleeps,
> screen stays on, but the machine can still lock.
>
> **On Linux the split doesn't exist.** There is one idle notion, so the inhibition that keeps
> the system awake also keeps the display on, and on Plasma it suppresses the screen lock too.
> That happens with or without `keep_display_on`, which is why the option changes nothing here.

**Changing options later:** Claude Code captures these at *enable* time and doesn't yet
offer an in-place editor. To change them, either re-enable the plugin via `/plugin`, or edit
the `pluginConfigs["keep-awake@claude-keep-awake"].options` block in your `settings.json`
directly.

## Verify it works

Run the bundled status command (no admin needed):

```
/keep-awake-status
```

or directly:

```
node "<plugin-root>/scripts/dispatch.mjs" status
```

It reports the detected environment, a `System sleep blocked : True/False` verdict (the
Windows **host** state on WSL2, the live `--list` verdict on Linux), whether the display is
being kept on, and any active holders with their session name, session id, platform, PID, and
liveness. On Linux it also names the resolved backend. The decisive test is differential —
submit a prompt and you should see `True` while Claude works, returning to `False` after the
turn ends.

## Limitations

- macOS is not implemented yet (clean no-op there) — contributions welcome.
- A holder orphaned by a hard crash persists until the max-lifetime backstop fires (default
  8 hours, configurable; the next prompt in any session also reaps it once its process is gone).
- On Windows, never prevents the **lock screen** — only system sleep and (optionally)
  display-off. On Linux the idle inhibition does suppress the Plasma lock screen as a
  side-effect. See [Configuration](#configuration).
- On Windows, by default blocks *system* sleep only and lets the display turn off; set
  `keep_display_on` to keep the monitor lit as well. On Linux the display is always covered.
- On Linux, never blocks a *deliberate* suspend. Closing the lid or picking Sleep from the
  power menu still suspends the machine, mid-turn, exactly as it does while a video is playing.
- Requires Node.js on `PATH` (see [Requirements](#requirements)).

## Architecture & contributing

Everything routes through the Node dispatcher; the decision logic is pure and unit-tested,
and the side effects are concentrated in one file:

```
scripts/
  dispatch.mjs          universal entry: stdin → session id, detect env, run the lock model
  lib/core.mjs          pure helpers: detection, option parsing, locks, holder/launcher, status
  lib/dispatch-core.mjs orchestration: planHolder() + runDispatch() (dependency-injected)
  windows/holder.ps1    the PowerSetRequest holder body (win32 + wsl, via -EncodedCommand)
  windows/probe-state.ps1  the power-state probe used by `status`
hooks/hooks.json        platform-agnostic hook wiring (node dispatch.mjs block|unblock)
tests/node/             node --test unit suite for the dispatcher
tests/windows/          PSScriptAnalyzer settings for the remaining PowerShell
```

**Adding macOS** is a focused change: teach `planHolder()` in
`scripts/lib/dispatch-core.mjs` to return a holder for that environment instead of `null`, and
have `dispatch.mjs` launch/terminate it (the Linux backend is the worked example). The two
`userConfig` options map like this:

| Concept | Windows / WSL2 | Linux | macOS |
|---------|----------------|-------|-------|
| Block system sleep (always) | `PowerRequestSystemRequired` | `systemd-inhibit --what=idle --mode=block` | `caffeinate -i` |
| `keep_display_on` | `PowerRequestDisplayRequired` | covered by the idle inhibition (no separate flag) | `caffeinate -d` |
| `max_lifetime_hours` backstop | holder self-exit timer | duration of the wrapped `sleep` | `caffeinate -t` |

Notes: neither `systemd-inhibit` nor `caffeinate` has a way to hold an inhibition without
wrapping a command, so the backstop is the wrapped command's duration. `caffeinate -t` gives
macOS the same ceiling for free.

## Development

```bash
npm test        # node --test over tests/node/  (pure, runs on any OS)
```

Or directly: `node --test` (auto-discovers the `tests/node/` suite).

CI runs on every push and pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

- **Validate manifests** (platform-neutral): every `*.json` parses, and `plugin.json` /
  `marketplace.json` / `package.json` agree on the plugin name and version.
- **Node dispatcher tests**: `node --test` on Ubuntu and Windows.
- **Windows PowerShell lint**:
  [PSScriptAnalyzer](https://github.com/PowerShell/PSScriptAnalyzer) over `scripts/`.

The Linux suite (`tests/node/linux.test.mjs`) asserts the exact argv for every backend and
option permutation on any OS, and adds one integration test that launches a real inhibitor,
finds it in `--list`, and checks the group kill releases it. That test skips itself unless
`systemd-inhibit`/`elogind-inhibit` is actually present, so it runs on the Ubuntu CI lane and
is skipped on Windows.

The detached-holder *survival* across the hook process exiting is the one behavior that can
only be confirmed by a real plugin run (test harnesses reap background processes); the rest of
the lifecycle is covered by the Node suite and the [status](#verify-it-works) differential.

## License

[Apache-2.0](./LICENSE).
