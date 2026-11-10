import { lineChart, barChart, paceCurve, COLORS } from './charts.js';
import * as Sync from './sync.js';

// ---------------------------------------------------------------- plumbing
let S = null;                       // last /api/state payload
const ui = { tab: location.hash.slice(1).split('?')[0] || 'dashboard', open: new Set(), filters: { q: '', cat: '', disc: '', status: '', tier: '', refs: true, computable: false, sort: 'gap' } };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Served by node server.mjs, or standing alone as an installed PWA off static hosting.
// In the second case the identical routes are answered in this tab — see public/local.js.
const SERVER = !!window.CRUSHER_SERVER;
const LOCAL = SERVER ? null : await (await import('./local.js')).boot();
const api = async (path, opts) => {
  const method = opts?.method || (opts ? 'POST' : 'GET');
  if (LOCAL) { const out = await LOCAL(path, method, opts?.body || {}); schedulePush(path, method); return out; }
  schedulePush(path, method);
  let init;
  if (opts) {
    init = { method, headers: { 'content-type': 'application/json' } };
    if (!/^(GET|HEAD)$/.test(method)) init.body = JSON.stringify(opts.body || {});   // fetch throws on GET+body
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
};

// Anything that changed your data schedules a quiet push. Debounced so a burst of edits
// sends once, and never on the sync endpoints themselves (that would recurse).
let pushTimer = null, lastPush = 0;
function schedulePush(path, method) {
  if (method === 'GET' || /\/api\/(backup|restore|state|plan)/.test(path)) return;
  const cfg = syncCfg();
  if (!cfg.auto) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (Date.now() - lastPush < 20000) return;                  // min gap: don't hammer Drive
    try {
      const p = Sync.getSyncProvider(cfg.provider);
      if (!p || !(await p.isConnected())) return;               // only with a live grant
      const r = await Sync.backupTo(cfg.provider, cfg, api, { silent: true });
      lastPush = r.at;
      setSyncCfg({ lastSync: r.at, lastNote: 'auto' });
      if (ui.tab === 'connect') connect();
    } catch { /* offline, or the grant lapsed — the next manual sync says so */ }
  }, 5000);
}
// Sync setup is per-device (which folder, which Google account, auto on or off), so it
// lives in localStorage on both backends rather than in the athlete row.
const SYNC_KEY = 'crusher.sync';
const DEFAULT_SYNC = { provider: 'localFolder', driveClientId: '', auto: false, lastSync: 0, lastNote: '' };
const syncCfg = () => { try { return { ...DEFAULT_SYNC, ...JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') }; } catch { return { ...DEFAULT_SYNC }; } };
const setSyncCfg = patch => {
  const c = { ...syncCfg(), ...patch };
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(c)); } catch { /* private mode */ }
  return c;
};

const toast = (msg, ms = 3200) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); };

