'use strict';
// Review transparency site. All data is rendered as text nodes; markdown goes through md(), which
// escapes everything first and only then adds a fixed set of tags. PR content is untrusted.

const $app = document.getElementById('app');
const $tip = document.getElementById('tip');
const REFRESH_MS = 5 * 60 * 1000;
let INDEX = null, EVALS = null;
const cache = new Map();

// ------------------------------------------------------------ DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;   // CSSOM, allowed by the CSP (attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeUrl(v));
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function safeUrl(u) {
  u = String(u || '');
  if (u.startsWith('#') || /^https:\/\/(github\.com|[\w.-]*githubusercontent\.com)\//.test(u)) return u;
  return /^https?:\/\//.test(u) ? u : '#';
}
const ext = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, ...kids);

// ------------------------------------------------------------ formatting
const fmtUSD = (v, est) => v == null ? '–' : `${est ? '≈' : ''}$${v >= 100 ? Math.round(v).toLocaleString('en') : v.toFixed(2)}`;
const fmtMin = m => m == null ? '–' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
const fmtNum = n => n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString('en');
function fmtTime(iso, withDate = true) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString(undefined, withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
}
function ago(iso) {
  if (!iso) return '';
  const m = (Date.now() - new Date(iso)) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
const median = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

// ------------------------------------------------------------ safe markdown
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function inline(t) {
  // t is already escaped
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow ugc">${txt}</a>`);
  t = t.replace(/(^|[\s(])(https:\/\/github\.com\/[^\s)<]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer nofollow ugc">${url}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return t;
}
function mdToHtml(src) {
  const lines = esc(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
  // Collapsed blocks: only the exact forms <details>, <details open>, <summary>…</summary> and </details> become
  // tags (the text is already escaped, so nothing else can); a summary may contain <code>.
  const DET = /^\s*&lt;details( open)?&gt;\s*(?:&lt;summary&gt;(.*?)&lt;\/summary&gt;)?\s*$/;
  const SUM = /^\s*&lt;summary&gt;(.*?)&lt;\/summary&gt;\s*$/;
  const END = /^\s*&lt;\/details&gt;\s*$/;
  const summary = t => `<summary>${inline(t).replace(/&lt;code&gt;(.*?)&lt;\/code&gt;/g, '<code>$1</code>')}</summary>`;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(DET))) { out.push(`<details${m[1] ? ' open' : ''}>` + (m[2] != null ? summary(m[2]) : '')); i++; continue; }
    if ((m = l.match(SUM))) { out.push(summary(m[1])); i++; continue; }
    if (END.test(l)) { out.push('</details>'); i++; continue; }
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${buf.join('\n')}</code></pre>`); continue;
    }
    if (/^#{1,6}\s/.test(l)) { const n = Math.min(4, l.match(/^#+/)[0].length + 1); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`); i++; continue; }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^&gt;\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${tag}>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*\||&gt;|\s*([-*]|\d+\.)\s+|\s*&lt;\/?(details|summary))/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
function md(src) { const d = h('div', { class: 'md' }); d.innerHTML = mdToHtml(src); return d; }

// ------------------------------------------------------------ data
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
async function loadIndex(force) {
  if (!INDEX || force) INDEX = await getJSON('data/index.json');
  return INDEX;
}
async function loadReview(id) {
  if (!cache.has(id)) cache.set(id, await getJSON(`data/reviews/${encodeURIComponent(id)}.json`));
  return cache.get(id);
}

