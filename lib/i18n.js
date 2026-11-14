// Translation and formatting, in one place for the engine and the app (house standard 20).
// In the browser it hands off to font.js (appFont.t, appFont.fmt): the reader's language, units
// (metric / imperial), and number style. In Node (server.mjs, test.mjs) there is no appFont, so
// it falls back to English and metric — the same text the engine always produced.
// The English IS the key: write t('Need {pace} for {dist}', { pace, dist }), never concatenate.
const A = () => globalThis.appFont;
const interp = (s, p) => p ? String(s).replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(p, k) ? String(p[k]) : m) : String(s);

export const t = (key, params) => A()?.t ? A().t(key, params) : interp(key, params);
t.n = (one, other, n, params) => A()?.t?.n ? A().t.n(one, other, n, params) : interp(n === 1 ? one : other, { n, ...params });

const imperial = () => A()?.units?.() === 'imperial';
const MI = 1609.344;

/** A number in the reader's style. */
export const num = (n, max = 1) => A()?.fmt ? A().fmt.number(n, { max }) : (Math.round(n * 10 ** max) / 10 ** max).toString();
/** 0.42 -> "42%". */
export const percent = x => A()?.fmt ? A().fmt.percent(x) : `${Math.round(x * 100)}%`;
/** Metres -> "12.4 km" / "7.7 mi" (or m / ft when short). */
export function dist(m, max) {
  if (A()?.fmt) return A().fmt.distance(m, max ?? (Math.abs(m) >= 100000 ? 0 : 1));
  return m >= 1000 ? `${(m / 1000).toFixed(max ?? (m < 100000 ? 1 : 0))} km` : `${Math.round(m)} m`;
}
/** Metres of climbing -> "1,234 m" / "4,049 ft". */
export const height = m => A()?.fmt ? (imperial() ? A().fmt.unit(m * 3.28084, 'foot', 0) : A().fmt.unit(m, 'meter', 0)) : `${Math.round(m).toLocaleString('en')} m`;
/** Seconds per km -> "4:30/km" or "7:15/mi" in the reader's units. */
export function pace(secPerKm) {
  const s = imperial() ? secPerKm * MI / 1000 : secPerKm;
  const mmss = `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return imperial() ? t('{time}/mi', { time: mmss }) : t('{time}/km', { time: mmss });
}
/** A Date -> the reader's medium date. */
export const date = d => A()?.fmt ? A().fmt.date(d) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** A Date -> short month and year, for chart axes ("Mar 26"). */
export const monthYear = d => A()?.fmt ? A().fmt.custom(d, { month: 'short', year: '2-digit' }) : d.toISOString().slice(2, 7);
/** Unit label for weekly volume tables and plans: "km" or "mi". */
export const distUnit = () => imperial() ? t('mi') : t('km');
/** Metres in the reader's unit, as a plain number (charts, plan tables). */
export const inUnit = m => imperial() ? m / MI : m / 1000;
