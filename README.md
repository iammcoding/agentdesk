# AgentDesk

Watch your coding agent work on a little retro desktop.

```
npx agentdesk
```

A desktop opens in your browser and follows the agent you're using right now. When the agent reads a file, the Editor opens it. When it runs a command, it's typed into the Shell. When it searches the web, the Web window loads. When it starts a helper, a second pointer walks over. The menu bar shows how full its memory is and what the session has cost so far.

**It costs no tokens.** AgentDesk reads the session logs your agent already writes on your computer. It never talks to the agent or to any server, and the page makes no outside requests (even the fonts are bundled).

## Agents

| Agent | Reads | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | Full support, including cost |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (or `$CODEX_HOME`) | Tokens, no dollar cost in the log |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.jsonl` | Tokens, no dollar cost in the log |
| Copilot CLI | `~/.copilot/session-state/*/events.jsonl` | Experimental: the format isn't documented |

It follows whichever session changed last. To watch a different one, open **Settings** on the desk and pick it from the list.

## What you see

| On the desk | When the agent… |
|---|---|
| Editor | reads, edits or writes a file (edits show as a red and green diff) |
| Shell | runs a command (failures shake the window and put a red badge on the icon) |
| Files | searches for files or text |
| Web | fetches a page, searches the web, or drives a browser (Playwright and similar MCP tools) |
| Images | looks at a picture or a screenshot (you see the real image) |
| Git | commits or switches branch |
| Network | calls an outside tool through MCP (GitHub, Slack, databases…), including retries |
| Helper | starts a subagent |
| Tasks | updates its to-do list |
| Memory | summarises its memory to make room |
| Question / Permission | asks you something, or waits for your OK |
| Taskbar | open windows and background jobs (like `npm run dev`) |

## Claude Code plugin (optional)

The log can't say when Claude is waiting for your permission, or exactly when it finishes. The plugin adds that, plus following the session you're typing in:

```
/plugin marketplace add <owner>/agentdesk
/plugin install agentdesk@agentdesk
```

Its hooks run in the background, print nothing (so Claude never sees them and they cost no tokens), and do nothing when AgentDesk isn't running.

## Options

```
npx agentdesk --demo          play a sample session
npx agentdesk --list          list recent sessions
npx agentdesk --agent codex   follow only one agent
npx agentdesk --file <path>   follow one session log
npx agentdesk --port 5000     use another port (default 4747)
npx agentdesk --no-open       don't open the browser
```

## Privacy

- The server listens on `127.0.0.1` only and refuses requests from other sites.
- It only reads the agents' log folders listed above, and never writes to them.
- It writes one file, `~/.agentdesk/port`, so the plugin can find it. The file is removed when you stop AgentDesk.

## Requirements

Node.js 18 or newer. No dependencies.

## License

MIT. The bundled fonts (Silkscreen, IBM Plex Mono) are under the SIL Open Font License; see `ui/fonts/`.
