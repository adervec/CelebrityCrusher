import { lineChart, barChart, paceCurve, COLORS } from './charts.js';
import * as Sync from './sync.js';
import { localYmd, dayStr } from '../lib/engine.js';
import { eraseLocalData, eraseCoworkFolder } from './device.js';
import { APP_ID, MANIFEST, REPLY_KEY, INSTRUCTIONS, coachRequest, coachBrief, replyText } from './coach.js';
import { t, num, percent, dist, height, pace, date, monthYear, distUnit, inUnit } from '../lib/i18n.js';

// ---------------------------------------------------------------- plumbing
let S = null;                       // last /api/state payload
const ui = { tab: location.hash.slice(1).split('?')[0] || 'dashboard', open: new Set(), filters: { q: '', cat: '', disc: '', status: '', tier: '', refs: true, computable: false, sort: 'gap' } };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Catalogue text (feat names, titles, notes) is English: isolate it, so a right-to-left page keeps its word order.
const cat = s => `<bdi lang="en" dir="ltr">${esc(s)}</bdi>`;
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
  if (method === 'GET' || /\/api\/(backup|restore|state|plan|erase)/.test(path)) return;
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

const toast = (msg, ms = 3200) => { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, ms); };

const fmtDur = v => { const sign = v < 0 ? '-' : ''; let s = Math.abs(Math.round(v)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return sign + (h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`); };
/** Kilometres (as the plans store them) in the reader's unit: "60 km" / "37.3 mi". Never "0 m". */
const kmText = km => t('{n} {unit}', { n: num(inUnit((km || 0) * 1000), 1), unit: distUnit() });
/** A stored YYYY-MM-DD day as the reader's date; anything unparseable is shown as stored. */
const ymdText = s => { const d = new Date(String(s) + 'T00:00:00'); return isNaN(d) ? String(s ?? '') : date(d); };
/** An engine day number as a chart axis month ("Mar 26"). */
const dayMonth = n => { const d = new Date(dayStr(n) + 'T00:00:00'); return isNaN(d) ? '' : monthYear(d); };
/** Weekly-volume axis ticks: "40k" in metric, "25 mi" in imperial. */
const axisDist = v => inUnit(1000) === 1 ? t('{n}k', { n: num(v, 0) }) : t('{n} mi', { n: num(v, 0) });
const signed = x => (x >= 0 ? '+' : '') + num(Math.round(x), 0);
const dateTime = d => window.appFont?.fmt?.dateTime ? window.appFont.fmt.dateTime(d) : d.toLocaleString();
const STATUSES = ['crushed', 'in_reach', 'close', 'trainable', 'far', 'logbook', 'sacred'];
const statusLabel = st => ({ crushed: t('Crushed'), in_reach: t('In reach'), close: t('Close'), trainable: t('Trainable'), far: t('Far'), logbook: t('Logbook'), sacred: t('Apart') })[st];
const chip = st => `<span class="chip s-${st}">${statusLabel(st) || st}</span>`;
const gapBar = v => v == null ? '' : `<span class="bar ${v >= 1 ? 'done' : ''}"><i style="width:${Math.min(100, Math.max(2, v * 100)).toFixed(0)}%"></i></span>`;
const QUEUE_STATUSES = ['queued', 'training', 'scheduled', 'attempted', 'crushed', 'abandoned'];
const queueLabel = s => ({ queued: t('queued'), training: t('training'), scheduled: t('scheduled'), attempted: t('attempted'), crushed: t('crushed'), abandoned: t('abandoned') })[s] || s;
const confidenceLabel = s => ({ verified: t('verified'), reported: t('reported'), 'self-reported': t('self-reported'), legend: t('legend') })[s] || s;
const goalLabel = s =>({ active: t('active'), done: t('done'), dropped: t('dropped') })[s] || s;
const logLabel = s => ({ ok: t('ok'), error: t('error'), running: t('running') })[s] || s;
const sportLabel = s => ({ run: t('run'), ride: t('ride'), swim: t('swim'), walk: t('walk'), ski: t('ski'), row: t('row'), other: t('other') })[s] || s;
/** A plan target: a reader's label for the engine's key, and the value in the reader's units. */
function targetRow(k, val) {
  const km = v => kmText(v), dur = v => fmtDur(v), as = v => v;
  const T = {
    race_pace_str: [t('Race pace'), as], threshold_pace_str: [t('Threshold pace'), as], easy_pace_str: [t('Easy pace'), as],
    target_str: [t('Target'), as], projected_now_str: [t('Projected now'), as],
    current_weekly_km: [t('You now, per week'), km], peak_weekly_km: [t('Peak per week'), km], long_run_km: [t('Long run'), km],
    per_day_km: [t('Per day'), km], weekly_km_needed: [t('Needed per week'), km],
    swim: [t('Swim'), dur], bike: [t('Bike'), dur], run: [t('Run'), dur], transition: [t('Transitions'), dur],
  }[k];
  if (!T) return '';
  return `<div><div class="k">${esc(T[0])}</div><div class="v">${esc(T[1](val))}</div></div>`;
}
const phaseLabel = p =>({ 'race week': t('race week'), taper: t('taper'), recovery: t('recovery'), base: t('base'), build: t('build'), peak: t('peak') })[p] || p;

const tabs = () => [['dashboard', t('Dashboard')], ['ledger', t('The Ledger')], ['queue', t('Queue')], ['goals', t('Goals')], ['analytics', t('Analytics')], ['connect', t('Connect')]];

// ---------------------------------------------------------------- boot
async function load() {
  S = await api('/api/state');
  render();
}
function render() {
  const TABS = tabs();
  $('#nav').innerHTML = TABS.map(([id, label]) =>
    `<button data-action="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}">${label}${id === 'queue' && S.queue.length ? ` <span class="count">${num(S.queue.length, 0)}</span>` : ''}${id === 'goals' && S.goals.length ? ` <span class="count">${num(S.goals.length, 0)}</span>` : ''}</button>`).join('');
  for (const [id] of TABS) $(`#view-${id}`).hidden = id !== ui.tab;
  $('#who-am-i').textContent = t.n('{name} · {n} activity · {providers}', '{name} · {n} activities · {providers}', S.activity_count, {
    name: !S.athlete?.name || S.athlete.name === 'Athlete' ? t('Athlete') : S.athlete.name,   // 'Athlete' is the stored default, not a name
    providers: Object.keys(S.providers).filter(p => S.providers[p].connected).join(' + ') || t('no provider'),
  });
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
  const where = {
    gap: chasing ? `<b class="mono">${fmtDur(mp - chasing.check.seconds)}</b>` : '',
    who: chasing ? `<b>${cat(chasing.who)}</b>` : '',
    mark: chasing ? `<span class="mono dim">${cat(chasing.display)}</span>` : '',
    clear: clearOf ? `<b class="mono">${fmtDur(clearOf.check.seconds - mp)}</b>` : '',
    who2: clearOf ? `<b>${cat(clearOf.who)}</b>` : '',
    mark2: clearOf ? `<span class="mono dim">${cat(clearOf.display)}</span>` : '',
  };
  const whereLine = chasing && clearOf ? t('You are {gap} off {who} {mark} and {clear} clear of {who2} {mark2}.', where)
    : chasing ? t('You are {gap} off {who} {mark}.', where)
    : clearOf ? t('Nothing on the table is faster than your projection and {clear} clear of {who2} {mark2}.', where)
    : t('Nothing on the table is faster than your projection.');

  $('#view-dashboard').innerHTML = `
    <div class="grid stats">
      <div class="stat accent"><div class="k">${t('Crushed')}</div><div class="v">${num(c.crushed || 0, 0)}</div><div class="sub">${t.n('of {n} feat', 'of {n} feats', S.feat_stats.total)}</div></div>
      <div class="stat"><div class="k">${t('In reach today')}</div><div class="v">${num(c.in_reach || 0, 0)}</div><div class="sub">${t('current fitness clears them')}</div></div>
      <div class="stat"><div class="k">${t('Close')}</div><div class="v">${num(c.close || 0, 0)}</div><div class="sub">${t('within {pct}', { pct: percent(0.1) })}</div></div>
      <div class="stat"><div class="k">${t('Trainable')}</div><div class="v">${num(c.trainable || 0, 0)}</div><div class="sub">${t('inside 3 years')}</div></div>
      <div class="stat"><div class="k">${t('Fitness (CTL)')}</div><div class="v">${num(Math.round(fit.ctl), 0)}</div><div class="sub">${t('form {form} · ramp {ramp}/4wk', { form: signed(fit.tsb), ramp: signed(fit.ramp) })}</div></div>
      ${acwrTile(fit)}
      <div class="stat"><div class="k">${t('VO₂max (estimated)')}</div><div class="v">${S.profile.vo2max ? num(S.profile.vo2max, 1) : '—'}</div><div class="sub">${t('Daniels, from your race pace')}</div></div>
      <div class="stat"><div class="k">${t('Marathon projection')}</div><div class="v">${mp ? fmtDur(mp) : '—'}</div><div class="sub">${mp ? bandLabel(42195) || pace(mp / 42.195) : t('no run data')}</div></div>
    </div>

    ${mp ? `<div class="card" style="margin-bottom:1.4rem">
      <p class="eyebrow">${t('Where you sit on the table')}</p>
      <p style="font-size:1.05rem;margin-top:.5rem">
        ${whereLine}
      </p>
      <p class="dim tiny" style="margin-top:.5rem">${t('Projection from your own best efforts, not a plan.')} ${t.n('{n} run on file, improving at {rate}/year.', '{n} runs on file, improving at {rate}/year.', S.profile.counts.runs, { rate: percent(S.profile.improveRate) })}${secondOpinion()}</p>
    </div>` : ''}

    ${rivalCard()}

    <div class="grid split">
      <div class="card">
        <p class="eyebrow">${t('Go and take these — in range, not yet done')}</p>
        <table style="margin-top:.6rem"><tbody>
          ${now.map(({ f, v }) => featRow(f, v)).join('') || `<tr><td class="dim tiny">${t('nothing in range yet')}</td></tr>`}
        </tbody></table>
        <p class="eyebrow" style="margin-top:1.2rem">${t('Nearest misses — the training list')}</p>
        <table style="margin-top:.6rem"><tbody>
          ${near.map(({ f, v }) => featRow(f, v)).join('') || `<tr><td class="dim tiny">${t('nothing close')}</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <p class="eyebrow">${t('Already crushed')} ${crushed.length ? `<button class="btn ghost" style="float:inline-end" data-action="share-card">${t('Share card')}</button>` : ''}</p>
        ${crushed.length ? `<ul style="list-style:none;margin-top:.6rem">${crushed.slice(0, 10).map(f => `<li style="padding:.35rem 0;border-bottom:1px solid var(--hairline)">
          <b>${cat(f.who)}</b> <span class="dim">${cat(f.title)}</span>
          <div class="tiny faint">${esc(S.verdicts[f.id].headline)}</div></li>`).join('')}</ul>
          ${crushed.length > 10 ? `<p class="tiny faint" style="margin-top:.5rem">${t.n('+{n} more in the ledger', '+{n} more in the ledger', crushed.length - 10)}</p>` : ''}`
      : `<p class="dim tiny" style="margin-top:.6rem">${t('Nothing yet. Connect a provider, or seed the demo athlete on the Connect tab.')}</p>`}
      </div>
    </div>

    <h2>${t('Fitness and volume')}</h2>
    <div class="grid split">
      <div class="card"><p class="eyebrow">${t('Fitness / fatigue (42d vs 7d load)')}</p><div class="chart" id="ch-fitness"></div>
        <div class="legend"><span><i style="background:${COLORS.ember}"></i>${t('Fitness')}</span><span><i style="background:${COLORS.steel}"></i>${t('Fatigue')}</span></div></div>
      <div class="card"><p class="eyebrow">${t('Weekly running volume')}</p><div class="chart" id="ch-weekly"></div></div>
    </div>

    ${sacred ? `<div class="sacred" style="margin-top:1.6rem">
      <p class="label">${t('The Canadian Line')}</p>
      <p>${t('{who}, {year}: {mark} — {note}', { who: cat(sacred.who), year: sacred.year, mark: `<b class="mono">${cat(sacred.display)}</b>`, note: cat(sacred.note) })}</p>
    </div>` : ''}`;

  drawFitness('#ch-fitness'); drawWeekly('#ch-weekly');
}

/** What the other model says about the marathon, and whether logged races have moved the dial. */
function secondOpinion() {
  const alt = (S.profile.bands || []).find(x => x.distance_m === 42195)?.alt, cal = S.profile.calibration;
  return (alt ? ' ' + t('Second opinion (Daniels VDOT, no penalties): {time}.', { time: `<span class="mono">${fmtDur(alt)}</span>` }) : '')
    + (cal?.races ? ' ' + t.n('Calibrated against {n} logged race (×{bias}).', 'Calibrated against {n} logged races (×{bias}).', cal.races, { bias: num(cal.bias, 3) }) : '');
}

/** 1200×630 PNG of the headline numbers, drawn straight to a canvas. */
function shareCard() {
  const crushed = S.feats.filter(f => S.verdicts[f.id].status === 'crushed' && !f.reference).sort((a, b) => (b.tier || 0) - (a.tier || 0));
  const total = S.feats.filter(f => S.verdicts[f.id].status === 'crushed').length, mp = marathonPrediction();
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const cv = Object.assign(document.createElement('canvas'), { width: 1200, height: 630 }), g = cv.getContext('2d');
  g.fillStyle = css('--soot') || '#16130f'; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = css('--ember') || '#e8622c'; g.fillRect(0, 0, 12, 630);
  g.font = '600 30px Fraunces, Georgia, serif'; g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.fillText('Celebrity Crusher', 70, 90);
  g.font = '700 190px Fraunces, Georgia, serif'; g.fillStyle = css('--ember') || '#e8622c'; g.fillText(num(total, 0), 62, 290);
  g.font = '400 34px Georgia, serif'; g.fillStyle = css('--bone') || '#efe6d5';
  g.fillText(t.n('celebrity fitness feat crushed, of {total}', 'celebrity fitness feats crushed, of {total}', total, { total: num(S.feat_stats.total, 0) }), 70, 345);
  g.font = '400 30px Georgia, serif';
  crushed.slice(0, 5).forEach((f, i) => {
    g.fillStyle = css('--bone') || '#efe6d5'; g.fillText(f.who, 640, 150 + i * 78, 500);
    g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.font = '400 22px JetBrains Mono, monospace';
    g.fillText(f.display || f.title, 640, 182 + i * 78, 500); g.font = '400 30px Georgia, serif';
  });
  g.fillStyle = css('--bone-dim') || '#b8ad9a'; g.font = '400 24px JetBrains Mono, monospace';
  g.fillText([mp && t('marathon projection {time}', { time: fmtDur(mp) }), S.profile.vo2max && t('VO₂max {n}', { n: num(S.profile.vo2max, 1) }),
    date(new Date())].filter(Boolean).join('  ·  '), 70, 570);
  cv.toBlob(b => { download('celebrity-crusher-card.png', 'image/png', b); toast(t('Card saved')); });
}

/** Their mark, your mark, and both pulled to the same age. */
const h2hBlock = (h, f) => `<div class="card" style="margin:.7rem 0;background:var(--panel-2)">
  <p class="eyebrow">${t('Head to head')}</p>
  <table class="tiny" style="margin-top:.4rem"><tbody>
    <tr><td>${t('{who} at {age}', { who: cat(f.who), age: num(h.their_age, 0) })}</td><td class="num mono">${fmtDur(h.their_seconds)}</td><td class="num">${h.beats_raw ? '' : chip('crushed')}</td></tr>
    <tr><td>${h.your_age ? t('You at {age}', { age: num(h.your_age, 0) }) : t('You')}</td><td class="num mono">${fmtDur(h.your_seconds)}</td><td class="num">${h.beats_raw ? chip('crushed') : ''}</td></tr>
    ${h.their_seconds_at_your_age ? `<tr><td class="dim">${t('Their run, age-adjusted to you')}</td><td class="num mono dim">${fmtDur(h.their_seconds_at_your_age)}</td>
      <td class="num">${h.beats_age_adjusted ? `<span class="chip s-crushed">${t('You win')}</span>` : `<span class="chip s-close">${t('They win')}</span>`}</td></tr>` : ''}
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
  <td class="who">${cat(f.who)}<div class="tiny dim">${cat(f.title)}</div></td>
  <td class="val tiny opt">${cat(f.display || '')}</td>
  <td style="width:130px">${gapBar(v.gap)}<div class="tiny faint mono">${percent(v.gap)}${v.eta_weeks ? ` · ${t('{n}w', { n: num(v.eta_weeks, 0) })}` : ''}</div></td>
  <td class="num">${chip(v.status)}</td></tr>`;

/** Acute:chronic workload ratio — the one number that predicts injuries rather than performance. */
function acwrTile(fit) {
  const r = fit.acwr;
  if (!r) return `<div class="stat"><div class="k">${t('Load ratio')}</div><div class="v">—</div><div class="sub">${t('not enough history')}</div></div>`;
  const [label, cls] = r > 1.5 ? [t('spiking — this is where injuries come from'), 's-close'] : r > 1.3 ? [t('high'), 's-in_reach']
    : r < 0.8 ? [t('detraining'), 's-logbook'] : [t('sweet spot'), 's-crushed'];
  return `<div class="stat"><div class="k">${t('Load ratio (7d:28d)')}</div><div class="v ${cls}" style="color:currentColor">${num(r, 2)}</div>
    <div class="sub">${label}</div></div>`;
}

const bandLabel = d => {
  const b = (S.profile.bands || []).find(x => Math.abs(x.distance_m - d) < 1);
  return b && b.low ? t('{low}–{high} · ±{pct}', { low: fmtDur(b.low), high: fmtDur(b.high), pct: percent(b.pct) }) : null;
};

function rivalCard() {
  const id = S.athlete?.settings?.rival;
  const f = id && S.feats.find(x => x.id === id);
  if (!f) return '';
  const v = S.verdicts[f.id];
  return `<div class="card" style="margin-bottom:1.4rem;border-inline-start:2px solid var(--ember)">
    <p class="eyebrow">${t('Pinned rival')}</p>
    <p style="font-size:1.05rem;margin-top:.4rem"><b>${cat(f.who)}</b> — ${cat(f.title)} <span class="mono dim">${cat(f.display || '')}</span> ${chip(v.status)}</p>
    <p class="tiny dim" style="margin-top:.3rem">${esc(v.headline)}</p>
    ${v.gap != null ? `<div class="bar-row" style="margin-top:.5rem;max-width:520px">${gapBar(v.gap)}<span class="tiny mono faint">${percent(v.gap)} · ${v.eta_weeks ? t.n('{n} week at current trend', '{n} weeks at current trend', v.eta_weeks) : t('now')}</span></div>` : ''}
    ${v.h2h?.their_seconds_at_your_age ? `<p class="tiny faint" style="margin-top:.4rem">${esc(v.h2h.note)}</p>` : ''}
  </div>`;
}

/** Weekly totals: m in metres, y in the reader's unit (km or mi). */
function weeklySeries(sport = 'run') {
  const arr = S.profile.series.byDaySport[sport] || [];
  const day0 = S.profile.series.day0, weeks = [];
  for (let i = 0; i < arr.length; i += 7) {
    const m = arr.slice(i, i + 7).reduce((a, b) => a + b, 0);
    weeks.push({ m, y: inUnit(m), day: day0 + i });
  }
  return weeks.slice(-52);
}
function drawWeekly(sel) {
  const w = weeklySeries('run');
  barChart($(sel), {
    bars: w.map(x => ({ y: x.y, title: t('{date}: {dist}', { date: ymdText(dayStr(x.day)), dist: kmText(x.m / 1000) }) })),
    yFmt: axisDist, xFmt: i => { const d = w[i]; return d ? dayMonth(d.day) : ''; },
    marks: [{ y: w.reduce((a, b) => a + b.y, 0) / Math.max(1, w.length), label: t('avg'), color: COLORS.gold }],
  });
}
function drawFitness(sel) {
  const { ctl, atl, day0 } = S.profile.series;
  const from = Math.max(0, ctl.length - 365);
  const pts = a => a.slice(from).map((v, i) => [day0 + from + i, v]);
  lineChart($(sel), {
    series: [{ name: t('Fitness'), color: COLORS.ember, points: pts(ctl), area: true }, { name: t('Fatigue'), color: COLORS.steel, points: pts(atl), width: 1.1 }],
    yFmt: v => num(v, 0), xFmt: d => dayMonth(d),
  });
}

// ---------------------------------------------------------------- ledger
function ledger() {
  const cats = [...new Set(S.feats.map(f => f.category))];
  const discs = [...new Set(S.feats.map(f => f.discipline))];
  const f = ui.filters;
  const rows = filtered();
  $('#view-ledger').innerHTML = `
    <h2>${t('The Ledger')}</h2>
    <p class="dek">${t('{total} feats, {names} names, {computable} of them judged automatically against your own data.', { total: num(S.feat_stats.total, 0), names: num(S.feat_stats.celebrities, 0), computable: num(S.feat_stats.computable, 0) })} ${t('Click a row for the gap, the plan and the paperwork.')}</p>
    <div class="controls">
      <input type="text" id="q" placeholder="${esc(t('search name, feat, event'))}" value="${esc(f.q)}">
      <select id="cat"><option value="">${t('All categories')}</option>${cats.map(c => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="disc"><option value="">${t('All disciplines')}</option>${discs.map(c => `<option ${f.disc === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="status"><option value="">${t('Any verdict')}</option>${STATUSES.map(k => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${statusLabel(k)}</option>`).join('')}</select>
      <select id="sort">
        <option value="gap" ${f.sort === 'gap' ? 'selected' : ''}>${t('Sort: closest first')}</option>
        <option value="who" ${f.sort === 'who' ? 'selected' : ''}>${t('Sort: name')}</option>
        <option value="tier" ${f.sort === 'tier' ? 'selected' : ''}>${t('Sort: hardest first')}</option>
        <option value="year" ${f.sort === 'year' ? 'selected' : ''}>${t('Sort: most recent')}</option>
      </select>
      <select id="tier"><option value="">${t('Any difficulty')}</option>${[1,2,3,4,5].map(n => `<option value="${n}" ${f.tier == n ? 'selected' : ''}>${'●'.repeat(n)}${'○'.repeat(5 - n)}</option>`).join('')}</select>
      <label class="tiny dim"><input type="checkbox" id="refs" ${f.refs ? 'checked' : ''}> ${t('reference lines')}</label>
      <label class="tiny dim"><input type="checkbox" id="computable" ${f.computable ? 'checked' : ''}> ${t('machine-checkable only')}</label>
      <button class="btn ghost" data-action="export-csv">${t('Export CSV')}</button>
      <span class="tiny faint mono">${t.n('{n} shown', '{n} shown', rows.length)}</span>
    </div>
    <div class="scroll-x"><table class="ledger">
      <thead><tr><th>${t('Name')}</th><th>${t('Feat')}</th><th>${t('The numbers')}</th><th class="num opt">${t('Age')}</th><th>${t('Verdict')}</th><th class="opt">${t('Gap')}</th><th class="opt"></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table></div>`;
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
    <td class="who">${cat(f.who)}${f.proAsterisk ? '<span class="sup">†</span>' : ''}${f.flag ? ` <span class="tiny faint">${f.flag}</span>` : ''}<div class="tiny faint">${cat(f.category)}</div></td>
    <td>${cat(f.title)}${f.approx ? '<span class="sup">*</span>' : ''}<div class="tiny faint">${cat(f.event || '')}</div></td>
    <td class="val">${cat(f.display || '')}</td>
    <td class="num mono tiny opt">${f.age != null ? num(f.age, 0) : cat(f.ageLabel || '—')}</td>
    <td>${chip(v.status)}${f.gated || f.logistics ? ` <span class="chip s-far">${t('Gated')}</span>` : ''}</td>
    <td class="opt" style="width:120px">${gapBar(v.gap)}<div class="tiny faint mono">${v.gap != null ? percent(v.gap) : ''}${v.eta_weeks ? ` · ${t('{n}w', { n: num(v.eta_weeks, 0) })}` : ''}</div></td>
    <td class="num tiny faint mono opt">${open ? '▾' : '▸'}</td>
  </tr>
  ${open ? `<tr class="detail" data-detail="${f.id}"><td colspan="7"><div id="d-${cssId(f.id)}">${t('loading…')}</div></td></tr>` : ''}`;
}
const cssId = id => id.replace(/[^\w-]/g, '_');

async function hydrateDetail(featId) {
  const f = S.feats.find(x => x.id === featId), v = S.verdicts[featId];
  const box = $(`#d-${cssId(featId)}`);
  if (!box) return;
  const queued = S.queue.find(q => q.feat_id === featId);
  const goal = S.goals.find(g => g.feat_id === featId);
  const attempts = S.attempts.filter(a => a.feat_id === featId);
  const band = v.band && { low: fmtDur(v.band.low), high: fmtDur(v.band.high), pct: percent(v.band.pct), alt: v.band.alt ? fmtDur(v.band.alt) : '' };
  box.innerHTML = `
    <p style="max-width:75ch">${cat(f.note)}</p>
    <div class="kv">
      <div><div class="k">${t('Verdict')}</div><div class="v">${chip(v.status)}</div></div>
      ${v.gap != null ? `<div><div class="k">${t('You vs them')}</div><div class="v">${percent(v.gap)}</div></div>` : ''}
      ${v.eta_weeks ? `<div><div class="k">${t('At current trend')}</div><div class="v">${t('{n} wk', { n: num(v.eta_weeks, 0) })}</div></div>` : ''}
      <div><div class="k">${t('Confidence')}</div><div class="v tiny">${esc(confidenceLabel(f.confidence))}</div></div>
      <div><div class="k">${t('Difficulty')}</div><div class="v">${'●'.repeat(f.tier || 0)}${'○'.repeat(5 - (f.tier || 0))}</div></div>
    </div>
    <p class="mono tiny" style="color:var(--bone)">${esc(v.headline)}</p>
    ${band ? `<p class="tiny faint mono">${band.alt
      ? t('Confidence band: {low}–{high} (±{pct}, from how much measured racing your data contains; Daniels VDOT says {alt}).', band)
      : t('Confidence band: {low}–{high} (±{pct}, from how much measured racing your data contains).', band)}</p>` : ''}
    ${v.h2h ? h2hBlock(v.h2h, f) : ''}
    ${f.logistics ? `<p class="tiny" style="color:var(--gold);margin-top:.4rem">${t('Paperwork: {text}', { text: cat(f.logistics) })}</p>` : ''}
    <div id="plan-${cssId(featId)}" class="tiny dim" style="margin-top:.7rem">${t('plan…')}</div>
    ${attempts.length ? `<p class="tiny dim" style="margin-top:.6rem">${t('Logged: {list}', { list: attempts.map(a => `${esc(ymdText(a.date))}${a.verified ? ' ✓' : ''}`).join(', ') })}</p>` : ''}
    <div class="controls" style="margin-top:.9rem">
      <button class="btn ${queued ? '' : 'primary'}" data-action="queue-add" data-feat="${featId}" ${queued ? 'disabled' : ''}>${queued ? t('In queue') : t('Add to queue')}</button>
      <input type="date" id="gd-${cssId(featId)}" value="${esc(goal?.target_date || '')}">
      <button class="btn" data-action="goal-add" data-feat="${featId}">${goal ? t('Update goal') : t('Set as goal')}</button>
      <button class="btn ghost" data-action="attempt-form" data-feat="${featId}">${t('Log attempt')}</button>
      <button class="btn ghost" data-action="pin-rival" data-feat="${featId}">${S.athlete?.settings?.rival === featId ? t('Unpin rival') : t('Pin as rival')}</button>
    </div>
    <div id="att-${cssId(featId)}"></div>`;
  try {
    const plan = await api(`/api/plan/${encodeURIComponent(featId)}`, { method: 'GET' });
    const tg = plan.targets || {};
    $(`#plan-${cssId(featId)}`).innerHTML = `
      ${Object.keys(tg).length ? `<div class="kv">${Object.entries(tg).filter(([k]) => !(tg[k + '_str'] !== undefined)).slice(0, 6)
        .map(([k, val]) => targetRow(k, val)).join('')}</div>` : ''}
      <ul class="plan-steps">${plan.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
  } catch { $(`#plan-${cssId(featId)}`).textContent = ''; }
}

// ---------------------------------------------------------------- queue
function queueView() {
  const items = S.queue.map(q => ({ q, f: S.feats.find(x => x.id === q.feat_id), v: S.verdicts[q.feat_id] })).filter(x => x.f);
  $('#view-queue').innerHTML = `
    <h2>${t('The Queue')}</h2>
    <p class="dek">${t('Ordered list of what you are actually going after. Order is yours; the readiness call is the engine\'s.')}</p>
    ${items.length ? items.map(({ q, f, v }, i) => `
      <div class="qitem">
        <div class="pos">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <div><b>${cat(f.who)}</b> — ${cat(f.title)} <span class="mono tiny dim">${cat(f.display || '')}</span></div>
          <div class="tiny faint">${esc(v.headline)}</div>
          <div class="controls" style="margin-top:.5rem">
            <select data-action="q-status" data-id="${q.id}">
              ${QUEUE_STATUSES.map(s => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${queueLabel(s)}</option>`).join('')}
            </select>
            <input type="date" data-action="q-date" data-id="${q.id}" value="${esc(q.target_date || '')}">
            ${chip(v.status)}
            ${v.eta_weeks ? `<span class="tiny faint mono">${t.n('{n} week at current trend', '{n} weeks at current trend', v.eta_weeks)}</span>` : ''}
          </div>
        </div>
        <div class="qactions">
          <button class="btn ghost" data-action="q-move" data-id="${q.id}" data-dir="up" title="${esc(t('Move up'))}">↑</button>
          <button class="btn ghost" data-action="q-move" data-id="${q.id}" data-dir="down" title="${esc(t('Move down'))}">↓</button>
          <button class="btn" data-action="goal-from-queue" data-feat="${f.id}" data-date="${esc(q.target_date || '')}">${t('Make goal')}</button>
          <button class="btn ghost" data-action="q-remove" data-id="${q.id}" title="${esc(t('Remove from queue'))}">✕</button>
        </div>
      </div>`).join('')
      : `<p class="dim">${t('Empty. Open the ledger and add something you can nearly do — the closest unbeaten feats are on the dashboard.')}</p>`}

    <h2>${t('Suggested next')}</h2>
    <p class="dek">${t('In range and unclaimed first, then the nearest misses. Anything already queued is left out.')}</p>
    ${[...bagNow(), ...nearMiss()].filter(x => !S.queue.some(q => q.feat_id === x.f.id)).slice(0, 8).map(({ f, v }) => `
      <div class="qitem"><div class="pos faint">+</div>
        <div><b>${cat(f.who)}</b> — ${cat(f.title)} <span class="mono tiny dim">${cat(f.display || '')}</span>
        <div class="tiny faint">${esc(v.headline)}</div></div>
        <div class="qactions"><button class="btn primary" data-action="queue-add" data-feat="${f.id}">${t('Queue')}</button></div>
      </div>`).join('')}`;
}

// ---------------------------------------------------------------- goals
async function goalsView() {
  const box = $('#view-goals');
  box.innerHTML = `<h2>${esc(t('Goals'))}</h2>
    <p class="dek">${t('A goal is a feat plus a date. The plan below is derived from your current numbers and the gap to the target, not from a template.')}</p>
    ${S.goals.length ? `<div id="goal-list">${t('loading…')}</div>` : `<p class="dim">${t('No goals yet. Set one from any ledger row.')}</p>`}`;
  if (!S.goals.length) return;
  const plans = await Promise.all(S.goals.map(g => api(`/api/goals/${g.id}/plan`, { method: 'GET' }).catch(() => null)));
  $('#goal-list').innerHTML = S.goals.map((g, i) => {
    const f = S.feats.find(x => x.id === g.feat_id), p = plans[i], v = S.verdicts[g.feat_id];
    if (!f) return '';
    const tg = p?.targets || {};
    const weeks = p?.weeks_remaining, need = p?.weeks_needed;
    const ready = need != null && weeks != null ? weeks - need : null;
    return `<div class="goal">
      <div class="head">
        <h3>${cat(f.who)} — ${cat(f.title)} <span class="mono dim" style="font-size:.9rem">${cat(f.display || '')}</span></h3>
        <div>${chip(v.status)} <span class="tiny mono faint">${esc(goalLabel(g.status))}</span></div>
      </div>
      <p class="tiny dim">${esc(v.headline)}</p>
      <div class="kv">
        <div><div class="k">${t('Target date')}</div><div class="v"><input type="date" data-action="goal-date" data-id="${g.id}" value="${esc(g.target_date || '')}"></div></div>
        ${weeks != null ? `<div><div class="k">${t('Weeks remaining')}</div><div class="v">${num(weeks, 0)}</div></div>` : ''}
        ${need != null ? `<div><div class="k">${t('Weeks needed')}</div><div class="v">${num(need, 0)}</div></div>` : ''}
        ${ready != null ? `<div><div class="k">${t('Margin')}</div><div class="v" style="color:${ready >= 0 ? 'var(--crushed)' : 'var(--close)'}">${t('{n} wk', { n: (ready >= 0 ? '+' : '') + num(ready, 0) })}</div></div>` : ''}
        ${tg.race_pace_str ? `<div><div class="k">${t('Race pace')}</div><div class="v">${tg.race_pace_str}</div></div>` : ''}
        ${tg.peak_weekly_km ? `<div><div class="k">${t('Peak volume')}</div><div class="v">${t('{dist}/wk', { dist: kmText(tg.peak_weekly_km) })}</div></div>` : ''}
        ${tg.current_weekly_km != null ? `<div><div class="k">${t('You now')}</div><div class="v">${t('{dist}/wk', { dist: kmText(tg.current_weekly_km) })}</div></div>` : ''}
        ${tg.projected_now_str ? `<div><div class="k">${t('Projected now')}</div><div class="v">${tg.projected_now_str}</div></div>` : ''}
      </div>
      ${tg.peak_weekly_km ? volumeProgress(tg.current_weekly_km, tg.peak_weekly_km) : ''}
      <ul class="plan-steps">${(p?.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      ${p?.weeks?.length ? weekTable(p.weeks, g.id) : ''}
      <div class="controls" style="margin-top:.7rem">
        <button class="btn ghost" data-action="goal-delete" data-id="${g.id}">${t('Drop goal')}</button>
        <button class="btn" data-action="attempt-form" data-feat="${f.id}">${t('Log attempt')}</button>
      </div>
      <div id="att-${cssId(f.id)}"></div>
    </div>`;
  }).join('');
}
function weekTable(weeks, goalId) {
  window.__plans = window.__plans || {};
  window.__plans[goalId] = weeks;
  return `<details style="margin-top:.8rem">
    <summary class="eyebrow" style="cursor:pointer">${t('The {n}-week build · {total} total', { n: num(weeks.length, 0), total: t('{n} {unit}', { n: num(inUnit(weeks.reduce((a, w) => a + w.km, 0) * 1000), 0), unit: distUnit() }) })}</summary>
    <table class="tiny" style="margin-top:.6rem"><thead><tr><th>${t('Wk')}</th><th>${t('From')}</th><th>${t('Phase')}</th><th class="num">${t('Volume')}</th><th class="num">${t('Long')}</th><th>${t('Sessions')}</th></tr></thead>
      <tbody>${weeks.map(w => `<tr>
        <td class="mono">${num(w.week, 0)}</td><td class="mono faint">${esc(ymdText(w.start))}</td>
        <td class="tiny" style="color:${w.phase === 'peak' ? 'var(--ember)' : w.phase === 'recovery' ? 'var(--bone-faint)' : 'var(--bone-dim)'}">${esc(phaseLabel(w.phase))}</td>
        <td class="num mono">${kmText(w.km)}</td><td class="num mono faint">${kmText(w.long_km)}</td>
        <td class="tiny dim">${w.sessions.map(esc).join(' · ')}</td></tr>`).join('')}</tbody></table>
    <button class="btn ghost" style="margin-top:.6rem" data-action="plan-ics" data-id="${goalId}">${t('Export plan to calendar (.ics)')}</button>
  </details>`;
}

const volumeProgress = (now, target) => `<div class="bar-row"><span class="bar ${now >= target ? 'done' : ''}"><i style="width:${Math.min(100, now / target * 100).toFixed(0)}%"></i></span>
  <span class="tiny mono faint">${t('{now} / {target} {unit} per week', { now: num(inUnit((now || 0) * 1000), 1), target: num(inUnit(target * 1000), 1), unit: distUnit() })}</span></div>`;

// ---------------------------------------------------------------- analytics
function analytics() {
  const c = counts();
  const byCat = {};
  for (const f of S.feats) { (byCat[f.category] ||= { total: 0 }); byCat[f.category].total++; const s = S.verdicts[f.id].status; byCat[f.category][s] = (byCat[f.category][s] || 0) + 1; }
  const windows = S.profile.windows;
  const ed = S.profile.eddingtons;
  $('#view-analytics').innerHTML = `
    <h2>${t('Analytics')}</h2>
    <p class="dek">${t('Your performance curve against the ledger. Anything plotted below the line is already inside your range; anything above it is the work.')}</p>

    <div class="card"><p class="eyebrow">${t('Pace curve vs every timed feat')}</p>
      <div class="chart" id="ch-curve"></div>
      <div class="legend">
        <span><i style="background:${COLORS.ember}"></i>${t('Your predicted curve')}</span>
        <span><i style="background:${COLORS.gold}"></i>${t('Measured personal bests')}</span>
        <span><i style="background:${COLORS.green}"></i>${t('Feat you have beaten')}</span>
        <span><i style="background:${COLORS.bone}"></i>${t('Feat still standing')}</span>
      </div>
    </div>

    <div class="grid split" style="margin-top:1rem">
      <div class="card"><p class="eyebrow">${t('Verdict spread')}</p>${statusBars(c, S.feat_stats.total)}</div>
      <div class="card"><p class="eyebrow">${t('Rolling window capacity')}</p>
        <table class="tiny"><thead><tr><th>${t('Window')}</th><th class="num">${t('Best run block')}</th><th class="num">${t('Best all-sport')}</th><th>${t('Nearest feat')}</th></tr></thead>
        <tbody>${windows.map(w => {
          const feat = S.feats.filter(f => f.check.kind === 'distance_window' && Math.abs(f.check.days - w.days) <= Math.max(2, w.days * 0.2))
            .sort((a, b) => a.check.meters - b.check.meters)[0];
          return `<tr><td class="mono">${t('{n} d', { n: num(w.days, 0) })}</td><td class="num mono">${dist(w.run)}</td><td class="num mono">${dist(w.all)}</td>
            <td class="tiny">${feat ? `${cat(feat.who)} <span class="faint">${dist(feat.check.meters)}</span>` : '<span class="faint">—</span>'}</td></tr>`;
        }).join('')}</tbody></table>
      </div>
    </div>

    <div class="grid split" style="margin-top:1rem">
      <div class="card"><p class="eyebrow">${t('Volume by sport, last 52 weeks')}</p><div class="chart" id="ch-sports"></div>
        <div class="legend"><span><i style="background:${COLORS.ember}"></i>${t('Run')}</span><span><i style="background:${COLORS.steel}"></i>${t('Ride')}</span><span><i style="background:${COLORS.violet}"></i>${t('Swim')}</span></div></div>
      <div class="card"><p class="eyebrow">${t('Personal bests and predictions')}</p>
        <table class="tiny"><thead><tr><th>${t('Distance')}</th><th class="num">${t('Best')}</th><th class="num">${t('Pace')}</th><th class="num">${t('Predicted')}</th><th>${t('Source')}</th></tr></thead>
        <tbody>${S.profile.pbs.filter(p => p.seconds || p.predicted).map(p => `<tr>
          <td class="mono">${dist(p.distance_m)}</td>
          <td class="num mono">${p.seconds ? fmtDur(p.seconds) : '—'}</td>
          <td class="num mono faint">${p.seconds ? pace(p.seconds / (p.distance_m / 1000)) : '—'}</td>
          <td class="num mono">${p.predicted ? fmtDur(p.predicted) : '—'}</td>
          <td class="tiny faint">${p.measured ? t('measured') : p.seconds ? t('even-pace read') : t('extrapolated')}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>

    <h2>${t('Milestones')}</h2>
    <p class="dek">${t('The day each feat fell, replayed from your history. Eddington number — the largest E with E days of at least E — stands at {run} running (km), {ride} riding (km) and {ridemi} riding (miles).', {
      run: `<b class="mono">${num(ed.run_km, 0)}</b>`, ride: `<b class="mono">${num(ed.ride_km, 0)}</b>`, ridemi: `<b class="mono">${num(ed.ride_mi, 0)}</b>`,
    })}</p>
    <div class="card" id="milestones"><p class="dim tiny">${t('replaying…')}</p></div>

    <h2>${t('Crush forecast')}</h2>
    <p class="dek">${t('Where the ledger goes if you keep improving at {rate} a year. Not a promise — an extrapolation of your own trend, and trends bend.', { rate: percent(S.profile.improveRate) })}</p>
    <div class="grid split">
      <div class="card"><p class="eyebrow">${t('Feats within reach over the next three years')}</p><div class="chart" id="ch-forecast"></div></div>
      <div class="card"><p class="eyebrow">${t('Next to fall')}</p>
        <table class="tiny"><thead><tr><th>${t('Feat')}</th><th class="num">${t('Weeks')}</th><th class="num">${t('Projected')}</th></tr></thead>
        <tbody>${forecast().rows.slice(0, 12).map(r => `<tr class="row" data-action="goto-feat" data-feat="${r.f.id}">
          <td>${cat(r.f.who)} <span class="dim">${cat(r.f.title)}</span></td>
          <td class="num mono">${num(r.weeks, 0)}</td>
          <td class="num mono faint">${monthYear(r.date)}</td></tr>`).join('') || `<tr><td class="dim">${t('nothing inside three years')}</td></tr>`}
        </tbody></table>
      </div>
    </div>

    <h2>${t('By category')}</h2>
    <div class="scroll-x"><table><thead><tr><th>${t('Category')}</th><th class="num">${t('Feats')}</th><th>${t('Spread')}</th><th class="num">${t('Crushed')}</th></tr></thead>
    <tbody>${Object.entries(byCat).sort((a, b) => b[1].total - a[1].total).map(([cat, v]) => `<tr>
      <td>${esc(cat)}</td><td class="num mono">${num(v.total, 0)}</td>
      <td>${statusBars(v, v.total, true)}</td>
      <td class="num mono">${num(v.crushed || 0, 0)}</td></tr>`).join('')}</tbody></table></div>`;

  drawCurve(); drawSports(); drawForecast(); drawMilestones();
}

async function drawMilestones() {
  const ms = await api('/api/milestones', { method: 'GET' }).catch(() => []);
  const box = $('#milestones');
  if (!box) return;                                   // tab changed while it was replaying
  // appFont.html (font.js) escapes every ${…}; fragments it built itself nest as markup.
  const html = appFont.html;
  let year = '';
  const rows = ms.map(m => {
    const f = S.feats.find(x => x.id === m.feat_id), y = String(m.date).slice(0, 4);
    if (!f) return html``;
    const head = y !== year ? html`<tr><td colspan="3" class="eyebrow" style="padding-top:.8rem">${year = y}</td></tr>` : html``;
    return html`${head}<tr class="row" data-action="goto-feat" data-feat="${f.id}"><td class="mono faint">${ymdText(m.date)}</td>
      <td><b><bdi lang="en" dir="ltr">${f.who}</bdi></b> <span class="dim"><bdi lang="en" dir="ltr">${f.title}</bdi></span> <span class="mono faint"><bdi lang="en" dir="ltr">${f.display || ''}</bdi></span>${m.logged ? html` <span class="chip s-logbook">${t('logged')}</span>` : ''}</td>
      <td class="dim">${m.headline}</td></tr>`;
  });
  const table = html`<table class="tiny"><tbody>${rows}</tbody></table>`;
  box.innerHTML = ms.length ? table : `<p class="dim tiny">${esc(t('Nothing crushed yet.'))}</p>`;
}

function drawForecast() {
  const { points, nowCount } = forecast();
  lineChart($('#ch-forecast'), {
    series: [{ name: t('Reachable'), color: COLORS.ember, points, area: true }],
    yFmt: v => num(v, 0), xFmt: m => t('+{n}m', { n: num(Math.round(m), 0) }), yMin: Math.max(0, nowCount - 5),
  });
}

function statusBars(c, total, compact = false) {
  return `<div style="display:flex;height:${compact ? 8 : 14}px;border:1px solid var(--hairline);margin:.4rem 0">
    ${STATUSES.map(s => c[s] ? `<span title="${esc(t('{status}: {n}', { status: statusLabel(s), n: num(c[s], 0) }))}" style="width:${c[s] / total * 100}%;background:var(--${s === 'in_reach' ? 'reach' : s})"></span>` : '').join('')}
  </div>${compact ? '' : `<div class="legend">${STATUSES.filter(s => c[s]).map(s => `<span><i style="background:var(--${s === 'in_reach' ? 'reach' : s})"></i>${t('{status} {n}', { status: statusLabel(s), n: num(c[s], 0) })}</span>`).join('')}</div>`}`;
}

function drawCurve() {
  const pbs = S.profile.pbs.filter(p => p.seconds).map(p => ({ d: p.distance_m, pace: p.seconds / (p.distance_m / 1000), label: `${dist(p.distance_m)} ${fmtDur(p.seconds)}` }));
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
      { name: t('Run'), color: COLORS.ember, points: mk('run') },
      { name: t('Ride'), color: COLORS.steel, points: mk('ride') },
      { name: t('Swim'), color: COLORS.violet, points: mk('swim') },
    ].filter(s => s.points.some(p => p[1] > 0)),
    yFmt: axisDist, xFmt: i => t('w{n}', { n: num(Math.round(i), 0) }),
  });
}

// ---------------------------------------------------------------- connect
function connect() {
  const p = S.providers, a = S.athlete || {}, sc = syncCfg();
  setTimeout(() => { paintSyncState(); mountCowork(); }, 0);
  $('#view-connect').innerHTML = `
    <h2>${t('Connect')}</h2>
    <p class="dek">${t('Strava is the main door. Garmin has two: the partner API if you have keys, and plain file import if you do not. If your watch already syncs to Strava, one connection covers both — duplicates are dropped on the way in.')}</p>
    ${S.static ? `<p class="notice">${t('Running as a standalone app: everything below the imports happens in this browser, and your data never leaves it. Live OAuth sync is the one thing a page without a server cannot do — both exchanges need a client secret — so bring your history in as a file. Run {cmd} from the repo for one-click Strava sync.', { cmd: '<code>node server.mjs</code>' })}</p>` : ''}

    <div class="grid cards">
      <div class="card">
        <p class="eyebrow">Strava</p>
        <p class="tiny dim" style="margin:.5rem 0">${p.strava.connected ? t('Connected. Sync pulls new activities and the measured best efforts Strava computes for runs.') : p.strava.configured ? t('Keys present. Authorise to pull your activity history.') : S.static ? t('Strava → Settings → My Account → Download or Delete Your Account → Request Archive. Import the activities.csv below.') : t('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, then restart.')}</p>
        ${p.strava.connected
          ? `<button class="btn primary" data-action="sync" data-provider="strava">${t('Sync now')}</button>
             <button class="btn" data-action="sync-full" data-provider="strava">${t('Full re-pull')}</button>`
          : p.strava.configured
            ? `<a class="btn primary" href="/connect/strava" style="text-decoration:none;display:inline-block">${t('Authorise Strava')}</a>`
            : `<button class="btn" disabled>${S.static ? t('File import below') : t('Needs keys')}</button>`}
      </div>

      <div class="card">
        <p class="eyebrow">${t('Garmin — partner API')}</p>
        <p class="tiny dim" style="margin:.5rem 0">${p.garmin.connected ? t('Connected via the Garmin Connect Developer Program.') : p.garmin.configured ? t('Keys present. Authorise to pull activities.') : S.static ? t('The partner API needs a server to hold the secret. File import below needs nothing at all.') : t('Requires an approved Garmin developer account. Without one, use file import below — it needs nothing.')}</p>
        ${p.garmin.connected
          ? `<button class="btn primary" data-action="sync" data-provider="garmin">${t('Sync now')}</button>`
          : p.garmin.configured
            ? `<a class="btn primary" href="/connect/garmin" style="text-decoration:none;display:inline-block">${t('Authorise Garmin')}</a>`
            : `<button class="btn" disabled>${S.static ? t('File import below') : t('Needs partner keys')}</button>`}
      </div>

      <div class="card">
        <p class="eyebrow">${t('File import — Garmin or Strava')}</p>
        <p class="tiny dim" style="margin:.5rem 0">${t('Garmin Connect → Activities → Export CSV, a Strava archive\'s activities.csv, or any single .gpx. No registration, works today, offline.')}</p>
        <div class="controls">
          <input type="file" id="gfile" accept=".csv,.gpx" class="tiny">
          <select id="gunits"><option value="metric">${t('km')}</option><option value="imperial">${t('miles')}</option></select>
          <button class="btn primary" data-action="import">${t('Import')}</button>
        </div>
      </div>

      <div class="card">
        <p class="eyebrow">${t('Garmin — watched folder')}</p>
        <p class="tiny dim" style="margin:.5rem 0">${t('Run {cmd} on a schedule and point this at the folder it writes to. Every load re-imports the newest file, merging — no clicking, no export dance.', { cmd: '<code>tools/garmin-sync.py</code>' })}</p>
        <p class="tiny mono" id="garmin-folder">…</p>
        <div class="controls">
          <button class="btn primary" data-action="garmin-pick">${t('Pick folder')}</button>
          <button class="btn" data-action="garmin-load">${t('Load now')}</button>
          <button class="btn ghost" data-action="garmin-forget">${t('Forget')}</button>
        </div>
      </div>

      <div class="card">
        <p class="eyebrow">${t('Demo athlete')}</p>
        <p class="tiny dim" style="margin:.5rem 0">${t('18 months of a plausible 3:2x marathon build, so every dashboard has something in it before you connect anything real.')}</p>
        <button class="btn" data-action="demo">${t('Seed demo data')}</button>
        <button class="btn ghost" data-action="demo-clear">${t('Clear demo')}</button>
      </div>
    </div>

    <h2>${t('You')}</h2>
    <div class="controls">
      <label class="field">${t('Name')}<input type="text" id="a-name" value="${esc(a.name || '')}"></label>
      <label class="field">${t('Birth year')}<input type="number" id="a-year" value="${a.birth_year || ''}" min="1900" max="2020"></label>
      <label class="field">${t('Weight (kg)')}<input type="number" id="a-weight" value="${a.weight_kg || ''}" step="0.5"></label>
      <label class="field">${t('Age-grade table')}<select id="a-sex">${[['', t('not set (men\'s)')], ['M', t('men\'s')], ['F', t('women\'s')]].map(([v, l]) => `<option value="${v}" ${(a.sex || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn primary" data-action="save-athlete">${t('Save')}</button>
      <app-theme-picker label="${esc(t('Theme'))}"></app-theme-picker>
      <app-font-picker label="${esc(t('Reading font'))}"></app-font-picker>
    </div>
    <p class="tiny faint">${t('Birth year lets the ledger tell you how old each celebrity was when they did it, next to how old you are now. Age adjustment uses the USATF Masters 2025 road tables.')}</p>

    <h2>${t('Cloud sync')}</h2>
    <p class="dek">${t('Your queue, goals, logged attempts and imported activities, carried between devices. The file goes straight from this browser to your storage — nothing passes through a server of ours. Provider data is left out; it re-syncs.')}</p>
    <div class="controls">
      <label class="field">${t('Target')}<select data-action="sync-provider">${Sync.SYNC_PROVIDERS.map(p =>
        `<option value="${p.id}" ${sc.provider === p.id ? 'selected' : ''} ${p.supported() ? '' : 'disabled'}>${p.supported() ? esc(p.label) : t('{label} — not in this browser', { label: esc(p.label) })}</option>`).join('')}</select></label>
      <button class="btn primary" data-action="sync-now">${t('Sync now')}</button>
      <button class="btn" data-action="sync-restore">${t('Pull only')}</button>
      <button class="btn ghost" data-action="sync-disconnect">${t('Disconnect')}</button>
      <label class="tiny dim"><input type="checkbox" data-action="sync-auto" ${sc.auto ? 'checked' : ''}> ${t('keep synced automatically')}</label>
    </div>
    <p class="tiny mono" id="sync-state">…</p>
    ${sc.provider === 'googleDrive' && !Sync.driveOriginAllowed() && !sc.driveClientId ? `<p class="tiny" style="color:var(--gold)">${t('This deployment is not one of the origins registered with the built-in Google client, so Drive needs your own OAuth client ID (Google Cloud console → Credentials → OAuth client → Web application, with this page\'s origin as an authorised JavaScript origin).')}</p>` : ''}
    ${sc.provider === 'googleDrive' ? `<div class="controls"><label class="field">${t('Your own OAuth client ID (optional)')}<input type="text" data-action="sync-clientid" value="${esc(sc.driveClientId)}" placeholder="…apps.googleusercontent.com"></label></div>` : ''}
    <p class="tiny faint">${t('Merging is add-only: a goal or attempt deleted on one device comes back from the other. Delete it on both, or restore from a backup file.')}</p>

    <h2>Cowork</h2>
    <p class="dek">${t('Hand your numbers to an AI agent through a shared folder (Claude Cowork works from it) and get a feat coach\'s advice back: what to attempt next, a four-week focus, one risk to watch. You review each reply before it is shown here, and can undo it from the panel\'s history.')}</p>
    <div id="cowork-slot"></div>
    <div class="card coach-reply" id="coach-reply" hidden><p class="eyebrow">${t('Feat coach')}</p><div class="coach-text" data-clamp></div></div>

    <h2>${t('Backup')}</h2>
    <p class="dek">${t('Everything you typed — queue, goals, logged attempts, imported activities — as one JSON file. Provider data is not included; it re-syncs.')}</p>
    ${S.static ? `<p class="tiny" style="color:var(--gold)">${t('Worth doing here: a standalone install keeps everything in this browser\'s storage, which clearing site data wipes.')}</p>` : ''}
    <div class="controls">
      <button class="btn" data-action="backup">${t('Download backup')}</button>
      <input type="file" id="rfile" accept=".json" class="tiny">
      <button class="btn" data-action="restore">${t('Restore')}</button>
    </div>

    <h2>${t('Erase everything')}</h2>
    <p class="dek">${t('Removes this app\'s data from this device: your activities, queue, goals, logged attempts, settings, coaching advice, the remembered folders and the cloud-sync and Cowork connections. Other apps on this site keep theirs. Your copy in Google Drive or your sync folder is not touched — connect sync again and it comes back. Download a backup first if you want one.')}</p>
    <div class="controls"><button class="btn danger" data-action="erase-all">${t('Erase everything on this device')}</button></div>

    <h2>${t('Sync log')}</h2>
    <div class="scroll-x"><table class="tiny"><thead><tr><th>${t('When')}</th><th>${t('Provider')}</th><th>${t('Status')}</th><th class="num">${t('Added')}</th><th>${t('Message')}</th></tr></thead>
      <tbody>${S.sync_log.map(l => `<tr>
        <td class="mono">${esc(dateTime(new Date(l.started_ts * 1000)))}</td>
        <td class="mono">${esc(l.provider)}</td>
        <td class="mono" style="color:${l.status === 'ok' ? 'var(--crushed)' : l.status === 'error' ? 'var(--close)' : 'var(--bone-dim)'}">${esc(logLabel(l.status))}</td>
        <td class="num mono">${num(l.added ?? 0, 0)}</td><td class="dim">${esc(l.message || '')}</td></tr>`).join('') || `<tr><td colspan="5" class="dim">${t('nothing yet')}</td></tr>`}
      </tbody></table></div>

    <h2>${t('Recent activities')}</h2>
    <div class="scroll-x"><table class="tiny"><thead><tr><th>${t('Date')}</th><th>${t('Sport')}</th><th>${t('Name')}</th><th class="num">${t('Distance')}</th><th class="num">${t('Time')}</th><th class="num">${t('Elev')}</th></tr></thead>
      <tbody>${S.activities.slice(0, 25).map(x => `<tr>
        <td class="mono">${esc(date(new Date(x.start_ts * 1000)))}</td>
        <td class="mono">${esc(sportLabel(x.sport))}</td><td class="dim">${esc(x.name || '')}</td>
        <td class="num mono">${dist(x.distance_m)}</td><td class="num mono">${fmtDur(x.moving_s)}</td>
        <td class="num mono faint">${height(x.elev_m)}</td></tr>`).join('') || `<tr><td colspan="6" class="dim">${t('no activities')}</td></tr>`}
      </tbody></table></div>`;
}

// ---------------------------------------------------------------- cowork
// The shared engine is loaded on demand, mounted once into a host that survives the Connect
// tab's re-renders (it is re-attached, not re-mounted), and reads S fresh on every request.
const coworkHost = document.createElement('div');
let coworkMounted = false;
const loadCowork = () => window.cowork ? Promise.resolve(window.cowork) : new Promise(res => {
  const s = Object.assign(document.createElement('script'), { src: 'https://adervec.github.io/cowork.js', async: true });
  s.onload = () => res(window.cowork || null); s.onerror = () => res(null);
  document.head.appendChild(s);
});
const coachSaved = () => { try { return localStorage.getItem(REPLY_KEY) || ''; } catch { return ''; } };
function showCoach(text) {
  const box = $('#coach-reply');
  if (!box) return;
  box.hidden = !text;
  box.querySelector('.coach-text').textContent = text;
}
function mountCowork() {
  $('#cowork-slot')?.append(coworkHost);
  showCoach(coachSaved());
  if (coworkMounted) return;
  coworkMounted = true;
  loadCowork().then(cw => {
    if (!cw) { coworkHost.innerHTML = `<p class="tiny dim">${esc(t('The Cowork panel could not load — it needs to reach adervec.github.io once.'))}</p>`; coworkMounted = false; return; }
    cw.mount(coworkHost, {
      app: APP_ID, manifest: MANIFEST,
      files: () => ({ 'coach/request.json': coachRequest(S), 'coach/INSTRUCTIONS.md': INSTRUCTIONS }),
      channels: {
        coach: {
          label: t('Feat coach'),                                // review stays on: the default
          preview: reply => [{ id: 'reply', label: t('Show this advice on the Connect tab (replaces the current one)'), detail: replyText(reply).slice(0, 600) }],
          apply: reply => {
            const prev = coachSaved(), text = replyText(reply);
            try { localStorage.setItem(REPLY_KEY, text); } catch { /* quota */ }
            showCoach(text);
            return { summary: t('new coaching advice shown'), undo: { prev } };
          },
          undo: data => { try { localStorage.setItem(REPLY_KEY, data.prev || ''); } catch { /* quota */ } showCoach(data.prev || ''); },
        },
      },
      brief: () => coachBrief(S),
    });
  });
}

/** The two lines that need an await: which folder is watched, and who is signed in. */
async function paintSyncState() {
  const cfg = syncCfg(), f = $('#garmin-folder'), st = $('#sync-state');
  if (f) f.textContent = Sync.garminFolderSupported()
    ? ((await Sync.garminFolderName()) ? t('Watching: {name}', { name: await Sync.garminFolderName() }) : t('No folder picked yet.'))
    : t('This browser has no directory picker — use the file import above.');
  if (!st) return;
  const p = Sync.getSyncProvider(cfg.provider);
  const how = { auto: t('auto'), manual: t('manual'), 'on load': t('on load') }[cfg.lastNote] || cfg.lastNote;
  const when = cfg.lastSync
    ? (how ? t('last synced {when} ({how})', { when: dateTime(new Date(cfg.lastSync)), how }) : t('last synced {when}', { when: dateTime(new Date(cfg.lastSync)) }))
    : t('never synced');
  const who = p && (await p.accountLabel?.());
  // Signed in to Google: their profile picture sits beside the account name. No picture, no element.
  const pic = who && p.accountPicture?.();
  const img = pic ? Object.assign(document.createElement('img'), { src: pic, alt: '', referrerPolicy: 'no-referrer', className: 'avatar' }) : '';
  st.replaceChildren(`${p ? p.label : t('No target')} · `, img, `${who || t('not connected')} · ${when}`);
}

// ---------------------------------------------------------------- actions
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, feat, id, provider, dir, date: dateAttr } = el.dataset;
  try {
    switch (action) {
      case 'tab': ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
      case 'toggle': {
        ui.open.has(feat) ? ui.open.delete(feat) : ui.open.add(feat);
        ledger(); break;
      }
      case 'goto-feat': ui.tab = 'ledger'; ui.open.add(feat); ui.filters.q = ''; render(); break;
      case 'queue-add': await api('/api/queue', { body: { feat_id: feat } }); toast(t('Queued')); await load(); break;
      case 'q-remove': await api(`/api/queue/${id}`, { method: 'DELETE' }); await load(); break;
      case 'q-move': await api(`/api/queue/${id}`, { method: 'PATCH', body: { move: dir } }); await load(); break;
      case 'goal-add': {
        const d = $(`#gd-${cssId(feat)}`)?.value || null;
        const existing = S.goals.find(g => g.feat_id === feat);
        if (existing) await api(`/api/goals/${existing.id}`, { method: 'PATCH', body: { target_date: d } });
        else await api('/api/goals', { body: { feat_id: feat, target_date: d } });
        toast(t('Goal set')); await load(); break;
      }
      case 'goal-from-queue': await api('/api/goals', { body: { feat_id: feat, target_date: dateAttr || null } }); toast(t('Goal set')); await load(); break;
      case 'goal-delete': await api(`/api/goals/${id}`, { method: 'DELETE' }); await load(); break;
      case 'attempt-form': attemptForm(feat); break;
      case 'attempt-save': {
        const box = $(`#att-${cssId(feat)}`);
        const raw = box.querySelector('.a-time')?.value.trim(), parts = raw ? raw.split(':').map(Number) : [];
        if (raw && (parts.length < 2 || parts.length > 3 || parts.some(x => !(x >= 0)))) throw new Error(t('Finish time should look like 3:29:59 or 24:30'));
        const secs = parts.reduce((acc, x) => acc * 60 + x, 0);
        await api('/api/attempts', { body: {
          ...(secs ? { metric: 'time', value: secs, unit: 's' } : {}),
          feat_id: feat, date: box.querySelector('.a-date').value, notes: box.querySelector('.a-notes').value,
          evidence: box.querySelector('.a-evidence').value, verified: box.querySelector('.a-verified').checked ? 1 : 0,
        } });
        toast(t('Logged')); await load(); break;
      }
      case 'sync': case 'sync-full':
        toast(t('Syncing {provider}…', { provider }), 8000);
        { const r = await api(`/api/sync/${provider}`, { body: { full: action === 'sync-full' } }); toast(t.n('{provider}: {n} new of {m}', '{provider}: {n} new of {m}', r.added, { provider, m: num(r.fetched, 0) })); }
        await load(); break;
      case 'sync-all': {
        const ps = Object.entries(S.providers).filter(([, v]) => v.connected).map(([k]) => k);
        if (!ps.length) { toast(t('Nothing connected — see the Connect tab')); ui.tab = 'connect'; render(); break; }
        toast(t('Syncing…'), 8000);
        for (const p of ps) await api(`/api/sync/${p}`, { body: {} });
        toast(t('Synced')); await load(); break;
      }
      case 'import': {
        const file = $('#gfile').files[0];
        if (!file) { toast(t('Choose a .csv or .gpx first')); break; }
        const text = await file.text();
        const r = await api('/api/import/garmin', { body: { format: file.name.toLowerCase().endsWith('.gpx') ? 'gpx' : 'csv', text, units: $('#gunits').value, name: file.name } });
        toast(t.n('Imported {n} new of {m}', 'Imported {n} new of {m}', r.added, { m: num(r.parsed, 0) })); await load(); break;
      }
      case 'export-csv': {
        const head = ['who', 'title', 'event', 'year', 'age', 'category', 'discipline', 'numbers', 'verdict', 'gap_pct', 'eta_weeks', 'detail'];
        const cell = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
        const lines = [head.join(',')].concat(filtered().map(f => {
          const v = S.verdicts[f.id];
          return [f.who, f.title, f.event, f.year, f.age, f.category, f.discipline, f.display,
            statusLabel(v.status), v.gap != null ? Math.round(v.gap * 100) : '', v.eta_weeks ?? '', v.headline].map(cell).join(',');
        }));
        download('celebrity-crusher-ledger.csv', 'text/csv', lines.join('\n'));
        toast(t.n('Exported {n} row', 'Exported {n} rows', filtered().length)); break;
      }
      case 'share-card': shareCard(); break;
      case 'erase-all': {
        if (!window.confirm(t('Erase all Celebrity Crusher data on this device?') + '\n\n' + t('Activities, queue, goals, logged attempts, settings, coaching advice and the sync and Cowork connections are removed. Your Google Drive or sync-folder copy is not touched.'))) break;
        clearTimeout(pushTimer);
        await api('/api/erase', { body: {} });                 // the store: SQLite on the server, the browser blob here
        for (const p of Sync.SYNC_PROVIDERS) await p.disconnect?.().catch?.(() => {});
        await Sync.eraseHandles();                             // remembered sync and Garmin folders
        await eraseCoworkFolder();                             // our Cowork folder, not other apps'
        eraseLocalData(localStorage);                          // our keys only — never localStorage.clear()
        toast(t('Erased from this device. Your Drive or sync-folder copy is untouched.'), 6000);
        setTimeout(() => location.reload(), 1500); break;
      }
      case 'pin-rival': {
        const cur = S.athlete?.settings?.rival;
        await api('/api/athlete', { body: { rival: cur === feat ? null : feat } });
        toast(cur === feat ? t('Rival unpinned') : t('Rival pinned to the dashboard')); await load(); break;
      }
      case 'plan-ics': {
        const weeks = (window.__plans || {})[id];
        if (!weeks?.length) { toast(t('No plan to export')); break; }
        download(`training-plan-${id}.ics`, 'text/calendar', toIcs(weeks));
        toast(t.n('{n} week exported', '{n} weeks exported', weeks.length)); break;
      }
      case 'backup': {
        const data = await api('/api/backup', { method: 'GET' });
        download(`celebrity-crusher-backup-${localYmd()}.json`, 'application/json', JSON.stringify(data, null, 1));
        toast(t('Backup downloaded')); break;
      }
      case 'restore': {
        const file = $('#rfile').files[0];
        if (!file) { toast(t('Choose a backup file first')); break; }
        const r = await api('/api/restore', { body: JSON.parse(await file.text()) });
        toast(t.n('Restored {n} record', 'Restored {n} records', r.restored)); await load(); break;
      }
      case 'sync-now': {
        const cfg = syncCfg();
        toast(t('Syncing…'), 8000);
        const r = await Sync.syncNow(cfg.provider, cfg, api);
        setSyncCfg({ lastSync: r.at, lastNote: 'manual' });
        toast(t.n('Synced · pulled {n} record, pushed {kb} KB', 'Synced · pulled {n} records, pushed {kb} KB', r.restored, { kb: num(Math.max(1, Math.round(r.bytes / 1024)), 0) }));
        await load(); break;
      }
      case 'sync-restore': {
        const cfg = syncCfg();
        const r = await Sync.restoreFrom(cfg.provider, cfg, api);
        toast(r.empty ? t('Nothing stored there yet — sync once to put it there') : t.n('Pulled {n} record', 'Pulled {n} records', r.restored));
        await load(); break;
      }
      case 'sync-disconnect': {
        const cfg = syncCfg();
        await Sync.getSyncProvider(cfg.provider)?.disconnect();
        setSyncCfg({ lastSync: 0, lastNote: '' });
        toast(t('Disconnected')); connect(); break;
      }
      case 'garmin-pick': {
        const name = await Sync.pickGarminFolder();
        const r = await Sync.garminAutoLoad(api, { interactive: true });
        toast(r.skipped ? t('Watching {name} — no Garmin file in it yet', { name }) : t.n('Watching {name} · {n} new of {m}', 'Watching {name} · {n} new of {m}', r.added, { name, m: num(r.parsed, 0) }));
        await load(); break;
      }
      case 'garmin-load': {
        const r = await Sync.garminAutoLoad(api, { interactive: true });
        toast(r.skipped === 'no-folder' ? t('Pick a folder first')
          : r.skipped === 'no-file' ? t('No Garmin file in that folder')
          : r.skipped ? t('Folder permission was refused') : t.n('{n} new of {m} from {file}', '{n} new of {m} from {file}', r.added, { m: num(r.parsed, 0), file: r.file }));
        await load(); break;
      }
      case 'garmin-forget': await Sync.forgetGarminFolder(); toast(t('Folder forgotten')); connect(); break;
      case 'demo': await api('/api/demo', { body: {} }); toast(t('Demo athlete seeded')); await load(); break;
      case 'demo-clear': await api('/api/demo', { body: { clear: true } }); toast(t('Demo data cleared')); await load(); break;
      case 'save-athlete':
        await api('/api/athlete', { body: { name: $('#a-name').value || null, birth_year: +$('#a-year').value || null, weight_kg: +$('#a-weight').value || null, sex: $('#a-sex').value || null } });
        toast(t('Saved')); await load(); break;
    }
  } catch (err) { toast(t('Error: {message}', { message: err.message }), 6000); }
});

document.addEventListener('change', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  try {
    if (action === 'q-status') { await api(`/api/queue/${id}`, { method: 'PATCH', body: { status: el.value } }); await load(); }
    if (action === 'q-date') { await api(`/api/queue/${id}`, { method: 'PATCH', body: { target_date: el.value } }); await load(); }
    if (action === 'goal-date') { await api(`/api/goals/${id}`, { method: 'PATCH', body: { target_date: el.value } }); await load(); }
    if (action === 'sync-provider') { setSyncCfg({ provider: el.value }); connect(); }
    if (action === 'sync-clientid') { setSyncCfg({ driveClientId: el.value.trim() }); toast(t('Client ID saved')); }
    if (action === 'sync-auto') {
      setSyncCfg({ auto: el.checked });
      toast(el.checked ? t('Auto-sync on — it pushes a few seconds after each change') : t('Auto-sync off'));
      if (el.checked) await bootSync();
    }
  } catch (err) { toast(t('Error: {message}', { message: err.message }), 6000); }
});

/** One all-day event per training week. Folded at 74 octets because some clients still care. */
function toIcs(weeks) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fold = line => line.match(/.{1,73}/g).join('\r\n ');
  const esc2 = s => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const body = weeks.map(w => {
    const d = w.start.replace(/-/g, '');
    const next = new Date(w.start + 'T00:00:00'); next.setDate(next.getDate() + 1);
    const end = localYmd(next).replace(/-/g, '');
    return ['BEGIN:VEVENT', `UID:cc-w${w.week}-${d}@celebrity-crusher`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
      fold('SUMMARY:' + esc2(t('Week {n} · {phase} · {dist}', { n: num(w.week, 0), phase: phaseLabel(w.phase), dist: kmText(w.km) }))),
      fold('DESCRIPTION:' + esc2(t('Long run {dist}. {sessions}', { dist: kmText(w.long_km), sessions: w.sessions.join('. ') }))),
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
    <p class="eyebrow">${t('Log an attempt')}</p>
    <div class="controls" style="margin-top:.5rem">
      <label class="field">${t('Date')}<input type="date" class="a-date" value="${localYmd()}"></label>
      <label class="field">${t('Evidence URL')}<input type="text" class="a-evidence" placeholder="${esc(t('race result, Strava link, video'))}"></label>
      ${S.feats.find(x => x.id === featId)?.check.kind === 'run_time' ? `<label class="field">${t('Finish time')}<input type="text" class="a-time" placeholder="${esc(t('h:mm:ss'))}" size="8"></label>` : ''}
      <label class="field">${t('Notes')}<input type="text" class="a-notes" placeholder="${esc(t('what actually happened'))}"></label>
      <label class="tiny dim"><input type="checkbox" class="a-verified" checked> ${t('counts as proof')}</label>
      <button class="btn primary" data-action="attempt-save" data-feat="${featId}">${t('Save')}</button>
    </div>
    <p class="tiny faint">${t('A verified attempt marks the feat crushed regardless of what the projection says — the logbook outranks the model. A finish time also calibrates every future projection against what you actually ran.')}</p>
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

document.addEventListener('app-theme-change', () => { if (S) render(); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== ui.tab && tabs().some(([id]) => id === h)) { ui.tab = h; render(); } });
// Translations first (font.js loads the reader's language), so the first paint is already in it.
(window.appFont?.ready || Promise.resolve()).catch(() => {}).then(load).then(bootSync)
  .catch(e => { document.querySelector('main').innerHTML = `<p class="notice">${esc(t('Could not load state: {message}', { message: e.message }))}</p>`; });
