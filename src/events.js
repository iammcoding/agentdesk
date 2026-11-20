/*
 * Every adapter turns its agent's log into these events. The desk only knows these.
 *
 *   {t:'meta',    agent, cwd, project, branch, title}      who is working and where
 *   {t:'prompt',  text}                                     you asked for something
 *   {t:'say',     text}                                     the agent wrote to you
 *   {t:'think',   text}                                     the agent is thinking ('' when the log hides it)
 *   {t:'tool',    id, app, name, ...}                       the agent used a tool (fields by app, below)
 *   {t:'result',  id, ok, ...}                              that tool finished
 *   {t:'todos',   items:[{text, status}]}                   its task list (status: pending | in_progress | completed)
 *   {t:'usage',   used, max}                                how full its memory (context) is, in tokens
 *   {t:'cost',    usd, tokens}                              spend so far this session
 *   {t:'compact'}                                           it summarised old steps to make room
 *   {t:'retry',   text}                                     its connection failed and it is trying again
 *   {t:'job-end', job}                                      a background job was stopped
 *   {t:'permission', tool, detail}  {t:'idle'}              from hooks: waiting for you / finished its turn
 *
 * tool apps and their fields:
 *   ed     read {path}  edit {path, hunks?, old?, new?}  write {path, content}
 *   term   {command, desc, background, git, gh}
 *   files  {pattern, path, grep}
 *   web    {url} or {query} (browser tools: {url, action})
 *   img    {path}
 *   help   {desc, kind, prompt}
 *   ask    {question, header, options:[{label, description}]}
 *   net    {server, tool}
 *   other  {name}
 *
 * result fields: text, lines + start (file reads), files (find), image (data URL), answer, job, exit
 */

const MAX_TEXT = 4000;

export const cut = (s, n = MAX_TEXT) => {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/* Text out of an Anthropic-style content value: a string, or an array of blocks. */
export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const lastSeg = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

/* Shell commands that touch git or GitHub get their own windows too. */
export const isGit = cmd => /(^|&&|;|\||\n)\s*git\s/.test(cmd || '');
export const isGh = cmd => /(^|&&|;|\||\n)\s*gh\s/.test(cmd || '');

/* "Browser" tools from MCP servers (Playwright, Chrome, Puppeteer…) drive the Web window. */
export const isBrowserTool = name => /browser|playwright|puppeteer|chrome|navigate|screenshot/i.test(name || '');

/* Output for a window to draw: all of it when short, otherwise the start and the end. */
export function outLines(s, max = 240) {
  // "\r" redraws a line in place (progress bars, flutter test): what stays on screen is the text after the last one
  const L = String(s || '').split(/\r?\n/).map(l => l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l);
  while (L.length && L[L.length - 1] === '') L.pop();
  if (L.length <= max) return L;
  return [...L.slice(0, max / 2), '…', ...L.slice(-max / 2)];
}

/* Keep only the end of long output: that's what people look at. */
export function tailLines(s, n = 14) {
  const L = String(s || '').replace(/\r/g, '').split('\n');
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.length > n ? ['…', ...L.slice(-n)] : L;
}
