#!/bin/sh
# Hands the hook's JSON to AgentDesk when it's running. It prints nothing (so Claude never sees it
# and it costs no tokens) and always exits 0 (so it can never block Claude).
PORT_FILE="$HOME/.agentdesk/port"
if [ ! -f "$PORT_FILE" ]; then cat >/dev/null 2>&1; exit 0; fi
PORT=$(cat "$PORT_FILE" 2>/dev/null)
case "$PORT" in ''|*[!0-9]*) cat >/dev/null 2>&1; exit 0 ;; esac
curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT/hook" >/dev/null 2>&1
exit 0
