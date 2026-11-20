# Privacy

AgentDesk runs entirely on your computer. It has no account, no analytics, and no server of its own. Nothing it reads or receives leaves your computer.

## The app (`npx @iammcoding/agentdesk`)

- **What it reads:** the session logs your coding agents already write on your computer: `~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp` and `~/.copilot/session-state` (or the folders set by `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` and `COPILOT_HOME`). It never changes them.
- **What it shows them to:** a page in your own browser, served from `127.0.0.1`. The server listens on `127.0.0.1` only and refuses requests whose host or origin is not localhost, so other websites can't read it.
- **What it writes:** one file, `~/.agentdesk/port`, holding the port number, so the Claude Code plugin can find it. It is removed when you stop AgentDesk.
- **What it keeps:** nothing on disk. Recent steps are held in memory while it runs and are gone when you stop it.
- **Network:** none beyond `127.0.0.1`. The page's fonts are bundled, so it makes no outside requests.

## The plugin in Claude's plugin directory

The version listed in Anthropic's plugin directory (`directory/agentdesk` in this repository) is a command and a skill: text that tells Claude how to point you to AgentDesk. It has no hooks, scripts or servers. It reads nothing, sends nothing and stores nothing.

## The full Claude Code plugin (installed from this repository)

This is the version you add with `/plugin marketplace add iammcoding/agentdesk`. Unlike the directory version, it has hooks:

- **What it sends:** for these Claude Code events, the event's own JSON, exactly as Claude Code hands it to hooks: session start and end, each prompt you submit, each tool call before and after it runs (tool name, input and result), permission requests and denials, notifications, compaction, helper agents starting and stopping, and the end of each turn (including Claude's final message). That can include your prompts, file paths, commands and Claude's replies.
- **Where it sends it:** only to `http://127.0.0.1:<port>/hook` on your own computer, the AgentDesk app above, which uses it to update the desk. If AgentDesk isn't running, the plugin sends nothing.
- **What it keeps:** nothing. It writes no files and prints nothing, so Claude never sees it and it uses no tokens.

## Questions

Open an issue: https://github.com/iammcoding/agentdesk/issues