// ------------------------------------------------------------ small components
function fmtTok(n) {
  if (n == null) return '–';
  for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) if (n >= d) return `${(n / d).toFixed(n >= 100 * d ? 0 : n >= 10 * d ? 1 : 2)}${u}`;
  return String(n);
}
const TOKEN_KIND = { input: 'fresh input', cache_read: 'cache reads', cache_write: 'cache writes', output: 'output', unsplit: 'not split' };
const AFTER = {
  merged: ['merged', 'b-good', 'var(--good)'], closed: ['closed', 'b-warn', 'var(--accent-2)'],
  updated: ['updated', 'b-info', 'var(--series-1)'], unchanged: ['no change yet', '', 'var(--neutral-mark)'],
};
function afterBadge(state, commits) {
  if (!state) return null;
  const [t, c] = AFTER[state];
  return h('span', { class: `badge ${c}` }, state === 'updated' && commits ? `${t} · ${commits} commit${commits === 1 ? '' : 's'}` : t);
}
function tile(value, label, sub, cls = '') { return h('div', { class: `card tile ${cls}` }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label), sub && h('div', { class: 's' }, sub)); }
function barList(rows, { fmt = fmtNum, unit = '' } = {}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return h('div', { class: 'bars' }, rows.map(r =>
    h('div', { class: 'row', title: `${r.label}: ${fmt(r.value)}${unit}` },
      h('div', { class: 'lab' }, r.label),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(100 * r.value / max).toFixed(1)}%` })),
      h('div', { class: 'val' }, fmt(r.value) + unit))));
}
const STATUS_BADGE = {
  published_verified: ['posted', 'b-good'], published: ['posted', 'b-good'], running: ['in progress', 'b-info'], queued: ['queued', ''],
  held: ['held', 'b-warn'], skipped: ['skipped', ''], carried_over: ['moved to next batch', ''], not_started: ['not started', ''], no_response: ['no response needed', ''], deferred: ['deferred', ''], topup_pending_user: ['awaiting approval', ''],
};
function statusBadge(st) { const [t, c] = STATUS_BADGE[st] || [st, '']; return h('span', { class: `badge ${c}` }, t); }
const VERDICT_CLASS = { WRONG: 'b-bad', OVERSTATED: 'b-warn', UNCHECKED: 'b-info', CORRECT: 'b-good' };
const LEAD_CLASS = { published: 'b-good', corroborated: 'b-info', 'verified, not published': 'b-warn', dropped: '', hypothesis: 'b-warn', other: '', unrecorded: '' };
const LEAD_TEXT = { published: 'added to comment', corroborated: 'matched Opus', 'verified, not published': 'true, left out', dropped: 'dropped', hypothesis: 'hypothesis', other: 'see note', unrecorded: 'no decision' };
const ROLE_SHORT = { 'Opus technical reviewer': 'Opus reviewer', 'Sol boundary hunter': 'Sol hunter', 'Sol second reviewer': 'Sol reviewer (v3)', 'Technical reviewer': 'Reviewer (early)' };
const ERA_TEXT = { hunter: 'Opus + Sol hunter + self-check', dual: 'Opus + Sol reviewers', early: 'Early pipeline' };
function kindBadge(k) { return h('span', { class: 'badge' }, k === 'followup' ? 'follow-up' : 'initial review'); }

function setNav(route) {
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.r === route);
}
function tipShow(ev, nodes) { $tip.replaceChildren(...nodes); $tip.style.display = 'block'; tipMove(ev); }
function tipMove(ev) {
  const r = $tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  $tip.style.left = `${x}px`; $tip.style.top = `${y}px`;
}
function tipHide() { $tip.style.display = 'none'; }

// ------------------------------------------------------------ pages
function pipeline() {
  const st = (who, title, text) => h('div', { class: 'st' }, h('span', { class: 'who' }, who), h('b', null, title), h('p', null, text));
  const arrow = () => h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→');
  return h('div', { class: 'pipe', role: 'list', 'aria-label': 'Review pipeline' },
    st('Coordinator · Opus 5.5 medium', 'Triage and brief', 'Security triage, pins the PR head, writes a neutral brief.'), arrow(),
    h('div', { class: 'par' },
      st('Opus 5.5 xhigh', 'Full technical review', 'Reads the code, runs isolated experiments, writes the evidence.'),
      st('GPT 6 Sol xhigh', 'Boundary hunt', 'Looks for related problems: fixtures, input edges, other open PRs.')), arrow(),
    st('Coordinator', 'Triage and draft', 'Each hunter lead is checked, sent back to Opus, or dropped. Then the draft.'), arrow(),
    st('Opus 5.5 xhigh', 'Self-check', 'Checks every claim in the draft against its own evidence.'), arrow(),
    st('Opus 5.5 medium, no tools', 'Editorial check', 'Structure and wording rules only, on the exact draft bytes.'), arrow(),
    st('Batch driver', 'Gates, then post', 'Models verified, privacy filter, head unchanged, no new discussion. Read back after posting.'));
}

async function pageHow() {
  const idx = await loadIndex();
  const a = idx.aggregate;
  const leadsTotal = Object.values(a.leads || {}).reduce((x, y) => x + y, 0);
  const flags = a.flags || {};
  const step = (n, title, who, body, shows) => h('div', { class: 'card step' },
    h('div', { class: 'hd' }, h('span', { class: 'n' }, n), h('div', null, h('h3', null, title), h('div', { class: 'who' }, who))),
    h('p', null, body), shows && h('p', { class: 'small muted' }, h('b', null, 'On this site: '), shows));
  return [
    h('h1', null, 'How our AI pull-request reviews are made'),
    h('p', { class: 'lede' }, 'An independent community service posts automated reviews on open Omarchy pull requests. This site shows everything that happens before a comment appears: which model did which part, what was found, what was filtered out and why, and what it cost.'),
    pipeline(),
    h('h2', null, 'Step by step'),
    h('div', { class: 'grid steps' },
      step('1', 'Triage and brief', 'Coordinator · Opus 5.5 medium',
        'Checks the pull request for anything unsafe to run, pins the exact commit under review, and writes a neutral brief for the reviewers. Pull requests by contributors who opted out are skipped.',
        'reviews stopped here for security reasons are counted, never listed.'),
      step('2', 'Full technical review', 'Opus 5.5 xhigh',
        'Reads the change and the code around it, and runs experiments in an isolated sandbox: the PR’s own tests, variants of them, and scripted scenarios. Everything it claims is backed by a recorded result.',
        'model, effort, turns, time and cost for every review.'),
      step('3', 'Boundary hunt', 'GPT 6 Sol xhigh, in parallel',
        'A second model from a different provider looks for what a single review tends to miss: weak test fixtures, unusual inputs, and clashes with other open pull requests.',
        `every lead it reported (${fmtNum(leadsTotal)} so far), side by side with what the coordinator decided.`),
      step('4', 'Triage of the hunter’s leads', 'Coordinator',
        'Each lead is handled on its merits. A duplicate of an Opus finding counts as corroboration. A factual claim is verified directly. A behavioural claim goes back to Opus as a neutral question. Anything unconfirmed is dropped or labelled as a hypothesis.',
        `${fmtNum(a.leads.published || 0)} leads added something new to a comment, ${fmtNum(a.leads.corroborated || 0)} matched Opus, ${fmtNum(a.leads.dropped || 0)} were dropped.`),
      step('5', 'Draft and self-check', 'Coordinator, then Opus 5.5 xhigh',
        'The coordinator writes the comment. Opus then re-reads it against its own evidence and flags every claim that is wrong, overstated or unchecked, and the coordinator records a fix or a reason for each flag.',
        `${fmtNum(flags.WRONG || 0)} wrong and ${fmtNum(flags.OVERSTATED || 0)} overstated claims flagged before posting.`),
      step('6', 'Editorial check', 'Opus 5.5 medium, no tools',
        'A fresh model with no tools checks structure and wording rules on the exact bytes of the draft. It does not judge technical accuracy. Any change means a new check.',
        `${fmtNum(a.editorial_revisions)} revisions requested so far, with the rule and the requested change.`),
      step('7', 'Gates, then post', 'Batch driver (a script, not a model)',
        'Before posting, a script verifies the models from their session logs, re-checks the editorial pass on the exact bytes, the comment layout and a privacy filter, and confirms the commit has not moved and nobody has commented since. After posting it reads the comment back.',
        'the gates each review passed, and any holds with their reason.')),
    h('h2', null, 'Why a second model'),
    h('p', null, `The hunter is a cheaper second pair of eyes: about $1 per pull request, against about $7 for a second Opus xhigh pass. In a blind check on pull requests its prompt had never seen, it found 22 of the 24 issues Opus found, with no wrong claims. In the posted reviews, ${fmtNum(a.leads.published || 0)} of its leads added something the Opus review did not have. `, h('a', { href: '#/evals' }, 'See the evaluations →')),
  ];
}

async function pageOverview() {
  const idx = await loadIndex();
  const a = idx.aggregate;
  const live = idx.batches.find(b => b.live) || idx.batches[0];
  const posted = idx.reviews.filter(r => (r.status || '').startsWith('published'));
  const hunter = posted.filter(r => r.leads);
  const leadsTotal = Object.values(a.leads || {}).reduce((x, y) => x + y, 0);
  const flags = a.flags || {};
  const flagsTotal = Object.values(flags).reduce((x, y) => x + y, 0);
  const medCost = median(hunter.map(r => r.cost_usd));
  const times = hunter.map(r => r.minutes).filter(m => m != null);
  const avgTime = times.length ? times.reduce((x, y) => x + y, 0) / times.length : null;

  const out = [
    h('h1', null, 'At a glance'),
    h('p', { class: 'muted' }, 'Automated community reviews of open Omarchy pull requests. ', h('a', { href: '#/how' }, 'How they are made →')),
    h('div', { class: 'tiles' },
      tile(fmtNum(posted.length), 'reviews posted', `across ${idx.batches.length} batches`),
      a.duplicate_notes ? tile(fmtNum(a.duplicate_notes), 'duplicate PRs detected', 'flagged with a note instead of a full review') : null,
      tile(fmtUSD(medCost, true), 'typical cost per review', 'median, current workflow; see method'),
      a.tokens ? tile(fmtTok(median(hunter.map(r => r.tokens).filter(Boolean))), 'typical tokens per review', 'median, current workflow, Pi included') : null,
      a.tokens ? tile(fmtTok(a.tokens), 'tokens used', `${fmtTok((a.by_runtime_tokens || {}).Pi)} by GPT 6 Sol in Pi; ${pct((a.token_split || {}).cache_read || 0, a.tokens)} cache reads`) : null,
      tile(fmtMin(avgTime), 'average review time', `from assignment to posted comment; median ${fmtMin(median(times))}`)),
  ];

  const im = a.impact;
  if (im && im.prs) {
    const order = ['merged', 'closed', 'updated', 'unchanged'];
    out.push(h('h2', null, 'After review'),
      h('div', { class: 'tiles' },
        tile(fmtNum(im.merged || 0), 'PRs merged', `of ${fmtNum(im.prs)} PRs reviewed`),
        tile(fmtNum(im.closed || 0), 'PRs closed', [(im.closed_review || 0) + (im.closed_duplicate || 0) && `${(im.closed_review || 0) + (im.closed_duplicate || 0)} citing our review or a duplicate`,
          im.closed_silent && `${im.closed_silent} without comment`].filter(Boolean).join(', ') || null),
        tile(fmtNum((im.merged || 0) + (im.closed || 0) + (im.updated || 0)), 'PRs changed', `merged, closed, or new commits pushed; ${pct((im.merged || 0) + (im.closed || 0) + (im.updated || 0), im.prs)} of reviewed PRs`),
        tile(fmtNum(im.commits_24h || 0), 'commits in the last 24 hours', 'pushed to reviewed PRs')),
      h('div', { class: 'card', style: 'margin-top:var(--gap)', 'data-title': `what followed · ${im.prs} PRs` },
        h('div', { class: 'prog', role: 'img', 'aria-label': order.map(k => `${im[k] || 0} ${AFTER[k][0]}`).join(', ') },
          order.map(k => im[k] ? h('div', { style: `width:${100 * im[k] / im.prs}%;background:${AFTER[k][2]}`, title: `${AFTER[k][0]}: ${im[k]}` }) : null)),
        h('div', { class: 'legend' }, order.map(k => h('span', null, h('i', { style: `background:${AFTER[k][2]}` }), `${im[k] || 0} ${AFTER[k][0]}`)))));
  }

  if (live) {
    const c = live.counts; const total = live.target || Object.values(c).reduce((x, y) => x + y, 0);
    const done = (c.published_verified || 0) + (c.published || 0);
    const seg = (n, color, label) => n ? h('div', { style: `width:${100 * n / total}%;background:${color}`, title: `${label}: ${n}` }) : null;
    const other = total - done - (c.running || 0) - (c.queued || 0);
    out.push(h('h2', null, 'Live batch'),
      h('div', { class: 'card', 'data-title': `live · ${live.id}` },
        live.created && h('div', { class: 'faint small num' }, `started ${fmtTime(live.created)}`),
        h('div', { class: 'prog', role: 'img', 'aria-label': `${done} posted, ${c.running || 0} in progress, ${c.queued || 0} queued of ${total}` },
          seg(done, 'var(--series-1)', 'posted'), seg(c.running || 0, 'var(--series-2)', 'in progress'), seg(Math.max(0, other), 'var(--text-3)', 'held, skipped or not needed'), seg(c.queued || 0, 'var(--neutral-mark)', 'queued')),
        h('div', { class: 'legend' },
          h('span', null, h('i', { style: 'background:var(--series-1)' }), `${done} posted`),
          h('span', null, h('i', { style: 'background:var(--series-2)' }), `${c.running || 0} in progress`),
          other > 0 && h('span', null, h('i', { style: 'background:var(--text-3)' }), `${other} held, skipped or not needed`),
          h('span', null, h('i', { style: 'background:var(--neutral-mark)' }), `${c.queued || 0} queued`),
          h('span', { class: 'faint' }, `target ${total}`)),
        live.running.length ? h('div', { class: 'tbl-wrap', style: 'margin-top:14px' }, h('table', { class: 'rt' },
          h('thead', null, h('tr', null, h('th', null, 'PR'), h('th', null, 'Type'), h('th', null, 'Started'), h('th', null, 'Current step (from the coordinator)'))),
          h('tbody', null, live.running.map(r => h('tr', null,
            h('td', null, ext(`https://github.com/omacom/omarchy/pull/${r.pr}`, `#${r.pr}`)),
            h('td', { 'data-label': 'type' }, r.kind === 'followup' ? 'follow-up' : 'initial'),
            h('td', { class: 'num', 'data-label': 'started' }, ago(r.dispatched)),
            h('td', { class: 'muted', 'data-label': 'step' }, r.phase || '–')))))) : h('p', { class: 'muted' }, 'Nothing is being reviewed right now.'),
        live.other.length ? h('details', null, h('summary', null, `${live.other.length} not posted (held, skipped or no response needed)`),
          h('ul', { class: 'plain small' }, live.other.map(o => h('li', null, `#${o.pr} `, statusBadge(o.status), ' ', h('span', { class: 'muted' }, o.reason || ''))))) : null));
  }

  const leadOrder = ['published', 'corroborated', 'verified, not published', 'dropped', 'hypothesis', 'other', 'unrecorded'];
  const byRole = Object.entries(a.by_role_cost || {}).sort((x, y) => y[1] - x[1]);
  out.push(h('h2', null, 'What the filters did'),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card', 'data-title': 'where the hunter’s leads went' },
        h('p', { class: 'small muted' }, `${fmtNum(leadsTotal)} leads from GPT 6 Sol in ${fmtNum(a.hunter_reviews)} reviews. The coordinator decides each one.`),
        barList(leadOrder.filter(k => a.leads[k]).map(k => ({ label: LEAD_TEXT[k], value: a.leads[k] })))),
      h('div', { class: 'card', 'data-title': 'self-check flags on drafts' },
        h('p', { class: 'small muted' }, `${fmtNum(flagsTotal)} flags raised by Opus against its own draft before posting.`),
        barList(Object.entries(flags).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: k.toLowerCase().replace(/_/g, ' ').replace('correct ', 'correct, '), value: v })))),
      h('div', { class: 'card', 'data-title': 'estimated cost by role' },
        h('p', { class: 'small muted' }, `${fmtUSD(a.cost_usd, true)} in total. Claude figures are API-equivalent estimates.`),
        barList(byRole.map(([k, v]) => ({ label: ROLE_SHORT[k] || k, value: v })), { fmt: v => fmtUSD(v) }))));

  if (a.tokens) {
    const split = a.token_split || {};
    out.push(h('h2', null, 'Tokens used'),
      h('p', { class: 'small muted' }, `${a.tokens.toLocaleString('en')} tokens across all reviews, Claude and Pi together. Most are cache reads: every model turn re-reads the conversation so far, which is cheap. `,
        a.agents_without_tokens ? `${fmtNum(a.agents_without_tokens)} agent runs from early reviews left no session log and are not counted.` : ''),
      h('div', { class: 'grid g3' },
        h('div', { class: 'card', 'data-title': 'by runtime' },
          barList(Object.entries(a.by_runtime_tokens || {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: k === 'Pi' ? 'Pi (GPT 6 Sol)' : 'Claude Code (Opus)', value: v })), { fmt: fmtTok })),
        h('div', { class: 'card', 'data-title': 'by kind' },
          barList(['cache_read', 'cache_write', 'input', 'output', 'unsplit'].filter(k => split[k]).map(k => ({ label: TOKEN_KIND[k], value: split[k] })), { fmt: fmtTok })),
        h('div', { class: 'card', 'data-title': 'by role' },
          barList(Object.entries(a.by_role_tokens || {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: ROLE_SHORT[k] || k, value: v })), { fmt: fmtTok }))));
  }

  out.push(h('h2', null, 'Recent reviews'), reviewTable(posted.slice(0, 12)),
    h('p', null, h('a', { href: '#/reviews' }, `All ${posted.length} reviews →`)));

  out.push(h('h2', null, 'Batches'), h('div', { class: 'tbl-wrap card', 'data-title': 'batches/*/queue.json' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Batch'), h('th', null, 'Workflow'), h('th', null, 'Started'), h('th', null, 'Posted'), h('th', null, 'After review'), h('th', null, 'Other'))),
    h('tbody', null, idx.batches.map(b => {
      const done = (b.counts.published_verified || 0) + (b.counts.published || 0);
      const rest = Object.entries(b.counts).filter(([k]) => !k.startsWith('published')).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ');
      return h('tr', { class: 'link', onclick: () => { location.hash = `#/reviews?batch=${encodeURIComponent(b.id)}`; } },
        h('td', null, h('a', { href: `#/reviews?batch=${encodeURIComponent(b.id)}` }, b.id), b.live && ' ', b.live && h('span', { class: 'badge b-info' }, 'live'), b.closed && ' ', b.closed && h('span', { class: 'badge', title: `closed ${fmtTime(b.closed)}` }, 'closed')),
        h('td', { class: 'muted' }, ERA_TEXT[b.era] || b.era), h('td', { class: 'num' }, fmtTime(b.created)),
        h('td', { class: 'num' }, done),
        h('td', { class: 'small' }, ['merged', 'closed', 'updated'].filter(k => (b.after || {})[k]).map(k => `${b.after[k]} ${k}`).join(', ') || '–'),
        h('td', { class: 'muted small' }, rest || '–'));
    })))));
  return out;
}

