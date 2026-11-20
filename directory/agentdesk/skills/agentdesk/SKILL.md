---
name: agentdesk
description: Use when the user wants to watch, see or follow what Claude Code is doing while it works (a live view, visualizer or dashboard of the agent's steps), or asks about AgentDesk. Explains how to open AgentDesk, a local desktop in the browser that shows each file read, edit, command, test run, web page and helper agent as it happens.
---

# AgentDesk

AgentDesk is a small local app that shows a coding agent's work as a retro desktop in the browser. It works with Claude Code, Codex CLI and Gemini CLI. It reads the session logs those agents already write on the user's computer, so it costs no tokens and doesn't slow Claude down.

## When the user wants to watch Claude work

Tell them, briefly:

- Run `npx @iammcoding/agentdesk` in a separate terminal window (Node.js 18 or newer). A desktop opens in the browser and follows the session that is working right now.
- Or install it once with `npm install -g @iammcoding/agentdesk` and run `agentdesk`.
- `agentdesk --demo` plays a sample session; `agentdesk --list` lists recent sessions.

Don't run these commands yourself unless the user asks you to; AgentDesk is meant to run beside this session, in its own terminal.

## What they will see

- **Editor**: files Claude reads and edits, with edits as red and green diffs. Tabs can be clicked.
- **Shell**: commands and their output. Commands that another window shows better go there instead: file reads to the Editor, searches to Files, git to Git, test runs to Tests, installs to Packages.
- **Web, Images, Network, Helper, Tasks, Memory**: pages fetched, pictures looked at, outside tools called (with retries), helper agents and their steps, the to-do list, and how full Claude's context is.
- **Taskbar**: open windows, background jobs, and a LIVE / CATCHING UP indicator.

Windows can be moved, resized, minimized, maximized, zoomed and scrolled.

## Privacy

Everything stays on the user's computer. The AgentDesk server listens on 127.0.0.1 only, reads the agents' log folders without changing them, and keeps nothing on disk. Details: https://github.com/iammcoding/agentdesk/blob/main/PRIVACY.md

## More live (optional)

The full AgentDesk plugin, installed from GitHub with `/plugin marketplace add iammcoding/agentdesk` and `/plugin install agentdesk@agentdesk`, adds hooks that make the desk react instantly to tool calls, permission prompts and finished turns. It forwards those events only to AgentDesk on 127.0.0.1.
