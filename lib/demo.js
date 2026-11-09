// Deterministic demo athlete so the dashboards have something to chew on before
// any OAuth happens. Roughly the ledger's own projected runner: ~3:30 marathon
// shape, 60-70 km weeks, a bike habit and an occasional swim.
// ponytail: seeded PRNG, no fixtures library.

const mulberry32 = a => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

export function demoActivities(now = Date.now() / 1000, weeks = 78) {
  const rnd = mulberry32(20260913);
  const acts = [], efforts = [];
  const start = now - weeks * 7 * 86400;
  for (let w = 0; w < weeks; w++) {
    const progress = w / weeks;                       // fitness builds over the block
    const base = 42 + 28 * progress;                  // weekly km
    const weekKm = base * (0.9 + rnd() * 0.3) * (w % 8 === 7 ? 0.6 : 1);    // down week every 8th
    const paceEasy = 330 - 28 * progress;             // s/km, easy runs
    const sessions = [
      { frac: 0.30 + 0.06 * progress, pace: paceEasy * 1.0, name: 'Long run' },   // builds toward 30 km+
      { frac: 0.18, pace: paceEasy * 0.86, name: 'Threshold' },
      { frac: 0.16, pace: paceEasy * 1.03, name: 'Easy' },
      { frac: 0.18, pace: paceEasy * 1.02, name: 'Easy' },
      { frac: 0.18, pace: paceEasy * 0.92, name: 'Intervals' },
    ];
    sessions.forEach((s, i) => {
      if (rnd() < 0.08) return;                        // life happens
      const km = weekKm * s.frac * (0.9 + rnd() * 0.2);
      const ts = Math.floor(start + (w * 7 + i * 1.4) * 86400 + 7 * 3600);
      const moving = Math.round(km * s.pace * (0.98 + rnd() * 0.05));
      acts.push({
        id: `demo:run:${w}:${i}`, provider: 'demo', sport: 'run', start_ts: ts,
        distance_m: Math.round(km * 1000), moving_s: moving, elapsed_s: moving + 60,
        elev_m: Math.round(km * (6 + rnd() * 14)),
        avg_hr: Math.round(138 + (s.name === 'Intervals' ? 22 : s.name === 'Threshold' ? 14 : 0) + rnd() * 6),
        max_hr: Math.round(168 + rnd() * 18), name: s.name,
      });
    });
    if (rnd() < 0.75) {                                 // a weekend ride
      const km = 45 + rnd() * 55 + 30 * progress;
      const ts = Math.floor(start + (w * 7 + 6) * 86400 + 8 * 3600);
      acts.push({
        id: `demo:ride:${w}`, provider: 'demo', sport: 'ride', start_ts: ts,
        distance_m: Math.round(km * 1000), moving_s: Math.round(km * 1000 / (7.2 + rnd() * 1.6)),
        elapsed_s: Math.round(km * 1000 / 7), elev_m: Math.round(km * (8 + rnd() * 12)),
        avg_hr: Math.round(132 + rnd() * 10), max_hr: Math.round(165 + rnd() * 15), name: 'Ride',
      });
    }
    if (rnd() < 0.35) {
      const m = 1200 + rnd() * 1600;
      acts.push({
        id: `demo:swim:${w}`, provider: 'demo', sport: 'swim', start_ts: Math.floor(start + (w * 7 + 3) * 86400 + 19 * 3600),
        distance_m: Math.round(m), moving_s: Math.round(m / 0.85), elapsed_s: Math.round(m / 0.8),
        elev_m: 0, avg_hr: null, max_hr: null, name: 'Pool',
      });
    }
  }
  // three races, with measured best efforts, improving through the block
  const races = [
    { km: 21.0975, s: 6180, weeksAgo: 52, name: 'Half marathon' },
    { km: 10, s: 2670, weeksAgo: 30, name: '10 km' },
    { km: 21.0975, s: 5850, weeksAgo: 9, name: 'Half marathon' },
    { km: 32, s: 10080, weeksAgo: 5, name: 'Long run, 32 km' },
  ];
  races.forEach((r, i) => {
    const ts = Math.floor(now - r.weeksAgo * 7 * 86400);
    const id = `demo:race:${i}`;
    acts.push({
      id, provider: 'demo', sport: 'run', start_ts: ts, distance_m: Math.round(r.km * 1000),
      moving_s: r.s, elapsed_s: r.s, elev_m: Math.round(r.km * 5), avg_hr: 172, max_hr: 186, name: r.name,
    });
    efforts.push({ activity_id: id, distance_m: Math.round(r.km * 1000), seconds: r.s, start_ts: ts });
    if (r.km >= 21) efforts.push({ activity_id: id, distance_m: 10000, seconds: Math.round(r.s / r.km * 10 * 0.97), start_ts: ts });
    efforts.push({ activity_id: id, distance_m: 5000, seconds: Math.round(r.s / r.km * 5 * 0.95), start_ts: ts });
  });
  return { activities: acts.sort((a, b) => a.start_ts - b.start_ts), efforts };
}
