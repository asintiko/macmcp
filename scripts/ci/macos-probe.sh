#!/bin/bash
# Throwaway diagnostic for GitHub macOS runners. Every step is allowed to fail; the output
# tells us which desktop capabilities the real macOS test-suite can rely on in CI.
set -u
section() { echo; echo "=== $1 ==="; }

section "system"
sw_vers
uname -m
swiftc --version 2>&1 | head -2
echo "SHELL=$SHELL TMPDIR=$TMPDIR"
getconf DARWIN_USER_TEMP_DIR
ps -o pid=,comm= -p $$ -p $PPID

section "sandbox-exec"
ls -la /usr/bin/sandbox-exec
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true; echo "allow-default rc=$?"
mkdir -p "$RUNNER_TEMP/sbx/project" "$RUNNER_TEMP/sbx/outside"
echo secret > "$RUNNER_TEMP/sbx/outside/secret.txt"
PROJECT=$(cd "$RUNNER_TEMP/sbx/project" && pwd -P)
OUTSIDE=$(cd "$RUNNER_TEMP/sbx/outside" && pwd -P)
echo "PROJECT=$PROJECT"
PROFILE='(version 1)(allow default)(deny file-write* (subpath (param "OUTSIDE")))(deny file-read* (subpath (param "OUTSIDE")))'
/usr/bin/sandbox-exec -p "$PROFILE" -DOUTSIDE="$OUTSIDE" -- /bin/zsh -c "cat '$OUTSIDE/secret.txt'"; echo "read-outside rc=$? (expect non-zero)"
/usr/bin/sandbox-exec -p "$PROFILE" -DOUTSIDE="$OUTSIDE" -- /bin/zsh -c "echo x > '$OUTSIDE/new.txt'"; echo "write-outside rc=$? (expect non-zero)"
/usr/bin/sandbox-exec -p "$PROFILE" -DOUTSIDE="$OUTSIDE" -- /bin/zsh -c "echo x > '$PROJECT/new.txt' && cat '$PROJECT/new.txt'"; echo "write-inside rc=$? (expect 0)"

section "screencapture"
screencapture -x "$RUNNER_TEMP/full.png"; echo "full rc=$?"
ls -la "$RUNNER_TEMP/full.png"
sips -g pixelWidth -g pixelHeight "$RUNNER_TEMP/full.png"
screencapture -x -R0,0,400,300 "$RUNNER_TEMP/region.png"; echo "region rc=$?"
sips -g pixelWidth -g pixelHeight "$RUNNER_TEMP/region.png"
screencapture -x -C -t jpg "$RUNNER_TEMP/cursor.jpg"; echo "cursor-jpg rc=$?"
ls -la "$RUNNER_TEMP/cursor.jpg"

section "sips"
sips -z 100 160 "$RUNNER_TEMP/full.png" --out "$RUNNER_TEMP/small.png"; echo "resize rc=$?"
sips -g pixelWidth -g pixelHeight "$RUNNER_TEMP/small.png"
sips -s format jpeg -s formatOptions 80 "$RUNNER_TEMP/full.png" --out "$RUNNER_TEMP/full.jpg"; echo "jpeg rc=$?"
ls -la "$RUNNER_TEMP/full.jpg"

section "osascript"
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'; echo "frontmost rc=$?"
osascript -l JavaScript -e 'Application("System Events").applicationProcesses.whose({frontmost: true})[0].name()'; echo "jxa rc=$?"

section "swift probe"
swiftc -O -o "$RUNNER_TEMP/probe" scripts/ci/probe.swift; echo "compile rc=$?"
"$RUNNER_TEMP/probe"; echo "probe rc=$?"

section "keyboard into TextEdit"
open -a TextEdit; echo "open rc=$?"
sleep 3
osascript -e 'tell application "TextEdit" to make new document' -e 'tell application "TextEdit" to activate'; echo "newdoc rc=$?"
sleep 2
"$RUNNER_TEMP/probe" type "hello-from-cgevent" | tail -2
sleep 1
osascript -e 'tell application "TextEdit" to get text of document 1'; echo "readback rc=$?"
osascript -e 'tell application "System Events" to keystroke "-and-system-events"'; echo "keystroke rc=$?"
sleep 1
osascript -e 'tell application "TextEdit" to get text of document 1'; echo "readback2 rc=$?"
osascript -e 'tell application "System Events" to tell process "TextEdit" to get name of every menu bar item of menu bar 1'; echo "menubar rc=$?"
osascript -e 'tell application "TextEdit" to quit saving no'
exit 0