const fmtDur = v => { const sign = v < 0 ? '-' : ''; let s = Math.abs(Math.round(v)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return sign + (h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`); };
const fmtPace = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtKm = m => m >= 1000 ? `${(m / 1000).toFixed(m < 100000 ? 1 : 0)} km` : `${Math.round(m)} m`;
const pct = v => `${Math.round(v * 100)}%`;
const STATUS_LABEL = { crushed: 'Crushed', in_reach: 'In reach', close: 'Close', trainable: 'Trainable', far: 'Far', logbook: 'Logbook', sacred: 'Apart' };
const chip = st => `<span class="chip s-${st}">${STATUS_LABEL[st] || st}</span>`;
const gapBar = v => v == null ? '' : `<span class="bar ${v >= 1 ? 'done' : ''}"><i style="width:${Math.min(100, Math.max(2, v * 100)).toFixed(0)}%"></i></span>`;

const TABS = [['dashboard', 'Dashboard'], ['ledger', 'The Ledger'], ['queue', 'Queue'], ['goals', 'Goals'], ['analytics', 'Analytics'], ['connect', 'Connect']];

// ---------------------------------------------------------------- boot
async function load() {
  S = await api('/api/state');
  render();
}
function render() {
  $('#nav').innerHTML = TABS.map(([id, label]) =>
    `<button data-action="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}">${label}${id === 'queue' && S.queue.length ? ` <span class="count">${S.queue.length}</span>` : ''}${id === 'goals' && S.goals.length ? ` <span class="count">${S.goals.length}</span>` : ''}</button>`).join('');
  for (const [id] of TABS) $(`#view-${id}`).hidden = id !== ui.tab;
  $('#who-am-i').textContent = `${S.athlete?.name || 'Athlete'} · ${S.activity_count} activities · ${Object.keys(S.providers).filter(p => S.providers[p].connected).join(' + ') || 'no provider'}`;
  ({ dashboard: dashboard, ledger: ledger, queue: queueView, goals: goalsView, analytics: analytics, connect: connect })[ui.tab]();
  location.hash = ui.tab;
}

const counts = () => {
  const c = {};
  for (const f of S.feats) { const v = S.verdicts[f.id]; c[v.status] = (c[v.status] || 0) + 1; }
  return c;
};
const marathonPrediction = () => S.profile.pbs.find(p => p.distance_m === 42195)?.predicted || null;
const openFeats = () => S.feats.map(f => ({ f, v: S.verdicts[f.id] }))
  .filter(x => !['crushed', 'sacred', 'logbook'].includes(x.v.status) && x.v.gap != null);
/** Already inside your range but not yet done — hardest of the achievable first. */
const bagNow = () => openFeats().filter(x => x.v.gap >= 1).sort((a, b) => a.v.gap - b.v.gap);
/** Not yet in range — nearest miss first. */
const nearMiss = () => openFeats().filter(x => x.v.gap < 1).sort((a, b) => b.v.gap - a.v.gap);

// ---------------------------------------------------------------- dashboard
function dashboard() {
  const c = counts(), mp = marathonPrediction(), fit = S.profile.fitness;
  const marathons = S.feats.filter(f => f.check.kind === 'run_time' && f.check.distance_m === 42195 && !f.reference)
    .sort((a, b) => a.check.seconds - b.check.seconds);
  // chasing = the nearest name still faster than you; clearOf = the nearest one you have passed
  const chasing = mp ? [...marathons].reverse().find(f => f.check.seconds < mp) : null;
  const clearOf = mp ? marathons.find(f => f.check.seconds > mp) : null;
  const now = bagNow().slice(0, 8), near = nearMiss().slice(0, 8);
  const crushed = S.feats.filter(f => S.verdicts[f.id].status === 'crushed');
  const sacred = S.feats.find(f => f.sacred);

  $('#view-dashboard').innerHTML = `
    <div class="grid stats">
      <div class="stat accent"><div class="k">Crushed</div><div class="v">${c.crushed || 0}</div><div class="sub">of ${S.feat_stats.total} feats</div></div>
      <div class="stat"><div class="k">In reach today</div><div class="v">${c.in_reach || 0}</div><div class="sub">current fitness clears them</div></div>
      <div class="stat"><div class="k">Close</div><div class="v">${c.close || 0}</div><div class="sub">within 10%</div></div>
      <div class="stat"><div class="k">Trainable</div><div class="v">${c.trainable || 0}</div><div class="sub">inside 3 years</div></div>
      <div class="stat"><div class="k">Fitness (CTL)</div><div class="v">${Math.round(fit.ctl)}</div><div class="sub">form ${fit.tsb >= 0 ? '+' : ''}${Math.round(fit.tsb)} · ramp ${fit.ramp >= 0 ? '+' : ''}${Math.round(fit.ramp)}/4wk</div></div>
      ${acwrTile(fit)}
      <div class="stat"><div class="k">VO₂max (estimated)</div><div class="v">${S.profile.vo2max ? S.profile.vo2max.toFixed(1) : '—'}</div><div class="sub">Daniels, from your race pace</div></div>
      <div class="stat"><div class="k">Marathon projection</div><div class="v">${mp ? fmtDur(mp) : '—'}</div><div class="sub">${mp ? bandLabel(42195) || fmtPace(mp / 42.195) + '/km' : 'no run data'}</div></div>
    </div>

    ${mp ? `<div class="card" style="margin-bottom:1.4rem">
      <p class="eyebrow">Where you sit on the table</p>
      <p style="font-size:1.05rem;margin-top:.5rem">
        ${chasing ? `You are <b class="mono">${fmtDur(mp - chasing.check.seconds)}</b> off <b>${esc(chasing.who)}</b> <span class="mono dim">${esc(chasing.display)}</span>` : 'Nothing on the table is faster than your projection'}
        ${clearOf ? ` and <b class="mono">${fmtDur(clearOf.check.seconds - mp)}</b> clear of <b>${esc(clearOf.who)}</b> <span class="mono dim">${esc(clearOf.display)}</span>.` : '.'}
      </p>
      <p class="dim tiny" style="margin-top:.5rem">Projection from your own best efforts, not a plan. ${S.profile.counts.runs} runs on file, improving at ${pct(S.profile.improveRate)}/year.${secondOpinion()}</p>
    </div>` : ''}

    ${rivalCard()}

    <div class="grid split">
      <div class="card">
        <p class="eyebrow">Go and take these — in range, not yet done</p>
        <table style="margin-top:.6rem"><tbody>
          ${now.map(({ f, v }) => featRow(f, v)).join('') || '<tr><td class="dim tiny">nothing in range yet</td></tr>'}
        </tbody></table>
        <p class="eyebrow" style="margin-top:1.2rem">Nearest misses — the training list</p>
        <table style="margin-top:.6rem"><tbody>
          ${near.map(({ f, v }) => featRow(f, v)).join('') || '<tr><td class="dim tiny">nothing close</td></tr>'}
        </tbody></table>
      </div>
      <div class="card">
        <p class="eyebrow">Already crushed ${crushed.length ? '<button class="btn ghost" style="float:right" data-action="share-card">Share card</button>' : ''}</p>
        ${crushed.length ? `<ul style="list-style:none;margin-top:.6rem">${crushed.slice(0, 10).map(f => `<li style="padding:.35rem 0;border-bottom:1px solid var(--hairline)">
          <b>${esc(f.who)}</b> <span class="dim">${esc(f.title)}</span>
          <div class="tiny faint">${esc(S.verdicts[f.id].headline)}</div></li>`).join('')}</ul>
          ${crushed.length > 10 ? `<p class="tiny faint" style="margin-top:.5rem">+${crushed.length - 10} more in the ledger</p>` : ''}`
      : '<p class="dim tiny" style="margin-top:.6rem">Nothing yet. Connect a provider, or seed the demo athlete on the Connect tab.</p>'}
      </div>
    </div>

    <h2>Fitness and volume</h2>
    <div class="grid split">
      <div class="card"><p class="eyebrow">Fitness / fatigue (42d vs 7d load)</p><div class="chart" id="ch-fitness"></div>
        <div class="legend"><span><i style="background:${COLORS.ember}"></i>Fitness</span><span><i style="background:${COLORS.steel}"></i>Fatigue</span></div></div>
      <div class="card"><p class="eyebrow">Weekly running volume</p><div class="chart" id="ch-weekly"></div></div>
    </div>

    ${sacred ? `<div class="sacred" style="margin-top:1.6rem">
      <p class="label">The Canadian Line</p>
      <p>${esc(sacred.who)}, ${sacred.year}: <b class="mono">${esc(sacred.display)}</b> — ${esc(sacred.note)}</p>
    </div>` : ''}`;

  drawFitness('#ch-fitness'); drawWeekly('#ch-weekly');
}

/** What the other model says about the marathon, and whether logged races have moved the dial. */
function secondOpinion() {
  const alt = (S.profile.bands || []).find(x => x.distance_m === 42195)?.alt, cal = S.profile.calibration;
  return (alt ? ` Second opinion (Daniels VDOT, no penalties): <span class="mono">${fmtDur(alt)}</span>.` : '')
    + (cal?.races ? ` Calibrated against ${cal.races} logged race${cal.races === 1 ? '' : 's'} (×${cal.bias.toFixed(3)}).` : '');
}

/** 1200×630 PNG of the headline numbers, drawn straight to a canvas. */
function shareCard() {
  const crushed = S.feats.filter(f => S.verdicts[f.id].status === 'crushed' && !f.reference).sort((a, b) => (b.tier || 0) - (a.tier || 0));
  const total = S.feats.filter(f => S.verdicts[f.id].status === 'crushed').length, mp = marathonPrediction();
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const cv = Object.assign(document.createElement('canvas'), { width: 1200, height: 630 }), g = cv.getContext('2d');
  g.fillStyle = '#16130f'; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = css('--ember') || '#e8622c'; g.fillRect(0, 0, 12, 630);
  g.font = '600 30px Fraunces, Georgia, serif'; g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.fillText('Celebrity Crusher', 70, 90);
  g.font = '700 190px Fraunces, Georgia, serif'; g.fillStyle = css('--ember') || '#e8622c'; g.fillText(String(total), 62, 290);
  g.font = '400 34px Georgia, serif'; g.fillStyle = css('--bone') || '#efe6d5';
  g.fillText(`celebrity fitness feats crushed, of ${S.feat_stats.total}`, 70, 345);
  g.font = '400 30px Georgia, serif';
  crushed.slice(0, 5).forEach((f, i) => {
    g.fillStyle = css('--bone') || '#efe6d5'; g.fillText(f.who, 640, 150 + i * 78, 500);
    g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.font = '400 22px JetBrains Mono, monospace';
    g.fillText(f.display || f.title, 640, 182 + i * 78, 500); g.font = '400 30px Georgia, serif';
  });
  g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.font = '400 24px JetBrains Mono, monospace';
  g.fillText([mp && `marathon projection ${fmtDur(mp)}`, S.profile.vo2max && `VO₂max ${S.profile.vo2max.toFixed(1)}`,
    new Date().toISOString().slice(0, 10)].filter(Boolean).join('  ·  '), 70, 570);
  cv.toBlob(b => { download('celebrity-crusher-card.png', 'image/png', b); toast('Card saved'); });
}

/** Their mark, your mark, and both pulled to the same age. */
const h2hBlock = (h, f) => `<div class="card" style="margin:.7rem 0;background:var(--panel-2)">
  <p class="eyebrow">Head to head</p>
  <table class="tiny" style="margin-top:.4rem"><tbody>
    <tr><td>${esc(f.who)} at ${h.their_age}</td><td class="num mono">${fmtDur(h.their_seconds)}</td><td class="num">${h.beats_raw ? '' : chip('crushed')}</td></tr>
    <tr><td>You${h.your_age ? ` at ${h.your_age}` : ''}</td><td class="num mono">${fmtDur(h.your_seconds)}</td><td class="num">${h.beats_raw ? chip('crushed') : ''}</td></tr>
    ${h.their_seconds_at_your_age ? `<tr><td class="dim">Their run, age-adjusted to you</td><td class="num mono dim">${fmtDur(h.their_seconds_at_your_age)}</td>
      <td class="num">${h.beats_age_adjusted ? '<span class="chip s-crushed">You win</span>' : '<span class="chip s-close">They win</span>'}</td></tr>` : ''}
  </tbody></table>
  <p class="tiny faint" style="margin-top:.4rem">${esc(h.note)}</p></div>`;

/** Everything not yet done, bucketed by the month the engine thinks it falls. */
function forecast() {
  const rows = openFeats().filter(x => x.v.status !== 'in_reach' && x.v.eta_weeks > 0 && x.v.eta_weeks <= 156)
    .map(x => ({ ...x, weeks: x.v.eta_weeks, date: new Date(Date.now() + x.v.eta_weeks * 7 * 86400000) }))
    .sort((a, b) => a.weeks - b.weeks);
  const nowCount = S.feats.filter(f => ['crushed', 'in_reach'].includes(S.verdicts[f.id].status)).length;
  const points = [];
  let cum = nowCount;
  for (let m = 0; m <= 36; m++) {
    if (m) cum += rows.filter(r => r.weeks > (m - 1) * 4.345 && r.weeks <= m * 4.345).length;
    points.push([m, cum]);
  }
  return { rows, points, nowCount };
}

const featRow = (f, v) => `<tr class="row" data-action="goto-feat" data-feat="${f.id}">
  <td class="who">${esc(f.who)}<div class="tiny dim">${esc(f.title)}</div></td>
  <td class="val tiny">${esc(f.display || '')}</td>
  <td style="width:130px">${gapBar(v.gap)}<div class="tiny faint mono">${pct(v.gap)}${v.eta_weeks ? ` · ${v.eta_weeks}w` : ''}</div></td>
  <td class="num">${chip(v.status)}</td></tr>`;

/** Acute:chronic workload ratio — the one number that predicts injuries rather than performance. */
function acwrTile(fit) {
  const r = fit.acwr;
  if (!r) return `<div class="stat"><div class="k">Load ratio</div><div class="v">—</div><div class="sub">not enough history</div></div>`;
  const [label, cls] = r > 1.5 ? ['spiking', 's-close'] : r > 1.3 ? ['high', 's-in_reach']
    : r < 0.8 ? ['detraining', 's-logbook'] : ['sweet spot', 's-crushed'];
  return `<div class="stat"><div class="k">Load ratio (7d:28d)</div><div class="v ${cls}" style="color:currentColor">${r.toFixed(2)}</div>
    <div class="sub">${label}${r > 1.5 ? ' — this is where injuries come from' : ''}</div></div>`;
}

const bandLabel = d => {
  const b = (S.profile.bands || []).find(x => Math.abs(x.distance_m - d) < 1);
  return b && b.low ? `${fmtDur(b.low)}–${fmtDur(b.high)} · ±${Math.round(b.pct * 100)}%` : null;
};

function rivalCard() {
  const id = S.athlete?.settings?.rival;
  const f = id && S.feats.find(x => x.id === id);
  if (!f) return '';
  const v = S.verdicts[f.id];
  return `<div class="card" style="margin-bottom:1.4rem;border-left:2px solid var(--ember)">
    <p class="eyebrow">Pinned rival</p>
    <p style="font-size:1.05rem;margin-top:.4rem"><b>${esc(f.who)}</b> — ${esc(f.title)} <span class="mono dim">${esc(f.display || '')}</span> ${chip(v.status)}</p>
    <p class="tiny dim" style="margin-top:.3rem">${esc(v.headline)}</p>
    ${v.gap != null ? `<div class="bar-row" style="margin-top:.5rem;max-width:520px">${gapBar(v.gap)}<span class="tiny mono faint">${pct(v.gap)}${v.eta_weeks ? ` · ${v.eta_weeks} weeks at current trend` : ' · now'}</span></div>` : ''}
    ${v.h2h?.their_seconds_at_your_age ? `<p class="tiny faint" style="margin-top:.4rem">${esc(v.h2h.note)}</p>` : ''}
  </div>`;
}

function weeklySeries(sport = 'run') {
  const arr = S.profile.series.byDaySport[sport] || [];
  const day0 = S.profile.series.day0, weeks = [];
  for (let i = 0; i < arr.length; i += 7) {
    weeks.push({ y: arr.slice(i, i + 7).reduce((a, b) => a + b, 0) / 1000, day: day0 + i });
  }
  return weeks.slice(-52);
}
function drawWeekly(sel) {
  const w = weeklySeries('run');
  barChart($(sel), {
    bars: w.map(x => ({ y: x.y, title: `${new Date(x.day * 86400000).toISOString().slice(0, 10)}: ${x.y.toFixed(1)} km` })),
    yFmt: v => `${Math.round(v)}k`, xFmt: i => { const d = w[i]; return d ? new Date(d.day * 86400000).toISOString().slice(2, 7) : ''; },
    marks: [{ y: w.reduce((a, b) => a + b.y, 0) / Math.max(1, w.length), label: 'avg', color: COLORS.gold }],
  });
}
function drawFitness(sel) {
  const { ctl, atl, day0 } = S.profile.series;
  const from = Math.max(0, ctl.length - 365);
  const pts = a => a.slice(from).map((v, i) => [day0 + from + i, v]);
  lineChart($(sel), {
    series: [{ name: 'Fitness', color: COLORS.ember, points: pts(ctl), area: true }, { name: 'Fatigue', color: COLORS.steel, points: pts(atl), width: 1.1 }],
    yFmt: v => Math.round(v), xFmt: d => new Date(d * 86400000).toISOString().slice(2, 7),
  });
}

// ---------------------------------------------------------------- ledger
function ledger() {
  const cats = [...new Set(S.feats.map(f => f.category))];
  const discs = [...new Set(S.feats.map(f => f.discipline))];
  const f = ui.filters;
  const rows = filtered();
  $('#view-ledger').innerHTML = `
    <h2>The Ledger</h2>
    <p class="dek">${S.feat_stats.total} feats, ${S.feat_stats.celebrities} names, ${S.feat_stats.computable} of them judged automatically against your own data. Click a row for the gap, the plan and the paperwork.</p>
    <div class="controls">
      <input type="text" id="q" placeholder="search name, feat, event" value="${esc(f.q)}">
      <select id="cat"><option value="">All categories</option>${cats.map(c => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="disc"><option value="">All disciplines</option>${discs.map(c => `<option ${f.disc === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="status"><option value="">Any verdict</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="sort">
        <option value="gap" ${f.sort === 'gap' ? 'selected' : ''}>Sort: closest first</option>
        <option value="who" ${f.sort === 'who' ? 'selected' : ''}>Sort: name</option>
        <option value="tier" ${f.sort === 'tier' ? 'selected' : ''}>Sort: hardest first</option>
        <option value="year" ${f.sort === 'year' ? 'selected' : ''}>Sort: most recent</option>
      </select>
      <select id="tier"><option value="">Any difficulty</option>${[1,2,3,4,5].map(t => `<option value="${t}" ${f.tier == t ? 'selected' : ''}>${'●'.repeat(t)}${'○'.repeat(5 - t)}</option>`).join('')}</select>
      <label class="tiny dim"><input type="checkbox" id="refs" ${f.refs ? 'checked' : ''}> reference lines</label>
      <label class="tiny dim"><input type="checkbox" id="computable" ${f.computable ? 'checked' : ''}> machine-checkable only</label>
      <button class="btn ghost" data-action="export-csv">Export CSV</button>
      <span class="tiny faint mono">${rows.length} shown</span>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Feat</th><th>The numbers</th><th class="num">Age</th><th>Verdict</th><th>Gap</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table>`;
  for (const [id, key, ev] of [['q', 'q', 'input'], ['cat', 'cat', 'change'], ['disc', 'disc', 'change'], ['status', 'status', 'change'], ['sort', 'sort', 'change'], ['tier', 'tier', 'change']])
    $('#' + id).addEventListener(ev, e => { ui.filters[key] = e.target.value; ledger(); if (ev === 'input') $('#q').focus(); });
  for (const id of ['refs', 'computable'])
    $('#' + id).addEventListener('change', e => { ui.filters[id] = e.target.checked; ledger(); });
  for (const id of ui.open) hydrateDetail(id);
}

function filtered() {
  const f = ui.filters, q = f.q.toLowerCase();
  let rows = S.feats.filter(x => {
    if (!f.refs && x.reference) return false;
    if (f.computable && x.check.kind === 'manual') return false;
    if (f.tier && String(x.tier) !== String(f.tier)) return false;
    if (f.cat && x.category !== f.cat) return false;
    if (f.disc && x.discipline !== f.disc) return false;
    if (f.status && S.verdicts[x.id].status !== f.status) return false;
    if (q && !`${x.who} ${x.title} ${x.event} ${x.note}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const g = x => S.verdicts[x.id].gap ?? -1;
  const order = { gap: (a, b) => g(b) - g(a), who: (a, b) => a.who.localeCompare(b.who), tier: (a, b) => (b.tier || 0) - (a.tier || 0), year: (a, b) => (b.year || 0) - (a.year || 0) };
  return rows.sort(order[f.sort] || order.gap);
}

function rowHtml(f) {
  const v = S.verdicts[f.id], open = ui.open.has(f.id);
  return `<tr class="row ${open ? 'open' : ''}" data-action="toggle" data-feat="${f.id}">
    <td class="who">${esc(f.who)}${f.proAsterisk ? '<span class="sup">†</span>' : ''}${f.flag ? ` <span class="tiny faint">${f.flag}</span>` : ''}<div class="tiny faint">${esc(f.category)}</div></td>
    <td>${esc(f.title)}${f.approx ? '<span class="sup">*</span>' : ''}<div class="tiny faint">${esc(f.event || '')}</div></td>
    <td class="val">${esc(f.display || '')}</td>
    <td class="num mono tiny">${f.age ?? esc(f.ageLabel || '—')}</td>
    <td>${chip(v.status)}${f.gated || f.logistics ? ' <span class="chip s-far">Gated</span>' : ''}</td>
    <td style="width:120px">${gapBar(v.gap)}<div class="tiny faint mono">${v.gap != null ? pct(v.gap) : ''}${v.eta_weeks ? ` · ${v.eta_weeks}w` : ''}</div></td>
    <td class="num tiny faint mono">${open ? '▾' : '▸'}</td>
  </tr>
  ${open ? `<tr class="detail" data-detail="${f.id}"><td colspan="7"><div id="d-${cssId(f.id)}">loading…</div></td></tr>` : ''}`;
}
const cssId = id => id.replace(/[^\w-]/g, '_');

async function hydrateDetail(featId) {
  const f = S.feats.find(x => x.id === featId), v = S.verdicts[featId];
  const box = $(`#d-${cssId(featId)}`);
  if (!box) return;
  const queued = S.queue.find(q => q.feat_id === featId);
  const goal = S.goals.find(g => g.feat_id === featId);
  const attempts = S.attempts.filter(a => a.feat_id === featId);
  box.innerHTML = `
    <p style="max-width:75ch">${esc(f.note)}</p>
    <div class="kv">
      <div><div class="k">Verdict</div><div class="v">${chip(v.status)}</div></div>
      ${v.gap != null ? `<div><div class="k">You vs them</div><div class="v">${pct(v.gap)}</div></div>` : ''}
      ${v.eta_weeks ? `<div><div class="k">At current trend</div><div class="v">${v.eta_weeks} wk</div></div>` : ''}
      <div><div class="k">Confidence</div><div class="v tiny">${esc(f.confidence)}</div></div>
      <div><div class="k">Difficulty</div><div class="v">${'●'.repeat(f.tier || 0)}${'○'.repeat(5 - (f.tier || 0))}</div></div>
    </div>
    <p class="mono tiny" style="color:var(--bone)">${esc(v.headline)}</p>
    ${v.band ? `<p class="tiny faint mono">Confidence band: ${fmtDur(v.band.low)}–${fmtDur(v.band.high)} (±${Math.round(v.band.pct * 100)}%, from how much measured racing your data contains${v.band.alt ? `; Daniels VDOT says ${fmtDur(v.band.alt)}` : ''}).</p>` : ''}
    ${v.h2h ? h2hBlock(v.h2h, f) : ''}
    ${f.logistics ? `<p class="tiny" style="color:var(--gold);margin-top:.4rem">Paperwork: ${esc(f.logistics)}</p>` : ''}
    <div id="plan-${cssId(featId)}" class="tiny dim" style="margin-top:.7rem">plan…</div>
    ${attempts.length ? `<p class="tiny dim" style="margin-top:.6rem">Logged: ${attempts.map(a => `${esc(a.date)}${a.verified ? ' ✓' : ''}`).join(', ')}</p>` : ''}
    <div class="controls" style="margin-top:.9rem">
      <button class="btn ${queued ? '' : 'primary'}" data-action="queue-add" data-feat="${featId}" ${queued ? 'disabled' : ''}>${queued ? 'In queue' : 'Add to queue'}</button>
      <input type="date" id="gd-${cssId(featId)}" value="${goal?.target_date || ''}">
      <button class="btn" data-action="goal-add" data-feat="${featId}">${goal ? 'Update goal' : 'Set as goal'}</button>
      <button class="btn ghost" data-action="attempt-form" data-feat="${featId}">Log attempt</button>
      <button class="btn ghost" data-action="pin-rival" data-feat="${featId}">${S.athlete?.settings?.rival === featId ? 'Unpin rival' : 'Pin as rival'}</button>
    </div>
    <div id="att-${cssId(featId)}"></div>`;
  try {
    const plan = await api(`/api/plan/${encodeURIComponent(featId)}`, { method: 'GET' });
    const t = plan.targets || {};
    $(`#plan-${cssId(featId)}`).innerHTML = `
      ${Object.keys(t).length ? `<div class="kv">${Object.entries(t).filter(([k]) => !(t[k + '_str'] !== undefined)).slice(0, 6)
        .map(([k, val]) => `<div><div class="k">${esc(k.replace(/_/g, ' '))}</div><div class="v">${esc(typeof val === 'number' ? (k.includes('pace') ? fmtPace(val) : Math.round(val * 10) / 10) : val)}</div></div>`).join('')}</div>` : ''}
      <ul class="plan-steps">${plan.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
  } catch { $(`#plan-${cssId(featId)}`).textContent = ''; }
}

// ---------------------------------------------------------------- queue
function queueView() {
  const items = S.queue.map(q => ({ q, f: S.feats.find(x => x.id === q.feat_id), v: S.verdicts[q.feat_id] })).filter(x => x.f);
  $('#view-queue').innerHTML = `
    <h2>The Queue</h2>
    <p class="dek">Ordered list of what you are actually going after. Order is yours; the readiness call is the engine's.</p>
    ${items.length ? items.map(({ q, f, v }, i) => `
      <div class="qitem">
        <div class="pos">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <div><b>${esc(f.who)}</b> — ${esc(f.title)} <span class="mono tiny dim">${esc(f.display || '')}</span></div>
          <div class="tiny faint">${esc(v.headline)}</div>
          <div class="controls" style="margin-top:.5rem">
            <select data-action="q-status" data-id="${q.id}">
              ${['queued', 'training', 'scheduled', 'attempted', 'crushed', 'abandoned'].map(s => `<option ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <input type="date" data-action="q-date" data-id="${q.id}" value="${q.target_date || ''}">
            ${chip(v.status)}
            ${v.eta_weeks ? `<span class="tiny faint mono">${v.eta_weeks} weeks at current trend</span>` : ''}
          </div>
        </div>
        <div class="qactions">
          <button class="btn ghost" data-action="q-move" data-id="${q.id}" data-dir="up">↑</button>
          <button class="btn ghost" data-action="q-move" data-id="${q.id}" data-dir="down">↓</button>
          <button class="btn" data-action="goal-from-queue" data-feat="${f.id}" data-date="${q.target_date || ''}">Make goal</button>
          <button class="btn ghost" data-action="q-remove" data-id="${q.id}">✕</button>
        </div>
      </div>`).join('')
      : '<p class="dim">Empty. Open the ledger and add something you can nearly do — the closest unbeaten feats are on the dashboard.</p>'}

    <h2>Suggested next</h2>
    <p class="dek">In range and unclaimed first, then the nearest misses. Anything already queued is left out.</p>
    ${[...bagNow(), ...nearMiss()].filter(x => !S.queue.some(q => q.feat_id === x.f.id)).slice(0, 8).map(({ f, v }) => `
      <div class="qitem"><div class="pos faint">+</div>
        <div><b>${esc(f.who)}</b> — ${esc(f.title)} <span class="mono tiny dim">${esc(f.display || '')}</span>
        <div class="tiny faint">${esc(v.headline)}</div></div>
        <div class="qactions"><button class="btn primary" data-action="queue-add" data-feat="${f.id}">Queue</button></div>
      </div>`).join('')}`;
}

// ---------------------------------------------------------------- goals
async function goalsView() {
  const box = $('#view-goals');
  box.innerHTML = `<h2>Goals</h2>
    <p class="dek">A goal is a feat plus a date. The plan below is derived from your current numbers and the gap to the target, not from a template.</p>
    ${S.goals.length ? '<div id="goal-list">loading…</div>' : '<p class="dim">No goals yet. Set one from any ledger row.</p>'}`;
  if (!S.goals.length) return;
  const plans = await Promise.all(S.goals.map(g => api(`/api/goals/${g.id}/plan`, { method: 'GET' }).catch(() => null)));
  $('#goal-list').innerHTML = S.goals.map((g, i) => {
    const f = S.feats.find(x => x.id === g.feat_id), p = plans[i], v = S.verdicts[g.feat_id];
    if (!f) return '';
    const t = p?.targets || {};
    const weeks = p?.weeks_remaining, need = p?.weeks_needed;
    const ready = need != null && weeks != null ? weeks - need : null;
    return `<div class="goal">
      <div class="head">
        <h3>${esc(f.who)} — ${esc(f.title)} <span class="mono dim" style="font-size:.9rem">${esc(f.display || '')}</span></h3>
        <div>${chip(v.status)} <span class="tiny mono faint">${g.status}</span></div>
      </div>
      <p class="tiny dim">${esc(v.headline)}</p>
      <div class="kv">
        <div><div class="k">Target date</div><div class="v"><input type="date" data-action="goal-date" data-id="${g.id}" value="${g.target_date || ''}"></div></div>
        ${weeks != null ? `<div><div class="k">Weeks remaining</div><div class="v">${weeks}</div></div>` : ''}
        ${need != null ? `<div><div class="k">Weeks needed</div><div class="v">${need}</div></div>` : ''}
        ${ready != null ? `<div><div class="k">Margin</div><div class="v" style="color:${ready >= 0 ? 'var(--crushed)' : 'var(--close)'}">${ready >= 0 ? '+' : ''}${ready} wk</div></div>` : ''}
        ${t.race_pace_str ? `<div><div class="k">Race pace</div><div class="v">${t.race_pace_str}</div></div>` : ''}
        ${t.peak_weekly_km ? `<div><div class="k">Peak volume</div><div class="v">${t.peak_weekly_km} km/wk</div></div>` : ''}
        ${t.current_weekly_km != null ? `<div><div class="k">You now</div><div class="v">${t.current_weekly_km} km/wk</div></div>` : ''}
        ${t.projected_now_str ? `<div><div class="k">Projected now</div><div class="v">${t.projected_now_str}</div></div>` : ''}
      </div>
      ${t.peak_weekly_km ? volumeProgress(t.current_weekly_km, t.peak_weekly_km) : ''}
      <ul class="plan-steps">${(p?.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      ${p?.weeks?.length ? weekTable(p.weeks, g.id) : ''}
      <div class="controls" style="margin-top:.7rem">
        <button class="btn ghost" data-action="goal-delete" data-id="${g.id}">Drop goal</button>
        <button class="btn" data-action="attempt-form" data-feat="${f.id}">Log attempt</button>
      </div>
      <div id="att-${cssId(f.id)}"></div>
    </div>`;
  }).join('');
}
function weekTable(weeks, goalId) {
  window.__plans = window.__plans || {};
  window.__plans[goalId] = weeks;
  return `<details style="margin-top:.8rem">
    <summary class="eyebrow" style="cursor:pointer">The ${weeks.length}-week build · ${Math.round(weeks.reduce((a, w) => a + w.km, 0)).toLocaleString()} km total</summary>
    <table class="tiny" style="margin-top:.6rem"><thead><tr><th>Wk</th><th>From</th><th>Phase</th><th class="num">Volume</th><th class="num">Long</th><th>Sessions</th></tr></thead>
      <tbody>${weeks.map(w => `<tr>
        <td class="mono">${w.week}</td><td class="mono faint">${w.start}</td>
        <td class="tiny" style="color:${w.phase === 'peak' ? 'var(--ember)' : w.phase === 'recovery' ? 'var(--bone-faint)' : 'var(--bone-dim)'}">${w.phase}</td>
        <td class="num mono">${w.km} km</td><td class="num mono faint">${w.long_km} km</td>
        <td class="tiny dim">${w.sessions.map(esc).join(' · ')}</td></tr>`).join('')}</tbody></table>
    <button class="btn ghost" style="margin-top:.6rem" data-action="plan-ics" data-id="${goalId}">Export plan to calendar (.ics)</button>
  </details>`;
}

const volumeProgress = (now, target) => `<div class="bar-row"><span class="bar ${now >= target ? 'done' : ''}"><i style="width:${Math.min(100, now / target * 100).toFixed(0)}%"></i></span>
  <span class="tiny mono faint">${now} / ${target} km per week</span></div>`;

// ---------------------------------------------------------------- analytics
function analytics() {
  const c = counts();
  const byCat = {};
  for (const f of S.feats) { (byCat[f.category] ||= { total: 0 }); byCat[f.category].total++; const s = S.verdicts[f.id].status; byCat[f.category][s] = (byCat[f.category][s] || 0) + 1; }
  const windows = S.profile.windows;
  $('#view-analytics').innerHTML = `
    <h2>Analytics</h2>
    <p class="dek">Your performance curve against the ledger. Anything plotted below the line is already inside your range; anything above it is the work.</p>

    <div class="card"><p class="eyebrow">Pace curve vs every timed feat</p>
      <div class="chart" id="ch-curve"></div>
      <div class="legend">
        <span><i style="background:${COLORS.ember}"></i>Your predicted curve</span>
        <span><i style="background:${COLORS.gold}"></i>Measured personal bests</span>
        <span><i style="background:${COLORS.green}"></i>Feat you have beaten</span>
        <span><i style="background:${COLORS.bone}"></i>Feat still standing</span>
      </div>
    </div>

    <div class="grid split" style="margin-top:1rem">
      <div class="card"><p class="eyebrow">Verdict spread</p>${statusBars(c, S.feat_stats.total)}</div>
      <div class="card"><p class="eyebrow">Rolling window capacity</p>
        <table class="tiny"><thead><tr><th>Window</th><th class="num">Best run block</th><th class="num">Best all-sport</th><th>Nearest feat</th></tr></thead>
        <tbody>${windows.map(w => {
          const feat = S.feats.filter(f => f.check.kind === 'distance_window' && Math.abs(f.check.days - w.days) <= Math.max(2, w.days * 0.2))
            .sort((a, b) => a.check.meters - b.check.meters)[0];
          return `<tr><td class="mono">${w.days} d</td><td class="num mono">${fmtKm(w.run)}</td><td class="num mono">${fmtKm(w.all)}</td>
            <td class="tiny">${feat ? `${esc(feat.who)} <span class="faint">${fmtKm(feat.check.meters)}</span>` : '<span class="faint">—</span>'}</td></tr>`;
        }).join('')}</tbody></table>
      </div>
    </div>

    <div class="grid split" style="margin-top:1rem">
      <div class="card"><p class="eyebrow">Volume by sport, last 52 weeks</p><div class="chart" id="ch-sports"></div>
        <div class="legend"><span><i style="background:${COLORS.ember}"></i>Run</span><span><i style="background:${COLORS.steel}"></i>Ride</span><span><i style="background:${COLORS.violet}"></i>Swim</span></div></div>
      <div class="card"><p class="eyebrow">Personal bests and predictions</p>
        <table class="tiny"><thead><tr><th>Distance</th><th class="num">Best</th><th class="num">Pace</th><th class="num">Predicted</th><th>Source</th></tr></thead>
        <tbody>${S.profile.pbs.filter(p => p.seconds || p.predicted).map(p => `<tr>
          <td class="mono">${fmtKm(p.distance_m)}</td>
          <td class="num mono">${p.seconds ? fmtDur(p.seconds) : '—'}</td>
          <td class="num mono faint">${p.seconds ? fmtPace(p.seconds / (p.distance_m / 1000)) : '—'}</td>
          <td class="num mono">${p.predicted ? fmtDur(p.predicted) : '—'}</td>
          <td class="tiny faint">${p.measured ? 'measured' : p.seconds ? 'even-pace read' : 'extrapolated'}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>

    <h2>Milestones</h2>
    <p class="dek">The day each feat fell, replayed from your history. Eddington number — the largest E with E days of at least E — stands at
      <b class="mono">${S.profile.eddingtons.run_km}</b> running (km), <b class="mono">${S.profile.eddingtons.ride_km}</b> riding (km) and <b class="mono">${S.profile.eddingtons.ride_mi}</b> riding (miles).</p>
    <div class="card" id="milestones"><p class="dim tiny">replaying…</p></div>

    <h2>Crush forecast</h2>
    <p class="dek">Where the ledger goes if you keep improving at ${pct(S.profile.improveRate)} a year. Not a promise — an extrapolation of your own trend, and trends bend.</p>
    <div class="grid split">
      <div class="card"><p class="eyebrow">Feats within reach over the next three years</p><div class="chart" id="ch-forecast"></div></div>
      <div class="card"><p class="eyebrow">Next to fall</p>
        <table class="tiny"><thead><tr><th>Feat</th><th class="num">Weeks</th><th class="num">Projected</th></tr></thead>
        <tbody>${forecast().rows.slice(0, 12).map(r => `<tr class="row" data-action="goto-feat" data-feat="${r.f.id}">
          <td>${esc(r.f.who)} <span class="dim">${esc(r.f.title)}</span></td>
          <td class="num mono">${r.weeks}</td>
          <td class="num mono faint">${r.date.toISOString().slice(0, 7)}</td></tr>`).join('') || '<tr><td class="dim">nothing inside three years</td></tr>'}
        </tbody></table>
      </div>
    </div>

    <h2>By category</h2>
    <table><thead><tr><th>Category</th><th class="num">Feats</th><th>Spread</th><th class="num">Crushed</th></tr></thead>
    <tbody>${Object.entries(byCat).sort((a, b) => b[1].total - a[1].total).map(([cat, v]) => `<tr>
      <td>${esc(cat)}</td><td class="num mono">${v.total}</td>
      <td>${statusBars(v, v.total, true)}</td>
      <td class="num mono">${v.crushed || 0}</td></tr>`).join('')}</tbody></table>`;

  drawCurve(); drawSports(); drawForecast(); drawMilestones();
}

async function drawMilestones() {
  const ms = await api('/api/milestones', { method: 'GET' }).catch(() => []);
  const box = $('#milestones');
  if (!box) return;                                   // tab changed while it was replaying
  let year = '';
  box.innerHTML = ms.length ? `<table class="tiny"><tbody>${ms.map(m => {
    const f = S.feats.find(x => x.id === m.feat_id), y = m.date.slice(0, 4), head = y !== year ? `<tr><td colspan="3" class="eyebrow" style="padding-top:.8rem">${year = y}</td></tr>` : '';
    return f ? `${head}<tr class="row" data-action="goto-feat" data-feat="${f.id}"><td class="mono faint">${m.date}</td>
      <td><b>${esc(f.who)}</b> <span class="dim">${esc(f.title)}</span> <span class="mono faint">${esc(f.display || '')}</span>${m.logged ? ' <span class="chip s-logbook">logged</span>' : ''}</td>
      <td class="dim">${esc(m.headline)}</td></tr>` : '';
  }).join('')}</tbody></table>` : '<p class="dim tiny">Nothing crushed yet.</p>';
}

function drawForecast() {
  const { points, nowCount } = forecast();
  lineChart($('#ch-forecast'), {
    series: [{ name: 'Reachable', color: COLORS.ember, points, area: true }],
    yFmt: v => Math.round(v), xFmt: m => `+${Math.round(m)}m`, yMin: Math.max(0, nowCount - 5),
  });
}

function statusBars(c, total, compact = false) {
  const order = ['crushed', 'in_reach', 'close', 'trainable', 'far', 'logbook', 'sacred'];
  return `<div style="display:flex;height:${compact ? 8 : 14}px;border:1px solid var(--hairline);margin:.4rem 0">
    ${order.map(s => c[s] ? `<span title="${STATUS_LABEL[s]}: ${c[s]}" style="width:${c[s] / total * 100}%;background:var(--${s === 'in_reach' ? 'reach' : s})"></span>` : '').join('')}
  </div>${compact ? '' : `<div class="legend">${order.filter(s => c[s]).map(s => `<span><i style="background:var(--${s === 'in_reach' ? 'reach' : s})"></i>${STATUS_LABEL[s]} ${c[s]}</span>`).join('')}</div>`}`;
}

function drawCurve() {
  const pbs = S.profile.pbs.filter(p => p.seconds).map(p => ({ d: p.distance_m, pace: p.seconds / (p.distance_m / 1000), label: `${fmtKm(p.distance_m)} ${fmtDur(p.seconds)}` }));
  const curve = S.profile.pbs.filter(p => p.predicted).map(p => ({ d: p.distance_m, pace: p.predicted / (p.distance_m / 1000) }));
  const feats = S.feats.filter(f => f.check.kind === 'run_time').map(f => ({
    d: f.check.distance_m, pace: f.check.seconds / (f.check.distance_m / 1000), who: f.who, label: f.display || f.title,
    beaten: S.verdicts[f.id].status === 'crushed', reference: !!f.reference,
  }));
  paceCurve($('#ch-curve'), { curve, pbs, feats });
}
function drawSports() {
  const mk = sport => weeklySeries(sport).map((x, i) => [i, x.y]);
  lineChart($('#ch-sports'), {
    series: [
      { name: 'Run', color: COLORS.ember, points: mk('run') },
      { name: 'Ride', color: COLORS.steel, points: mk('ride') },
      { name: 'Swim', color: COLORS.violet, points: mk('swim') },
    ].filter(s => s.points.some(p => p[1] > 0)),
    yFmt: v => `${Math.round(v)}k`, xFmt: i => `w${Math.round(i)}`,
  });
}

// ---------------------------------------------------------------- connect
function connect() {
  const p = S.providers, a = S.athlete || {}, sc = syncCfg();
  setTimeout(paintSyncState, 0);
  $('#view-connect').innerHTML = `
    <h2>Connect</h2>
    <p class="dek">Strava is the main door. Garmin has two: the partner API if you have keys, and plain file import if you do not. If your watch already syncs to Strava, one connection covers both — duplicates are dropped on the way in.</p>
    ${S.static ? `<p class="notice">Running as a standalone app: everything below the imports happens in this browser, and your data never leaves it. Live OAuth sync is the one thing a page without a server cannot do — both exchanges need a client secret — so bring your history in as a file. Run <code>node server.mjs</code> from the repo for one-click Strava sync.</p>` : ''}

    <div class="grid cards">
      <div class="card">
        <p class="eyebrow">Strava</p>
        <p class="tiny dim" style="margin:.5rem 0">${p.strava.connected ? 'Connected. Sync pulls new activities and the measured best efforts Strava computes for runs.' : p.strava.configured ? 'Keys present. Authorise to pull your activity history.' : S.static ? 'Strava → Settings → My Account → Download or Delete Your Account → Request Archive. Import the activities.csv below.' : 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, then restart.'}</p>
        ${p.strava.connected
          ? `<button class="btn primary" data-action="sync" data-provider="strava">Sync now</button>
             <button class="btn" data-action="sync-full" data-provider="strava">Full re-pull</button>`
          : p.strava.configured
            ? `<a class="btn primary" href="/connect/strava" style="text-decoration:none;display:inline-block">Authorise Strava</a>`
            : `<button class="btn" disabled>${S.static ? 'File import below' : 'Needs keys'}</button>`}
      </div>

      <div class="card">
        <p class="eyebrow">Garmin — partner API</p>
        <p class="tiny dim" style="margin:.5rem 0">${p.garmin.connected ? 'Connected via the Garmin Connect Developer Program.' : p.garmin.configured ? 'Keys present. Authorise to pull activities.' : S.static ? 'The partner API needs a server to hold the secret. File import below needs nothing at all.' : 'Requires an approved Garmin developer account. Without one, use file import below — it needs nothing.'}</p>
        ${p.garmin.connected
          ? `<button class="btn primary" data-action="sync" data-provider="garmin">Sync now</button>`
          : p.garmin.configured
            ? `<a class="btn primary" href="/connect/garmin" style="text-decoration:none;display:inline-block">Authorise Garmin</a>`
            : `<button class="btn" disabled>${S.static ? 'File import below' : 'Needs partner keys'}</button>`}
      </div>

      <div class="card">
        <p class="eyebrow">File import — Garmin or Strava</p>
        <p class="tiny dim" style="margin:.5rem 0">Garmin Connect → Activities → Export CSV, a Strava archive's activities.csv, or any single .gpx. No registration, works today, offline.</p>
        <div class="controls">
          <input type="file" id="gfile" accept=".csv,.gpx" class="tiny">
          <select id="gunits"><option value="metric">km</option><option value="imperial">miles</option></select>
          <button class="btn primary" data-action="import">Import</button>
        </div>
      </div>

      <div class="card">
        <p class="eyebrow">Garmin — watched folder</p>
        <p class="tiny dim" style="margin:.5rem 0">Run <code>tools/garmin-sync.py</code> on a schedule and point this at the folder it writes to. Every load re-imports the newest file, merging — no clicking, no export dance.</p>
        <p class="tiny mono" id="garmin-folder">…</p>
        <div class="controls">
          <button class="btn primary" data-action="garmin-pick">Pick folder</button>
          <button class="btn" data-action="garmin-load">Load now</button>
          <button class="btn ghost" data-action="garmin-forget">Forget</button>
        </div>
      </div>

      <div class="card">
        <p class="eyebrow">Demo athlete</p>
        <p class="tiny dim" style="margin:.5rem 0">18 months of a plausible 3:2x marathon build, so every dashboard has something in it before you connect anything real.</p>
        <button class="btn" data-action="demo">Seed demo data</button>
        <button class="btn ghost" data-action="demo-clear">Clear demo</button>
      </div>
    </div>

    <h2>You</h2>
    <div class="controls">
      <label class="field">Name<input type="text" id="a-name" value="${esc(a.name || '')}"></label>
      <label class="field">Birth year<input type="number" id="a-year" value="${a.birth_year || ''}" min="1900" max="2020"></label>
      <label class="field">Weight (kg)<input type="number" id="a-weight" value="${a.weight_kg || ''}" step="0.5"></label>
      <label class="field">Age-grade table<select id="a-sex">${[['', 'not set (men\'s)'], ['M', 'men\'s'], ['F', 'women\'s']].map(([v, l]) => `<option value="${v}" ${(a.sex || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn primary" data-action="save-athlete">Save</button>
      <app-font-picker label="Reading font"></app-font-picker>
    </div>
    <p class="tiny faint">Birth year lets the ledger tell you how old each celebrity was when they did it, next to how old you are now. Age adjustment uses the USATF Masters 2025 road tables.</p>

    <h2>Cloud sync</h2>
    <p class="dek">Your queue, goals, logged attempts and imported activities, carried between devices. The file goes straight from this browser to your storage — nothing passes through a server of ours. Provider data is left out; it re-syncs.</p>
    <div class="controls">
      <label class="field">Target<select data-action="sync-provider">${Sync.SYNC_PROVIDERS.map(p =>
        `<option value="${p.id}" ${sc.provider === p.id ? 'selected' : ''} ${p.supported() ? '' : 'disabled'}>${esc(p.label)}${p.supported() ? '' : ' — not in this browser'}</option>`).join('')}</select></label>
      <button class="btn primary" data-action="sync-now">Sync now</button>
      <button class="btn" data-action="sync-restore">Pull only</button>
      <button class="btn ghost" data-action="sync-disconnect">Disconnect</button>
      <label class="tiny dim"><input type="checkbox" data-action="sync-auto" ${sc.auto ? 'checked' : ''}> keep synced automatically</label>
    </div>
    <p class="tiny mono" id="sync-state">…</p>
    ${sc.provider === 'googleDrive' && !Sync.driveOriginAllowed() && !sc.driveClientId ? `<p class="tiny" style="color:var(--gold)">This deployment is not one of the origins registered with the built-in Google client, so Drive needs your own OAuth client ID (Google Cloud console → Credentials → OAuth client → Web application, with this page's origin as an authorised JavaScript origin).</p>` : ''}
    ${sc.provider === 'googleDrive' ? `<div class="controls"><label class="field">Your own OAuth client ID (optional)<input type="text" data-action="sync-clientid" value="${esc(sc.driveClientId)}" placeholder="…apps.googleusercontent.com"></label></div>` : ''}
    <p class="tiny faint">Merging is add-only: a goal or attempt deleted on one device comes back from the other. Delete it on both, or restore from a backup file.</p>

    <h2>Backup</h2>
    <p class="dek">Everything you typed — queue, goals, logged attempts, imported activities — as one JSON file. Provider data is not included; it re-syncs.</p>
    ${S.static ? `<p class="tiny" style="color:var(--gold)">Worth doing here: a standalone install keeps everything in this browser's storage, which clearing site data wipes.</p>` : ''}
    <div class="controls">
      <button class="btn" data-action="backup">Download backup</button>
      <input type="file" id="rfile" accept=".json" class="tiny">
      <button class="btn" data-action="restore">Restore</button>
    </div>

    <h2>Sync log</h2>
    <table class="tiny"><thead><tr><th>When</th><th>Provider</th><th>Status</th><th class="num">Added</th><th>Message</th></tr></thead>
      <tbody>${S.sync_log.map(l => `<tr>
        <td class="mono">${new Date(l.started_ts * 1000).toLocaleString()}</td>
        <td class="mono">${esc(l.provider)}</td>
        <td class="mono" style="color:${l.status === 'ok' ? 'var(--crushed)' : l.status === 'error' ? 'var(--close)' : 'var(--bone-dim)'}">${esc(l.status)}</td>
        <td class="num mono">${l.added ?? 0}</td><td class="dim">${esc(l.message || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">nothing yet</td></tr>'}
      </tbody></table>

    <h2>Recent activities</h2>
    <table class="tiny"><thead><tr><th>Date</th><th>Sport</th><th>Name</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Elev</th></tr></thead>
      <tbody>${S.activities.slice(0, 25).map(x => `<tr>
        <td class="mono">${new Date(x.start_ts * 1000).toISOString().slice(0, 10)}</td>
        <td class="mono">${esc(x.sport)}</td><td class="dim">${esc(x.name || '')}</td>
        <td class="num mono">${fmtKm(x.distance_m)}</td><td class="num mono">${fmtDur(x.moving_s)}</td>
        <td class="num mono faint">${Math.round(x.elev_m)} m</td></tr>`).join('') || '<tr><td colspan="6" class="dim">no activities</td></tr>'}
      </tbody></table>`;
}

/** The two lines that need an await: which folder is watched, and who is signed in. */
async function paintSyncState() {
  const cfg = syncCfg(), f = $('#garmin-folder'), st = $('#sync-state');
  if (f) f.textContent = Sync.garminFolderSupported()
    ? ((await Sync.garminFolderName()) ? `Watching: ${await Sync.garminFolderName()}` : 'No folder picked yet.')
    : 'This browser has no directory picker — use the file import above.';
  if (!st) return;
  const p = Sync.getSyncProvider(cfg.provider);
  const when = cfg.lastSync ? `last synced ${new Date(cfg.lastSync).toLocaleString()}${cfg.lastNote ? ` (${cfg.lastNote})` : ''}` : 'never synced';
  const who = p && (await p.accountLabel?.());
  // Signed in to Google: their profile picture sits beside the account name. No picture, no element.
  const pic = who && p.accountPicture?.();
  const img = pic ? Object.assign(document.createElement('img'), { src: pic, alt: '', referrerPolicy: 'no-referrer', className: 'avatar' }) : '';
  st.replaceChildren(`${p ? p.label : 'No target'} · `, img, `${who || 'not connected'} · ${when}`);
}

// ---------------------------------------------------------------- actions
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const { action, feat, id, provider, dir, date } = t.dataset;
  try {
    switch (action) {
      case 'tab': ui.tab = t.dataset.tab; render(); window.scrollTo(0, 0); break;
      case 'toggle': {
        ui.open.has(feat) ? ui.open.delete(feat) : ui.open.add(feat);
        ledger(); break;
      }
      case 'goto-feat': ui.tab = 'ledger'; ui.open.add(feat); ui.filters.q = ''; render(); break;
      case 'queue-add': await api('/api/queue', { body: { feat_id: feat } }); toast('Queued'); await load(); break;
      case 'q-remove': await api(`/api/queue/${id}`, { method: 'DELETE' }); await load(); break;
      case 'q-move': await api(`/api/queue/${id}`, { method: 'PATCH', body: { move: dir } }); await load(); break;
      case 'goal-add': {
        const d = $(`#gd-${cssId(feat)}`)?.value || null;
        const existing = S.goals.find(g => g.feat_id === feat);
        if (existing) await api(`/api/goals/${existing.id}`, { method: 'PATCH', body: { target_date: d } });
        else await api('/api/goals', { body: { feat_id: feat, target_date: d } });
        toast('Goal set'); await load(); break;
      }
      case 'goal-from-queue': await api('/api/goals', { body: { feat_id: feat, target_date: date || null } }); toast('Goal set'); await load(); break;
      case 'goal-delete': await api(`/api/goals/${id}`, { method: 'DELETE' }); await load(); break;
      case 'attempt-form': attemptForm(feat); break;
      case 'attempt-save': {
        const box = $(`#att-${cssId(feat)}`);
        const raw = box.querySelector('.a-time')?.value.trim(), parts = raw ? raw.split(':').map(Number) : [];
        if (raw && (parts.length < 2 || parts.length > 3 || parts.some(x => !(x >= 0)))) throw new Error('Finish time should look like 3:29:59 or 24:30');
        const secs = parts.reduce((t, x) => t * 60 + x, 0);
        await api('/api/attempts', { body: {
          ...(secs ? { metric: 'time', value: secs, unit: 's' } : {}),
          feat_id: feat, date: box.querySelector('.a-date').value, notes: box.querySelector('.a-notes').value,
          evidence: box.querySelector('.a-evidence').value, verified: box.querySelector('.a-verified').checked ? 1 : 0,
        } });
        toast('Logged'); await load(); break;
      }
      case 'sync': case 'sync-full':
        toast(`Syncing ${provider}…`, 8000);
        { const r = await api(`/api/sync/${provider}`, { body: { full: action === 'sync-full' } }); toast(`${provider}: ${r.added} new of ${r.fetched}`); }
        await load(); break;
      case 'sync-all': {
        const ps = Object.entries(S.providers).filter(([, v]) => v.connected).map(([k]) => k);
        if (!ps.length) { toast('Nothing connected — see the Connect tab'); ui.tab = 'connect'; render(); break; }
        toast('Syncing…', 8000);
        for (const p of ps) await api(`/api/sync/${p}`, { body: {} });
        toast('Synced'); await load(); break;
      }
      case 'import': {
        const file = $('#gfile').files[0];
        if (!file) { toast('Choose a .csv or .gpx first'); break; }
        const text = await file.text();
        const r = await api('/api/import/garmin', { body: { format: file.name.toLowerCase().endsWith('.gpx') ? 'gpx' : 'csv', text, units: $('#gunits').value, name: file.name } });
        toast(`Imported ${r.added} new of ${r.parsed}`); await load(); break;
      }
      case 'export-csv': {
        const head = ['who', 'title', 'event', 'year', 'age', 'category', 'discipline', 'numbers', 'verdict', 'gap_pct', 'eta_weeks', 'detail'];
        const cell = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
        const lines = [head.join(',')].concat(filtered().map(f => {
          const v = S.verdicts[f.id];
          return [f.who, f.title, f.event, f.year, f.age, f.category, f.discipline, f.display,
            STATUS_LABEL[v.status], v.gap != null ? Math.round(v.gap * 100) : '', v.eta_weeks ?? '', v.headline].map(cell).join(',');
        }));
        download('celebrity-crusher-ledger.csv', 'text/csv', lines.join('\n'));
        toast(`Exported ${filtered().length} rows`); break;
      }
      case 'share-card': shareCard(); break;
      case 'pin-rival': {
        const cur = S.athlete?.settings?.rival;
        await api('/api/athlete', { body: { rival: cur === feat ? null : feat } });
        toast(cur === feat ? 'Rival unpinned' : 'Rival pinned to the dashboard'); await load(); break;
      }
      case 'plan-ics': {
        const weeks = (window.__plans || {})[id];
        if (!weeks?.length) { toast('No plan to export'); break; }
        download(`training-plan-${id}.ics`, 'text/calendar', toIcs(weeks));
        toast(`${weeks.length} weeks exported`); break;
      }
      case 'backup': {
        const data = await api('/api/backup', { method: 'GET' });
        download(`celebrity-crusher-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(data, null, 1));
        toast('Backup downloaded'); break;
      }
      case 'restore': {
        const file = $('#rfile').files[0];
        if (!file) { toast('Choose a backup file first'); break; }
        const r = await api('/api/restore', { body: JSON.parse(await file.text()) });
        toast(`Restored ${r.restored} records`); await load(); break;
      }
      case 'sync-now': {
        const cfg = syncCfg();
        toast('Syncing…', 8000);
        const r = await Sync.syncNow(cfg.provider, cfg, api);
        setSyncCfg({ lastSync: r.at, lastNote: 'manual' });
        toast(`Synced · pulled ${r.restored} record${r.restored === 1 ? '' : 's'}, pushed ${Math.max(1, Math.round(r.bytes / 1024))} KB`);
        await load(); break;
      }
      case 'sync-restore': {
        const cfg = syncCfg();
        const r = await Sync.restoreFrom(cfg.provider, cfg, api);
        toast(r.empty ? 'Nothing stored there yet — sync once to put it there' : `Pulled ${r.restored} record${r.restored === 1 ? '' : 's'}`);
        await load(); break;
      }
      case 'sync-disconnect': {
        const cfg = syncCfg();
        await Sync.getSyncProvider(cfg.provider)?.disconnect();
        setSyncCfg({ lastSync: 0, lastNote: '' });
        toast('Disconnected'); connect(); break;
      }
      case 'garmin-pick': {
        const name = await Sync.pickGarminFolder();
        const r = await Sync.garminAutoLoad(api, { interactive: true });
        toast(r.skipped ? `Watching ${name} — no Garmin file in it yet` : `Watching ${name} · ${r.added} new of ${r.parsed}`);
        await load(); break;
      }
      case 'garmin-load': {
        const r = await Sync.garminAutoLoad(api, { interactive: true });
        toast(r.skipped === 'no-folder' ? 'Pick a folder first'
          : r.skipped === 'no-file' ? 'No Garmin file in that folder'
          : r.skipped ? 'Folder permission was refused' : `${r.added} new of ${r.parsed} from ${r.file}`);
        await load(); break;
      }
      case 'garmin-forget': await Sync.forgetGarminFolder(); toast('Folder forgotten'); connect(); break;
      case 'demo': await api('/api/demo', { body: {} }); toast('Demo athlete seeded'); await load(); break;
      case 'demo-clear': await api('/api/demo', { body: { clear: true } }); toast('Demo data cleared'); await load(); break;
      case 'save-athlete':
        await api('/api/athlete', { body: { name: $('#a-name').value || null, birth_year: +$('#a-year').value || null, weight_kg: +$('#a-weight').value || null, sex: $('#a-sex').value || null } });
        toast('Saved'); await load(); break;
    }
  } catch (err) { toast(`Error: ${err.message}`, 6000); }
});

document.addEventListener('change', async e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const { action, id } = t.dataset;
  try {
    if (action === 'q-status') { await api(`/api/queue/${id}`, { method: 'PATCH', body: { status: t.value } }); await load(); }
    if (action === 'q-date') { await api(`/api/queue/${id}`, { method: 'PATCH', body: { target_date: t.value } }); await load(); }
    if (action === 'goal-date') { await api(`/api/goals/${id}`, { method: 'PATCH', body: { target_date: t.value } }); await load(); }
    if (action === 'sync-provider') { setSyncCfg({ provider: t.value }); connect(); }
    if (action === 'sync-clientid') { setSyncCfg({ driveClientId: t.value.trim() }); toast('Client ID saved'); }
    if (action === 'sync-auto') {
      setSyncCfg({ auto: t.checked });
      toast(t.checked ? 'Auto-sync on — it pushes a few seconds after each change' : 'Auto-sync off');
      if (t.checked) await bootSync();
    }
  } catch (err) { toast(`Error: ${err.message}`, 6000); }
});

/** One all-day event per training week. Folded at 74 octets because some clients still care. */
function toIcs(weeks) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fold = line => line.match(/.{1,73}/g).join('\r\n ');
  const esc2 = t => String(t).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const body = weeks.map(w => {
    const d = w.start.replace(/-/g, '');
    const end = new Date(new Date(w.start).getTime() + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    return ['BEGIN:VEVENT', `UID:cc-w${w.week}-${d}@celebrity-crusher`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
      fold(`SUMMARY:Week ${w.week} · ${esc2(w.phase)} · ${w.km} km`),
      fold(`DESCRIPTION:Long run ${w.long_km} km. ${esc2(w.sessions.join('. '))}`),
      'END:VEVENT'].join('\r\n');
  }).join('\r\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Celebrity Crusher//Training Plan//EN',
    'CALSCALE:GREGORIAN', body, 'END:VCALENDAR'].join('\r\n');
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function attemptForm(featId) {
  const box = $(`#att-${cssId(featId)}`);
  if (!box) return;
  box.innerHTML = `<div class="card" style="margin-top:.6rem">
    <p class="eyebrow">Log an attempt</p>
    <div class="controls" style="margin-top:.5rem">
      <label class="field">Date<input type="date" class="a-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field">Evidence URL<input type="text" class="a-evidence" placeholder="race result, Strava link, video"></label>
      ${S.feats.find(x => x.id === featId)?.check.kind === 'run_time' ? '<label class="field">Finish time<input type="text" class="a-time" placeholder="h:mm:ss" size="8"></label>' : ''}
      <label class="field">Notes<input type="text" class="a-notes" placeholder="what actually happened"></label>
      <label class="tiny dim"><input type="checkbox" class="a-verified" checked> counts as proof</label>
      <button class="btn primary" data-action="attempt-save" data-feat="${featId}">Save</button>
    </div>
    <p class="tiny faint">A verified attempt marks the feat crushed regardless of what the projection says — the logbook outranks the model. A finish time also calibrates every future projection against what you actually ran.</p>
  </div>`;
}

/** Silent catch-up on load: the watched Garmin folder first, then the cloud. Never prompts. */
async function bootSync() {
  let changed = false;
  try { const r = await Sync.garminAutoLoad(api); if (r.added) changed = true; } catch { /* folder gone */ }
  const cfg = syncCfg();
  if (cfg.auto) {
    try {
      const r = await Sync.syncNow(cfg.provider, cfg, api, { silent: true });
      setSyncCfg({ lastSync: r.at, lastNote: 'on load' });
      if (r.restored) changed = true;
    } catch { /* no grant yet, or offline — Sync now in the Connect tab fixes it */ }
  }
  if (changed) await load();
  if (ui.tab === 'connect') paintSyncState();
}

window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== ui.tab && TABS.some(([id]) => id === t)) { ui.tab = t; render(); } });
load().then(bootSync).catch(e => { document.querySelector('main').innerHTML = `<p class="notice">Could not load state: ${esc(e.message)}</p>`; });