function reviewTable(rows) {
  if (!rows.length) return h('p', { class: 'empty' }, 'No reviews match.');
  return h('div', { class: 'tbl-wrap card', 'data-title': 'reviews' }, h('table', { class: 'rt' },
    h('thead', null, h('tr', null, h('th', null, 'PR'), h('th', null, 'Title'), h('th', null, 'Posted'), h('th', null, 'Hunter leads'), h('th', null, 'Self-check flags'), h('th', null, 'Est. cost'))),
    h('tbody', null, rows.map(r => {
      const leads = r.leads ? Object.values(r.leads).reduce((x, y) => x + y, 0) : null;
      const flags = r.flags ? Object.values(r.flags).reduce((x, y) => x + y, 0) : null;
      return h('tr', { class: 'link', onclick: () => { location.hash = `#/r/${encodeURIComponent(r.id)}`; } },
        h('td', { class: 'num' }, h('a', { href: `#/r/${encodeURIComponent(r.id)}` }, `#${r.pr}`), r.kind === 'followup' ? h('div', { class: 'faint small' }, 'follow-up') : null),
        h('td', null, r.title || h('span', { class: 'faint' }, '(untitled)'), h('div', { class: 'faint small' }, r.batch)),
        h('td', { class: 'num small', 'data-label': 'posted' }, fmtTime(r.posted), r.after ? h('div', null, afterBadge(r.after, r.commits_after)) : null),
        h('td', { class: 'num', 'data-label': 'hunter leads' }, leads == null ? '–' : [String(leads), h('div', { class: 'faint small' }, `${r.leads.published || 0} new · ${r.leads.corroborated || 0} matched`)]),
        h('td', { class: 'num', 'data-label': 'self-check' }, flags == null ? '–' : [flags, r.flags.WRONG ? h('span', { class: 'badge b-bad', style: 'margin-left:6px' }, `${r.flags.WRONG} wrong`) : null]),
        h('td', { class: 'num', 'data-label': 'est. cost' }, fmtUSD(r.cost_usd, true)));
    }))));
}

