#!/bin/sh
# AgentDesk hook: hands this Claude Code event (the JSON on stdin) to the AgentDesk app running on
# this computer, at http://127.0.0.1:<port>/hook. Nothing is sent anywhere else.
#  - If AgentDesk isn't running (no ~/.agentdesk/port file), it does nothing.
#  - It prints nothing, so Claude never sees it and it costs no tokens.
#  - It always exits 0, so it can never block or slow Claude (the hooks also run async).
# (the port file has no final newline, so read reports failure even when it got the number)
PORT=
{ read -r PORT < "$HOME/.agentdesk/port"; } 2>/dev/null
if [ -z "$PORT" ]; then cat >/dev/null 2>&1; exit 0; fi
case "$PORT" in ''|*[!0-9]*) cat >/dev/null 2>&1; exit 0 ;; esac
curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT/hook" >/dev/null 2>&1
exit 0
