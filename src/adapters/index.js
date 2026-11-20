import * as claude from './claude.js';
import * as codex from './codex.js';
import * as gemini from './gemini.js';
import * as copilot from './copilot.js';

/* Order matters only as a tie-break when a file could belong to two agents. */
export const ADAPTERS = [claude, codex, gemini, copilot];