function duplicateNotes(notes) {
  if (!notes || !notes.length) return [];
  const detail = n => n.kind === 'C' ? `the same commit is in ${n.affected} PRs`
    : n.kind === 'D' ? `same issue${n.issue ? ` (#${n.issue})` : ''} as #${n.other}`
    : n.shared_lines != null ? `${n.shared_lines} of ${n.added_lines} added lines match #${n.other}` : n.other ? `see #${n.other}` : '';
  return [h('h2', null, 'Duplicate checks'),
    h('p', { class: 'muted small' }, 'PRs that duplicate another open PR get a short note instead of a full review.'),
    h('div', { class: 'tbl-wrap card', 'data-title': `duplicate notes · ${notes.length}` }, h('table', { class: 'rt' },
      h('thead', null, h('tr', null, h('th', null, 'PR'), h('th', null, 'Why'), h('th', null, 'Posted'), h('th', null, 'Note'))),
      h('tbody', null, notes.map(n => h('tr', null,
        h('td', { class: 'num' }, ext(`https://github.com/omacom/omarchy/pull/${n.pr}`, `#${n.pr}`)),
        h('td', null, n.why, h('div', { class: 'faint small' }, detail(n))),
        h('td', { class: 'num small', 'data-label': 'posted' }, fmtTime(n.posted)),
        h('td', { 'data-label': 'note' }, ext(n.url, 'comment ↗')))))))];
}

async function pageReviews(params) {
  const idx = await loadIndex();
  const posted = idx.reviews.filter(r => (r.status || '').startsWith('published'));
  const state = { q: params.get('q') || '', batch: params.get('batch') || '', era: params.get('era') || '', kind: params.get('kind') || '', after: params.get('after') || '' };
  const holder = h('div');
  const apply = () => {
    const q = state.q.trim().toLowerCase().replace(/^#/, '');
    const rows = posted.filter(r => (!state.batch || r.batch === state.batch) && (!state.era || r.era === state.era) && (!state.kind || r.kind === state.kind) &&
      (!state.after || (r.after || 'unchanged') === state.after) &&
      (!q || String(r.pr).includes(q) || (r.title || '').toLowerCase().includes(q)));
    holder.replaceChildren(...[h('p', { class: 'muted small' }, `${rows.length} reviews`), reviewTable(rows.slice(0, 300)),
      rows.length > 300 ? h('p', { class: 'faint small' }, 'Showing the first 300. Narrow the filters to see more.') : null].filter(Boolean));
    const p = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    history.replaceState(null, '', `#/reviews${p.toString() ? '?' + p : ''}`);
  };
  const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: e => { state[key] = e.target.value; apply(); } },
    h('option', { value: '' }, label), opts.map(([v, t]) => { const o = h('option', { value: v }, t); if (state[key] === v) o.selected = true; return o; }));
  const search = h('input', { type: 'search', placeholder: 'Search PR number or title', value: state.q, 'aria-label': 'Search', oninput: e => { state.q = e.target.value; apply(); } });
  apply();
  return [h('h1', null, 'Reviews'),
    h('p', { class: 'lede' }, 'Every posted review, newest first. Open one to see how it was made.'),
    h('div', { class: 'controls' }, search,
      sel('batch', 'All batches', idx.batches.map(b => [b.id, b.id])),
      sel('era', 'All workflows', Object.entries(ERA_TEXT)),
      sel('kind', 'Initial and follow-up', [['initial', 'Initial reviews'], ['followup', 'Follow-ups']]),
      sel('after', 'Any outcome', Object.entries(AFTER).map(([k, v]) => [k, k === 'unchanged' ? 'No change yet' : `${v[0][0].toUpperCase()}${v[0].slice(1)} after review`]))),
    holder, ...duplicateNotes(idx.duplicate_notes)];
}

const ROLE_TEXT = {
  coordinator: 'Runs the assignment: security triage, brief, hunter triage, writes the comment, records every decision.',
  opus: 'The full technical review with experiments in a sandbox; later fact-checks the draft against its own evidence.',
  sol: 'Hunts for related issues the main review might miss. Its leads are checked before anything is used.',
  sol_reviewer: 'A second, independent technical review, compared with Opus by the coordinator.',
  reviewer: 'Technical review.',
  editorial: 'Checks structure and wording rules on the exact final bytes. Has no tools and does not judge technical accuracy.',
};

function sinceLine(s) {
  if (!s) return null;
  const parts = [];
  if (s.commits) parts.push(`${s.commits} commit${s.commits === 1 ? '' : 's'} pushed`);
  else if (s.head_changed) parts.push('new commits pushed');
  if (s.merged) parts.push(`merged ${fmtTime(s.merged)}`);
  const why = { review: ', citing the review', duplicate: ' as a duplicate', silent: ' without comment', other: ' for another reason' }[s.close_reason] || '';
  if (s.closed) parts.push(`closed by the ${s.closed_by}${why} ${fmtTime(s.closed)}`);
  return h('p', { class: 'since' }, h('span', { class: 'muted' }, 'Since this review: '), afterBadge(s.state, 0), ' ', parts.join(', ') || 'no change yet');
}

