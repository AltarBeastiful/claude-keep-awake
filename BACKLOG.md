# Backlog

Ideas worth doing that are not part of any open change. Nothing here is committed to.

## Fall back to the working directory when the session has no name yet

Naming the session in the inhibit reason is done, but the name only exists from the second turn
onwards, because Claude Code assigns it after the first exchange. Until then the reason is
`Working on session c4b94408-...` and you are back to not knowing which window it is.

`cwd` is in the hook payload from the very first `UserPromptSubmit`, so its basename is
available exactly when the name is not. `Working on DNP (session c4b94408-...)` beats the bare
id for the one turn that needs it.

What stopped this going in with the rest: the two would be indistinguishable in the output, so a
reader cannot tell whether `DNP` is a session name or a directory, and two sessions in the same
project would show the same label. Worth a distinguishing mark of some kind if it is done at all.

## Re-title the holder when the session is re-titled

The reason string is fixed when `systemd-inhibit` launches and there is no way to update it in
place, so a session that gets re-titled mid-flight keeps advertising the name it had when the
holder started. The lock records that name deliberately, so `/keep-awake-status` agrees with
`--list` rather than contradicting it.

Fixing it properly means relaunching the holder on a title change, which trades a real gap in
the inhibition for a cosmetic gain. Almost certainly not worth it, written down so it is not
rediscovered as a bug.

## Consider making the session name opt-out

The reason string is readable by every user on the machine, and a session name is derived from
what the user typed, so this puts a little of it into a system wide list. Harmless on a personal
laptop, less so on a shared box.

It is on by default because the whole point is finding the right window, which an off-by-default
option would not achieve. If someone raises the exposure, a third `userConfig` option is the
answer, weighed against adding config surface for a display string.
