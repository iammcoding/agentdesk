---
description: Open AgentDesk, a live desktop in your browser that shows what Claude is doing
---
Tell the user how to open AgentDesk, in a few short lines:

1. In another terminal window, run `npx @iammcoding/agentdesk` (it needs Node.js 18 or newer). It opens a desktop in their browser that follows this Claude Code session live.
2. It reads Claude Code's own session logs on this computer, so it costs no tokens and sends nothing anywhere.
3. Optional, for an even more live desk (tools appear the moment they start, permission prompts show up): `/plugin marketplace add iammcoding/agentdesk`, then `/plugin install agentdesk@agentdesk`.

Don't run any of these commands yourself; the user runs them.