async function pageReview(id) {
  const r = await loadReview(id);
  const out = [];
  out.push(h('p', { class: 'small' }, h('a', { href: '#/reviews' }, '← All reviews')),
    h('h1', null, `#${r.pr} `, h('span', { style: 'font-weight:450' }, r.title || '')),
    h('div', { class: 'badges' }, kindBadge(r.kind), statusBadge(r.status), h('span', { class: 'badge' }, r.batch), h('span', { class: 'badge b-info' }, ERA_TEXT[r.era] || r.era)),
    h('div', { class: 'kv' },
      h('span', null, 'PR ', ext(r.pr_url, `omacom/omarchy#${r.pr}`)),
      r.comment_url && h('span', null, ext(r.comment_url, 'Posted comment ↗')),
      r.head && h('span', null, 'Reviewed at ', h('code', null, r.head.slice(0, 8))),
      h('span', null, 'Dispatch to post ', h('b', null, fmtMin(r.minutes))),
      h('span', null, 'Estimated cost ', h('b', null, fmtUSD(r.cost_usd, true))),
      r.tokens && h('span', null, 'Tokens ', h('b', null, fmtTok(r.tokens)))),
    sinceLine(r.since));

  // who did what
  out.push(h('h2', null, 'Who did what'), h('div', { class: 'grid g2' }, r.agents.map(a => h('div', { class: 'card agent', 'data-title': a.label.toLowerCase() },
    h('div', { class: 'model' }, [a.model, a.effort].filter(Boolean).join(' · ') || 'model not recorded'),
    h('p', null, ROLE_TEXT[a.role] || ''),
    h('dl', null,
      a.runs > 1 && [h('dt', null, 'Runs'), h('dd', null, a.runs)],
      a.turns && [h('dt', null, 'Model turns'), h('dd', null, fmtNum(a.turns))],
      a.minutes != null && [h('dt', null, 'Active time'), h('dd', null, fmtMin(a.minutes))],
      a.tokens && [h('dt', null, 'Tokens'), h('dd', null, fmtNum(a.tokens), a.token_split ? h('span', { class: 'faint small' },
        ` (${['output', 'input', 'cache_write', 'cache_read'].filter(k => a.token_split[k]).map(k => `${fmtTok(a.token_split[k])} ${TOKEN_KIND[k]}`).join(', ')})`) : null)],
      [h('dt', null, 'Cost'), h('dd', null, fmtUSD(a.cost_usd, a.cost_basis === 'api-equivalent'), a.cost_basis ? h('span', { class: 'faint small' }, ` (${a.cost_basis})`) : null)])))));

  // timeline
  const ev = [];
  if (r.dispatched) ev.push({ t: r.dispatched, h: 'Assigned to a review team', d: `Team ${r.team ?? '–'}` });
  for (const a of r.agents) if (a.start && a.role !== 'editorial' && a.role !== 'coordinator') ev.push({ t: a.start, h: `${a.label} started`, d: a.end ? `finished ${fmtTime(a.end, false)} (${fmtMin(a.minutes)})` : '' });
  if (r.self_check) ev.push({ t: null, h: 'Self-check of the draft', d: `${r.self_check.flags.length} flags: ${Object.entries(r.self_check.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none'}` });
  for (const e of r.editorial) ev.push({ t: e.at, h: `Editorial check: ${e.verdict || '?'}`, d: e.issues.length ? `${e.issues.length} issue(s) to fix` : '', cls: e.verdict === 'pass' ? 'good' : 'warn' });
  const holds = r.holds.map(hd => ({ t: null, h: 'Held by the batch gates', d: [hd.note, hd.resolution].filter(Boolean).join(' → '), cls: 'warn', hold: true }));
  if (r.posted) ev.push({ t: r.posted, h: 'Posted to GitHub', d: r.body_verified ? 'Body read back and matched the approved draft.' : '', cls: 'good' });
  const timed = ev.filter(e => e.t).sort((x, y) => x.t.localeCompare(y.t));
  const untimed = ev.filter(e => !e.t);
  const ordered = []; // self-check goes before the first editorial check; a hold forces the last editorial re-check
  const eds = timed.filter(e => e.h.startsWith('Editorial'));
  const lastEd = eds.length > 1 ? eds[eds.length - 1] : null;
  for (const e of timed) {
    if (untimed.length && (e.h.startsWith('Editorial') || e.h.startsWith('Posted'))) ordered.push(...untimed.splice(0));
    if (holds.length && (e === lastEd || (!lastEd && e.h.startsWith('Posted')))) ordered.push(...holds.splice(0));
    ordered.push(e);
  }
  ordered.push(...untimed, ...holds);
  out.push(h('h2', null, 'Timeline'), h('div', { class: 'card', 'data-title': 'log' }, h('ol', { class: 'tl' }, ordered.map(e => h('li', null,
    h('span', { class: `dot ${e.cls || ''}` }), e.t && h('div', { class: 't' }, fmtTime(e.t)), h('div', { class: 'h' }, e.h), e.d && h('div', { class: 'd' }, e.d))))));

  // hunter
  if (r.hunter) {
    const L = r.hunter.leads;
    out.push(h('h2', null, `Boundary hunt: ${L.length} lead${L.length === 1 ? '' : 's'}`),
      h('p', { class: 'muted' }, 'What GPT 6 Sol reported on the left, the coordinator’s decision on the right. Leads are verified directly, sent to Opus as neutral follow-up questions, or dropped.'),
      h('div', { class: 'card', 'data-title': 'sol/hunt.json  +  coordinator triage' }, L.length ? L.map(l => h('div', { class: 'item' },
        h('div', { class: 'hd' }, h('span', { class: 'id' }, l.id), h('span', { class: `badge ${LEAD_CLASS[l.outcome] || ''}` }, LEAD_TEXT[l.outcome] || l.outcome),
          l.route && l.route !== 'other' && h('span', { class: 'badge' }, `route: ${l.route}`)),
        h('div', { class: 'split' },
          h('div', null, h('div', { class: 'k' }, 'Sol reported'), h('div', { class: 'claim' }, l.summary),
            (l.consequence || l.location) && h('details', null, h('summary', null, 'Details'),
              l.location && h('div', { class: 'x' }, h('code', null, l.location)), l.consequence && h('p', { class: 'x' }, l.consequence))),
          h('div', null, h('div', { class: 'k' }, 'Coordinator decided'), h('div', { class: 'x' }, l.triage || 'No decision text recorded.'))))) : h('p', { class: 'empty' }, 'No leads.'),
        r.hunter.limits.length ? h('details', null, h('summary', null, 'Hunter’s stated limits'), h('ul', { class: 'plain small muted' }, r.hunter.limits.map(x => h('li', null, x)))) : null));
  }

  // self-check
  if (r.self_check && r.self_check.flags.length) {
    out.push(h('h2', null, 'Self-check of the draft'),
      h('p', { class: 'muted' }, 'Opus re-read the draft comment against its own evidence and flagged claims that were wrong, overstated or unchecked. The coordinator recorded what was done about each.'),
      h('div', { class: 'card', 'data-title': 'opus/draft-check.json  +  dispositions' }, r.self_check.flags.map(f => h('div', { class: 'item' },
        h('div', { class: 'hd' }, h('span', { class: 'id' }, f.id), f.verdict && h('span', { class: `badge ${VERDICT_CLASS[f.verdict] || ''}` }, f.verdict.toLowerCase()),
          h('span', { class: `badge ${f.outcome === 'fixed' ? 'b-good' : ''}` }, f.outcome)),
        h('div', { class: 'split' },
          h('div', null, h('div', { class: 'k' }, 'Claim in the draft'), h('div', { class: 'claim' }, f.claim || '–'), f.why && h('p', { class: 'x' }, f.why)),
          h('div', null, h('div', { class: 'k' }, 'What happened'), h('div', { class: 'x' }, f.disposition || f.fix || '–')))))));
  }

  // editorial
  if (r.editorial.length) {
    out.push(h('h2', null, 'Editorial checks'), h('div', { class: 'card', 'data-title': 'editorial checks' }, r.editorial.map((e, i) => h('div', { class: 'item' },
      h('div', { class: 'hd' }, h('span', { class: 'id' }, `check ${i + 1}`), h('span', { class: `badge ${e.verdict === 'pass' ? 'b-good' : 'b-warn'}` }, e.verdict || '?'), e.at && h('span', { class: 't faint small' }, fmtTime(e.at))),
      e.issues.map(x => h('div', { class: 'split' },
        h('div', null, h('div', { class: 'k' }, 'Rule'), h('div', { class: 'x' }, x.requirement || '–'), x.excerpt && h('p', { class: 'x' }, h('code', null, x.excerpt))),
        h('div', null, h('div', { class: 'k' }, 'Requested change'), h('div', { class: 'x' }, x.correction || '–'))))))));
  }

  // gates
  if (r.gates.length) {
    out.push(h('h2', null, 'Publication gates'), h('div', { class: 'card', 'data-title': 'batch driver' },
      h('ul', { class: 'plain' }, r.gates.map(g => h('li', null, h('span', { style: 'color:var(--good)', 'aria-hidden': 'true' }, '✓ '), g))),
      r.holds.length ? h('p', { class: 'small muted' }, `Held ${r.holds.length} time(s) before passing; see the timeline.`) : null,
      h('p', { class: 'faint small' }, 'Every gate must pass for the batch driver to post. It re-checks them on the exact bytes that get posted.')));
  }

  // findings + prior + limits
  if (r.prior_findings.length) {
    out.push(h('h2', null, 'Earlier findings, re-checked'), h('div', { class: 'card tbl-wrap', 'data-title': 'findings.json' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Finding'), h('th', null, 'Status'))),
      h('tbody', null, r.prior_findings.map(f => h('tr', null, h('td', { class: 'id' }, f.id), h('td', null, f.claim || '', f.reason && h('details', null, h('summary', null, 'Why'), h('p', { class: 'small muted' }, f.reason))), h('td', null, h('span', { class: 'badge' }, f.status || '–'))))))));
  }
  const lists = [];
  if (r.findings.length) lists.push(h('div', { class: 'card', 'data-title': 'what the comment raised' }, h('ul', { class: 'plain small' }, r.findings.map(x => h('li', null, x)))));
  if (r.limits.length) lists.push(h('div', { class: 'card', 'data-title': 'what was not tested' }, h('ul', { class: 'plain small muted' }, r.limits.map(x => h('li', null, x)))));
  if (lists.length) out.push(h('h2', null, 'Scope'), h('div', { class: 'grid g2' }, lists));

  if (r.retro) out.push(h('h2', null, 'Retrospective'), h('p', { class: 'muted small' }, 'Written by the coordinator after the review: what worked and what to change.'),
    h('div', { class: 'card', 'data-title': 'RETRO.md' }, md(r.retro.replace(/^# .*\n/, ''))));
  if (r.comment) out.push(h('details', { class: 'sec card', style: 'margin-top:24px', 'data-title': 'review-comment.md' }, h('summary', null, 'The posted comment'), md(r.comment),
    r.comment_url && h('p', null, ext(r.comment_url, 'View it on GitHub ↗'))));
  return out;
}

function lineChart(points, series, { yMax, yLabel }) {
  const W = 860, H = 280, m = { l: 36, r: 16, t: 14, b: 28 };
  const x = i => m.l + (W - m.l - m.r) * (points.length === 1 ? 0.5 : i / (points.length - 1));
  const y = v => m.t + (H - m.t - m.b) * (1 - v / yMax);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': yLabel });
  const step = yMax <= 40 ? 10 : yMax <= 100 ? 20 : 50;
  for (let t = 0; t <= yMax; t += step) {
    svg.append(s('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }), s('text', { class: 'axis-text', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, Math.round(t)));
  }
  points.forEach((p, i) => svg.append(s('text', { class: 'axis-text', x: x(i), y: H - 8, 'text-anchor': 'middle' }, p.label)));
  series.forEach((se, si) => {
    const pts = points.map((p, i) => [x(i), y(p[se.key])]).filter(([, yy]) => !isNaN(yy));
    svg.append(s('path', { class: si ? 'line2' : 'line', d: pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a},${b}`).join('') }));
    pts.forEach(([a, b]) => svg.append(s('circle', { class: si ? 'pt2' : 'pt', cx: a, cy: b, r: 4.5 })));
    const [lx, ly] = pts[pts.length - 1];
    svg.append(s('text', { class: 'lbl', x: lx - 4, y: ly - 10, 'text-anchor': 'end' }, se.label));
  });
  points.forEach((p, i) => {
    const hit = s('rect', { x: x(i) - 24, y: m.t, width: 48, height: H - m.t - m.b, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => tipShow(ev, [h('b', null, p.label), ...series.map(se => h('div', null, `${se.label}: ${p[se.key] ?? '–'}`)), p.extra ? h('div', { class: 'faint' }, p.extra) : null].filter(Boolean)));
    hit.addEventListener('mouseleave', tipHide);
    svg.append(hit);
  });
  return h('div', { class: 'chart' }, svg);
}

function commentTemplate(ct) {
  const out = [h('h2', null, 'Readable comments (2026-09-28)'),
    h('p', { class: 'muted' }, `After an author said a review was not useful, the comment rules changed: at most 1,500 visible characters, the outcome first, and evidence and reproducers in collapsed blocks. `,
      h('a', { href: `https://github.com/omacom/omarchy/pull/${ct.pr}` , target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, `#${ct.pr}`), ' is the worked example.')];
  const b = ct.live?.before, a = ct.live?.after;
  const pctf = v => v == null ? '–' : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
  const rows = [
    ['visible length, median', x => x && fmtNum(Math.round(x.visible_median))],
    ['visible length, longest 10% from', x => x && fmtNum(x.visible_p90)],
    ['within 1,500 visible characters', x => x && pctf(x.within_1500)],
    ['opens with an Outcome line', x => x && pctf(x.opens_with_outcome)],
    ['uses collapsed blocks', x => x && pctf(x.has_details)],
  ];
  if (b) out.push(h('div', { class: 'card tbl-wrap', 'data-title': 'posted comments, before and after' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'measure'), h('th', null, `before (${fmtNum(b.reviews)} reviews)`), h('th', null, a ? `after (${fmtNum(a.reviews)} reviews)` : 'after'))),
    h('tbody', null, rows.map(([label, f]) => h('tr', null, h('td', null, label), h('td', { class: 'num' }, f(b) ?? '–'), h('td', { class: 'num' }, a ? (f(a) ?? '–') : h('span', { class: 'faint' }, 'pending')))))),
    !a ? h('p', { class: 'faint small' }, 'The “after” column fills in once reviews written under the new rules have been posted and measured.') : null));
  if (ct.checks.length) {
    const order = [...ct.checks].sort((x, y) => (/as posted/.test(y.draft) ? 1 : 0) - (/as posted/.test(x.draft) ? 1 : 0));
    out.push(h('div', { class: 'card', 'data-title': `editorial checks of #${ct.pr}`, style: 'margin-top:var(--gap)' }, order.map(c => h('div', { class: 'item' },
      h('div', { class: 'hd' }, h('span', { class: 'claim' }, c.draft), h('span', { class: `badge ${c.verdict === 'pass' ? 'b-good' : 'b-warn'}` }, c.verdict),
        h('span', { class: 'num faint' }, `${fmtNum(c.visible_length)} visible chars`)),
      c.issues.length ? h('details', null, h('summary', null, `${c.issues.length} issue${c.issues.length > 1 ? 's' : ''}`), h('ul', { class: 'plain small muted' }, c.issues.map(x => h('li', null, x)))) : null))));
  }
  const d = ct.drafts || {};
  if (d.posted && d.new) {
    const pane = (title, x) => h('div', { class: 'card', 'data-title': title },
      h('p', { class: 'num faint small', style: 'margin-top:0' }, `${fmtNum(x.visible)} visible characters (${fmtNum(x.total)} in total)`),
      h('div', { class: 'scrollpane' }, md(x.markdown)));
    out.push(h('h3', { style: 'margin-top:1.4em' }, `The same review, old and new rules`),
      h('div', { class: 'grid g2' }, pane('as posted · old rules', d.posted), pane('new rules · draft, not posted', d.new)));
  }
  return out;
}

const STATUS_CLS = { applied: 'b-good', prepared: 'b-warn', 'already handled': 'b-info', decided: 'b-info' };
function rateMeter(label, m, cls) {
  if (!m) return null;
  const pct = m.of ? 100 * m.n / m.of : 0;
  return h('div', { class: 'row', title: `${label}: ${m.n} of ${m.of}` },
    h('div', { class: 'lab' }, label),
    h('div', { class: 'track' }, h('div', { class: `fill ${cls || ''}`, style: `width:${Math.max(pct, m.n ? 2 : 0).toFixed(1)}%` })),
    h('div', { class: 'val' }, `${m.n}/${m.of}`));
}
function improvementsSection(imp) {
  const out = [h('h2', null, imp.title), h('p', { class: 'muted' }, imp.summary),
    h('p', { class: 'note' }, imp.applied_at ? `Fixes applied ${fmtTime(imp.applied_at)}. “After” counts reviews dispatched since then.` : imp.applied_note)];
  out.push(h('div', { class: 'grid g2' }, imp.items.map(it => {
    const m = it.measure;
    return h('div', { class: 'card', 'data-title': `${it.role} · ${it.key}` },
      h('div', { class: 'hd', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('span', { class: 'claim' }, it.problem),
        h('span', { class: `badge ${STATUS_CLS[it.status] || ''}` }, it.status)),
      h('div', { class: 'split', style: 'grid-template-columns:1fr' },
        h('div', null, h('div', { class: 'k' }, 'why it mattered'), h('div', { class: 'x' }, it.why)),
        h('div', null, h('div', { class: 'k' }, 'what changed'), h('div', { class: 'x' }, it.fix))),
      m ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'k small faint', style: 'font:600 .68rem var(--mono);margin-bottom:4px' }, `» ${m.basis}`),
        h('div', { class: 'bars' }, rateMeter('before', m.before), m.after ? rateMeter('after', m.after, 'after') : h('div', { class: 'row' }, h('div', { class: 'lab' }, 'after'), h('div', { class: 'faint small' }, imp.applied_at ? 'no reviews posted since the fix yet' : 'measured once applied'), h('div')))) : null);
  })));
  return out;
}

const RETRO_CATS = [['worked', 'What worked', 'b-good'], ['friction', 'Friction', 'b-warn'], ['lesson', 'Lessons', 'b-info'], ['deviation', 'Disclosed deviations', '']];
function retroThemes(rt) {
  const out = [h('h2', null, `What the retrospectives say (${rt.batch})`),
    h('p', { class: 'muted' }, rt.method), rt.trend ? h('p', { class: 'note' }, rt.trend) : null];
  const known = new Set((INDEX?.reviews || []).map(r => r.id));
  const grid = h('div', { class: 'grid g2' });
  for (const [cat, label, cls] of RETRO_CATS) {
    const items = rt.themes.filter(t => t.category === cat).sort((x, y) => y.count - x.count);
    if (!items.length) continue;
    grid.append(h('div', { class: 'card', 'data-title': `${label.toLowerCase()} · ${items.length} themes` }, items.map(t => h('div', { class: 'item' },
      h('div', { class: 'hd' }, h('span', { class: 'claim' }, t.title), h('span', { class: `badge ${cls}` }, `${t.count} of ${rt.retros}`), t.role ? h('span', { class: 'badge' }, t.role) : null),
      h('p', { class: 'small muted', style: 'margin:6px 0 0' }, t.summary),
      t.examples?.length ? h('div', { class: 'small faint', style: 'margin-top:4px' }, 'e.g. ', t.examples.map((id, i) => [i ? ', ' : '',
        known.has(id) ? h('a', { href: `#/r/${encodeURIComponent(id)}` }, `#${id.split('-')[0]}`) : `#${id.split('-')[0]}`])) : null))));
  }
  out.push(grid);
  return out;
}

async function pageEvals() {
  if (!EVALS) EVALS = await getJSON('data/evals.json');
  try { await loadIndex(); } catch (_) {}
  const e = EVALS;
  const out = [h('h1', null, 'Why these models'),
    h('p', { class: 'lede' }, 'Each role was chosen by a blind evaluation. The judge verified every claimed issue against the pinned source without knowing which configuration wrote it.')];
  const mt = e.main_tuning;
  if (mt && Array.isArray(mt.versions) && mt.versions.length) {
    const [s1, s2] = mt.series;
    const pts = mt.versions.map(v => ({ label: v.version, [s1.key]: v[s1.key], [s2.key]: v[s2.key],
      extra: `of ${v.pool} · ${v.wrong} wrong, ${v.false_claims} false · ${v.min_per_pr} min/PR${v.chosen ? ' · chosen' : ''}` }));
    const promptLink = ((e.reports.find(r => r.id === 'sol61-vs-opus-20260929') || {}).subpages || []).find(x => x.id === 'v10-prompt');
    const at = mt.after_tuning || {}, val = at.validation_5_untouched_prs, fin = at.final_check_5_unseen_prs;
    out.push(h('h2', null, mt.title),
      h('div', { class: 'card', 'data-title': 'gpt 6.1 sol main-review prompt tuning' }, h('p', { class: 'small muted' }, mt.caption),
        lineChart(pts, mt.series, { yMax: mt.y_max || 25, yLabel: 'Issues found per prompt version' }),
        h('div', { class: 'legend', style: 'margin-top:8px' }, h('span', null, h('i', { style: 'background:var(--series-1)' }), s1.label), h('span', null, h('i', { style: 'background:var(--series-2)' }), s2.label)),
        (val || fin) ? h('p', { class: 'small', style: 'margin-top:10px' },
          val ? `After tuning, on 5 untouched validation PRs: v10 found ${val.v10}, untuned ${val.untuned}. ` : '',
          fin ? `On 5 unseen PRs (${fin.pool} issues in the pool), judged blind: v10 ${fin.v10}, Opus 5.5 ${fin.opus}, untuned ${fin.untuned}.` : '') : null,
        h('details', null, h('summary', null, 'Table'), h('div', { class: 'tbl-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Version', 'Idea', 'Found', 'Untuned', 'Partial', 'Wrong', 'False claims', 'Justified', 'Judged better', 'Min/PR', '$/PR'].map(x => h('th', null, x)))),
          h('tbody', null, mt.versions.map(v => h('tr', null, h('td', null, v.version, v.chosen ? ' ' : null, v.chosen ? h('span', { class: 'badge b-good' }, 'chosen') : null), h('td', null, v.hypothesis),
            [`${v.found}/${v.pool}`, v.baseline_found, v.partial, v.wrong, v.false_claims, `${v.justified}/5`, `${v.judged_better}/5`, v.min_per_pr, v.cost_per_pr != null ? fmtUSD(v.cost_per_pr) : null].map(x => h('td', { class: 'num' }, x ?? '–')))))))),
        promptLink ? h('p', { style: 'margin-top:10px' }, h('a', { href: `#/evals/sol61-vs-opus-20260929/${promptLink.id}` }, `${promptLink.label} →`)) : null));
  }
  if (e.tuning.length) {
    const pts = e.tuning.map(t => ({ label: t.version.replace('-baseline', ''), found: t.ref_found, targets: t.targets_found, extra: `${t.wrong ?? 0} wrong, ${t.minor ?? 0} minor · ${t.minutes_per_pr ?? '–'} min/PR` }));
    const refTotal = e.tuning[0].ref_total || 66;
    out.push(h('h2', null, 'Tuning the Sol hunter prompt'),
      h('div', { class: 'card', 'data-title': 'sol hunter prompt tuning' }, h('p', { class: 'small muted' }, `Issues found on a 10-PR tuning set. The reference is ${refTotal} valid issues from an Opus xhigh hunter. v4 was in production at the start.`),
        lineChart(pts, [{ key: 'found', label: `reference issues found (of ${refTotal})` }, { key: 'targets', label: 'named targets found' }], { yMax: Math.ceil(refTotal / 10) * 10, yLabel: 'Issues found per prompt version' }),
        h('div', { class: 'legend', style: 'margin-top:8px' }, h('span', null, h('i', { style: 'background:var(--series-1)' }), 'reference issues found'), h('span', null, h('i', { style: 'background:var(--series-2)' }), 'named targets found')),
        h('details', null, h('summary', null, 'Table'), h('div', { class: 'tbl-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Version', 'Reference found', 'Targets found', 'Valid extra', 'Wrong', 'Minor', 'Min/PR'].map(x => h('th', null, x)))),
          h('tbody', null, e.tuning.map(t => h('tr', null, [t.version, `${t.ref_found}/${t.ref_total}`, `${t.targets_found}/${t.targets_total}`, t.valid_extra, t.wrong, t.minor, t.minutes_per_pr].map(v => h('td', { class: 'num' }, v ?? '–'))))))))));
  }
  if (e.holdout) {
    const names = { 'opus-xhigh': 'Opus 5.5 xhigh, production prompt', 'sol-v11': 'GPT 6 Sol xhigh, prompt v11 (now in use)', 'sol-production': 'GPT 6 Sol xhigh, old prompt v4' };
    out.push(h('h2', null, 'Held-out check'), h('div', { class: 'card', 'data-title': 'held-out check' },
      h('p', { class: 'small muted' }, `5 PRs no tuning round used, 3 runs each, blind judge. ${e.holdout.pool_valid} valid issues in the pool.`),
      h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Configuration', 'Valid found', 'Partial', 'Wrong', 'Minor', 'Min/PR'].map(x => h('th', null, x)))),
        h('tbody', null, Object.entries(e.holdout.per_config).map(([k, v]) => h('tr', null, h('td', null, names[k] || k),
          [`${v.found} of ${e.holdout.pool_valid}`, v.partial, v.wrong, v.minor, v.minutes_per_pr].map(x => h('td', { class: 'num' }, x ?? '–')))))))));
  }
  if (e.comment_template) out.push(...commentTemplate(e.comment_template));
  for (const imp of e.improvements || []) out.push(...improvementsSection(imp));
  for (const rt of e.retro_themes || []) out.push(...retroThemes(rt));
  out.push(h('h2', null, 'Evaluation reports'), h('p', { class: 'muted' }, 'The full write-ups, as recorded. Paths refer to the review system’s own files.'),
    ...e.reports.map(rep => h('details', { class: 'sec card', style: 'margin-bottom:10px', 'data-title': `evals/${rep.id}/REPORT.md` }, h('summary', null, rep.title),
      (rep.subpages || []).length ? h('p', null, ...rep.subpages.map(sp => h('a', { href: `#/evals/${rep.id}/${sp.id}` }, `${sp.label} →`))) : null,
      md(rep.markdown.replace(/^# .*\n/, '')))));
  return out;
}

async function pageEvalSub(repId, subId) {
  if (!EVALS) EVALS = await getJSON('data/evals.json');
  const rep = EVALS.reports.find(r => r.id === repId);
  const sp = rep && (rep.subpages || []).find(x => x.id === subId);
  if (!sp) throw new Error('no such page');
  return [h('p', { class: 'small' }, h('a', { href: '#/evals' }, '← Evaluations'), h('span', { class: 'faint' }, ` · ${rep.title}`)),
    h('h1', null, sp.title),
    h('div', { class: 'card wrap-code', 'data-title': `evals/${rep.id}/${sp.id}` }, md(sp.markdown.replace(/^# .*\n/, '')))];
}

async function pageAbout() {
  const idx = await loadIndex();
  const roles = idx.roles || [];
  return [h('h1', null, 'Method and privacy'),
    h('h2', null, 'Where this data comes from'),
    h('p', null, 'Every figure on this site is exported from the review system’s own records by a read-only script. Nothing is typed in by hand. The export runs every few minutes, so the live batch can lag by that much.'),
    h('ul', { class: 'plain' },
      h('li', null, 'Hunter leads come from the Sol hunter’s structured output. The coordinator’s decision for each lead is its recorded note. The outcome label (used, already found, dropped…) is derived from that note automatically; the note itself is always shown.'),
      h('li', null, 'Self-check flags come from Opus’s check of the draft, with the coordinator’s recorded disposition for each.'),
      h('li', null, 'Editorial verdicts come from the editorial check records, matched to a review by team and time.'),
      h('li', null, 'Model, effort and turn counts come from the session logs that the batch driver also uses to verify models.')),
    h('h2', null, 'Current roles'),
    h('div', { class: 'card tbl-wrap', 'data-title': 'model-policy.json' }, h('table', null, h('thead', null, h('tr', null, ['Role', 'Model', 'Effort', 'Runs in'].map(x => h('th', null, x)))),
      h('tbody', null, roles.map(r => h('tr', null, h('td', null, r.role.replace(/_/g, ' ')), h('td', null, h('code', null, r.model || '–')), h('td', null, r.effort || '–'), h('td', { class: 'muted' }, r.runtime || '–')))))),
    h('h2', null, 'Costs'),
    h('p', null, 'Sol costs are the per-call costs reported by its runtime. Editorial costs are reported by Claude Code. Coordinator and Opus reviewer costs are computed from token counts in the session logs at Anthropic API list prices, so they are API-equivalent estimates: the service runs on a Claude subscription, not per-token billing.'),
    h('div', { class: 'card tbl-wrap', 'data-title': 'prices' }, h('table', null, h('thead', null, h('tr', null, ['Model', 'Input $/M', 'Output $/M', 'Cache read $/M'].map(x => h('th', null, x)))),
      h('tbody', null, Object.entries(idx.prices).map(([k, v]) => h('tr', null, h('td', null, h('code', null, k)), [v.input, v.output, v.cache_read].map(x => h('td', { class: 'num' }, `$${x.toFixed(2)}`))))))),
    h('p', { class: 'small muted' }, 'Cache writes are priced at 1.25× input for 5-minute entries and 2× for 1-hour entries.'),
    h('h2', null, 'What is not shown, and why'),
    h('ul', { class: 'plain' },
      h('li', null, 'Reviews in progress show only their current step. Drafts and evidence appear after the comment is posted.'),
      h('li', null, 'Reviews stopped by security triage are counted but not listed.'),
      h('li', null, 'Reviews of pull requests by contributors who opted out of automated reviews are not shown. Their other pull requests may be mentioned like any other.'),
      h('li', null, 'PR authors are not named; review text refers to “the author”.'),
      h('li', null, 'Raw transcripts, tool output, prompts sent to models and the reviewers’ working files are not published. Local file locations are rewritten, and a final check blocks the build if any private detail remains.'),
      h('li', null, 'Everything taken from pull requests is shown as plain text and never executed.')),
    h('h2', null, 'Limits'),
    h('p', null, 'The coordinators write their decision records by hand, and their format has changed over time. Older batches, before the hunter and self-check existed, show less detail. Outcome labels are derived automatically from those records; when in doubt, read the note next to them.')];
}

// ------------------------------------------------------------ router
async function route() {
  tipHide();
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const [seg, arg, sub] = path.split('/');
  setNav(seg === 'r' ? 'reviews' : seg || '');
  $app.replaceChildren(h('div', { class: 'loading' }, 'loading '));
  try {
    const nodes = seg === 'reviews' ? await pageReviews(params) : seg === 'r' ? await pageReview(decodeURIComponent(arg || ''))
      : seg === 'how' ? await pageHow() : seg === 'evals' ? (arg ? await pageEvalSub(decodeURIComponent(arg), decodeURIComponent(sub || '')) : await pageEvals()) : seg === 'about' ? await pageAbout() : await pageOverview();
    $app.replaceChildren(...nodes);
    document.title = seg === 'r' ? `#${(arg || '').split('-')[0]} · Review Transparency` : 'Review Transparency';
    if (!location.hash.includes('?')) window.scrollTo(0, 0);
  } catch (err) {
    $app.replaceChildren(h('h1', null, 'Not found'), h('p', { class: 'muted' }, 'This page or review is not available.'), h('p', null, h('a', { href: '#/' }, 'Back to the overview')));
    console.error(err);
  }
  footer();
}
async function footer() {
  const f = document.getElementById('foot');
  try { await loadIndex(); } catch (_) {}
  f.replaceChildren(INDEX ? `data exported ${fmtTime(INDEX.generated)} (${ago(INDEX.generated)}) · ` : '', 'independent community project, not affiliated with the Omarchy team');
  const st = document.getElementById('status');
  const live = INDEX && (INDEX.batches.find(b => b.live));
  if (st && live) {
    const c = live.counts, done = (c.published_verified || 0) + (c.published || 0);
    st.replaceChildren(h('span', { class: 'dot' }, c.running ? '● ' : '○ '), `${live.id}  ${done}/${live.target || '?'} posted · ${c.running || 0} running · ${ago(INDEX.generated)}`);
  }
}

// themes (named after Omarchy's built-in themes). Tokyo Night is the default; the button opens a picker, T opens it too.
const THEMES = [
  { id: 'tokyo-night', label: 'Tokyo Night', bg: '#1a1b26', a: '#7aa2f7', b: '#ff9e64' },
  { id: 'catppuccin', label: 'Catppuccin', bg: '#1e1e2e', a: '#89b4fa', b: '#fab387' },
  { id: 'gruvbox', label: 'Gruvbox', bg: '#282828', a: '#83a598', b: '#fe8019' },
  { id: 'nord', label: 'Nord', bg: '#2e3440', a: '#88c0d0', b: '#d08770' },
  { id: 'rose-pine', label: 'Rosé Pine', bg: '#1f1d2e', a: '#c4a7e7', b: '#f6c177' },
  { id: 'matte-black', label: 'Matte Black', bg: '#121212', a: '#e68e0d', b: '#d35f5f' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', bg: '#eff1f5', a: '#1e66f5', b: '#fe640b' },
  { id: 'flexoki-light', label: 'Flexoki Light', bg: '#fffcf0', a: '#205ea6', b: '#bc5215' },
];
const DEFAULT_THEME = 'tokyo-night';
const swatch = t => { const e = h('span', { class: 'sw', 'aria-hidden': 'true' }); e.style.background = `linear-gradient(90deg, ${t.a} 0 50%, ${t.b} 50% 100%)`; e.style.outline = `3px solid ${t.bg}`; return e; };
const $themeBtn = document.getElementById('theme');
let $menu = null;

function applyTheme(id, save) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  $themeBtn.replaceChildren(swatch(t), h('span', { class: 'tn' }, t.label), h('kbd', null, 'T'));
  $themeBtn.title = 'Choose a theme (T)';
  if (save) try { localStorage.setItem('theme', t.id); } catch (_) {}
}
function closeMenu(focusBtn) {
  if (!$menu) return;
  $menu.remove(); $menu = null;
  $themeBtn.setAttribute('aria-expanded', 'false');
  if (focusBtn) $themeBtn.focus();
}
function placeMenu() {
  if (!$menu) return;
  const r = $themeBtn.getBoundingClientRect();
  $menu.style.top = `${r.bottom + 6}px`;
  $menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
}
function openMenu() {
  if ($menu) return closeMenu(true);
  const cur = document.documentElement.dataset.theme;
  const items = THEMES.map(t => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(t.id === cur), class: t.id === cur ? 'on' : '',
    onclick: () => { applyTheme(t.id, true); closeMenu(true); } }, swatch(t), h('span', null, t.label), t.id === cur ? h('span', { class: 'chk', 'aria-hidden': 'true' }, '●') : null));
  $menu = h('div', { class: 'theme-menu', role: 'menu', 'aria-label': 'Themes' }, h('div', { class: 'tm-title' }, 'themes'), items);
  $menu.addEventListener('keydown', e => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.body.append($menu);
  placeMenu();
  $themeBtn.setAttribute('aria-expanded', 'true');
  (items.find(b => b.classList.contains('on')) || items[0]).focus();
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch (_) {}
  applyTheme(THEMES.some(t => t.id === saved) ? saved : DEFAULT_THEME, false);
  $themeBtn.setAttribute('aria-haspopup', 'menu');
  $themeBtn.setAttribute('aria-expanded', 'false');
  $themeBtn.addEventListener('click', e => { e.stopPropagation(); openMenu(); });
  document.addEventListener('click', e => { if ($menu && !$menu.contains(e.target)) closeMenu(false); });
  addEventListener('resize', placeMenu);   // mobile address bars fire resize; keep the menu open
  addEventListener('scroll', placeMenu, { passive: true });
  addEventListener('keydown', e => {
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey && !$menu && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) openMenu();
  });
})();

addEventListener('hashchange', route);
addEventListener('scroll', tipHide, { passive: true });
setInterval(async () => {
  try {
    const fresh = await getJSON('data/index.json');
    if (fresh.generated !== INDEX?.generated) { INDEX = fresh; cache.clear(); if (!location.hash.startsWith('#/r/')) route(); else footer(); }
  } catch (_) {}
}, REFRESH_MS);
route();
