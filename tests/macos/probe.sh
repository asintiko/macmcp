#!/bin/bash
# Temporary capability probe for the hosted macOS runners (removed again once it has answered):
#   1. can a virtual (Retina) display be added, and what does macOS report for it?
#   2. what happens to desktop control when the privacy permissions are taken away?
set -u
OUT="${RUNNER_TEMP:-/tmp}/probe"
mkdir -p "$OUT"

section() { echo; echo "=================== $* ==================="; }
helper() { echo "{\"commands\":[$1]}" | "$OUT/helper"; echo " (exit $?)"; }

section "system"
sw_vers; uname -m; csrutil status || true

section "build"
swiftc -swift-version 5 -module-name mcpclaude_helper -o "$OUT/helper" native/helper/*.swift; echo "helper exit=$?"
swiftc -swift-version 5 -module-name click_recorder -o "$OUT/recorder" tests/helpers/native/click-recorder.swift; echo "recorder exit=$?"
clang -fobjc-arc -framework Cocoa -framework CoreGraphics -o "$OUT/vdisplay" tests/helpers/native/virtual-display.m; echo "vdisplay exit=$?"

section "before"
helper '{"command":"displays"},{"command":"permissions"}'

section "virtual display (hidpi)"
"$OUT/vdisplay" 1280 800 1 > "$OUT/vd.out" 2> "$OUT/vd.err" &
VD=$!
sleep 5
echo "stdout:"; cat "$OUT/vd.out"; echo "stderr:"; cat "$OUT/vd.err"
helper '{"command":"displays"}' | tee "$OUT/displays.json"
system_profiler SPDisplaysDataType 2>/dev/null | sed -n 1,60p
for d in 1 2; do
  screencapture -x -D $d -t png "$OUT/display-$d.png"; echo "capture display $d exit=$?"
  sips -g pixelWidth -g pixelHeight "$OUT/display-$d.png" 2>&1 | tail -2
done

section "recorder on the second display"
ORIGIN=$(head -1 "$OUT/displays.json" | python3 -c 'import json,sys; d=json.loads(sys.stdin.readline())["results"][0]["displays"]; s=[x for x in d if not x["main"]]; print(int(s[0]["x"])+200, int(s[0]["y"])+200) if s else print("")')
echo "origin: $ORIGIN"
if [ -n "$ORIGIN" ]; then
  set -- $ORIGIN
  "$OUT/recorder" "$OUT/rec2.jsonl" "$1" "$2" 300 200 &
  REC=$!
  sleep 4
  cat "$OUT/rec2.jsonl"
  CX=$(( $1 + 150 )); CY=$(( $2 + 100 ))
  helper "{\"command\":\"mouse_click\",\"params\":{\"x\":$CX,\"y\":$CY,\"button\":\"right\"}},{\"command\":\"mouse_click\",\"params\":{\"x\":$CX,\"y\":$CY,\"button\":\"middle\"}},{\"command\":\"cursor\"},{\"command\":\"windows\",\"params\":{\"pid\":$REC}}"
  sleep 1
  cat "$OUT/rec2.jsonl"
  screencapture -x -D 2 -t png "$OUT/display-2-recorder.png"
  kill $REC
fi

section "recorder on the main display"
"$OUT/recorder" "$OUT/rec1.jsonl" 400 300 300 200 &
REC=$!
sleep 4
cat "$OUT/rec1.jsonl"
helper "{\"command\":\"mouse_click\",\"params\":{\"x\":550,\"y\":400,\"button\":\"right\"}},{\"command\":\"mouse_click\",\"params\":{\"x\":550,\"y\":400,\"button\":\"middle\"}},{\"command\":\"mouse_click\",\"params\":{\"x\":550,\"y\":400,\"count\":2,\"modifiers\":[\"shift\",\"alt\"]}},{\"command\":\"windows\",\"params\":{\"pid\":$REC}}"
sleep 1
cat "$OUT/rec1.jsonl"
kill $REC

kill $VD
sleep 3
section "after removing the virtual display"
helper '{"command":"displays"}'

section "second virtual display (1x)"
"$OUT/vdisplay" 1600 900 0 > "$OUT/vd1.out" 2> "$OUT/vd1.err" &
VD=$!
sleep 5
cat "$OUT/vd1.out" "$OUT/vd1.err"
helper '{"command":"displays"}'
kill $VD
sleep 2

section "TCC before"
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "select service, client, auth_value from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServicePostEvent','kTCCServiceAppleEvents')" 2>&1 | head -40
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select service, client, auth_value from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServicePostEvent')" 2>&1 | head -40

section "TCC reset (user)"
for service in Accessibility ScreenCapture PostEvent ListenEvent; do tccutil reset $service; echo "tccutil reset $service exit=$?"; done
helper '{"command":"permissions"}'

section "TCC reset (sudo)"
for service in Accessibility ScreenCapture PostEvent ListenEvent; do sudo tccutil reset $service; echo "sudo tccutil reset $service exit=$?"; done
helper '{"command":"permissions"}'
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select service, client, auth_value from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServicePostEvent')" 2>&1 | head -40

section "desktop control without permissions"
helper '{"command":"mouse_move","params":{"x":300,"y":300}}'
helper '{"command":"cursor"}'
helper '{"command":"key","params":{"code":0}}'
helper '{"command":"windows"}' | cut -c1-1500
helper '{"command":"ui_focused"}'
helper '{"command":"menu_list","params":{"name":"Finder"}}' | cut -c1-600
helper '{"command":"apps"}' | cut -c1-600
helper '{"command":"clipboard_get"}'
( screencapture -x -t png "$OUT/noperm.png" & PID=$!; ( sleep 25; kill $PID 2>/dev/null ) & wait $PID; echo "screencapture exit=$?" )
ls -la "$OUT/noperm.png" 2>&1
sips -g pixelWidth -g pixelHeight "$OUT/noperm.png" 2>&1 | tail -2
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>&1; echo "osascript exit=$?"
screencapture -x -t png "$OUT/after.png"; echo "exit=$?"
echo done
