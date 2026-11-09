// Pure assembly of the ledger, so the same code runs in Node (fs) and the browser (fetch).
export function assemble(lists) {
  const FEATS = lists.flat();
  const seen = new Set();
  for (const f of FEATS) {
    if (seen.has(f.id)) throw new Error(`duplicate feat id: ${f.id}`);
    seen.add(f.id);
    if (!f.check?.kind) throw new Error(`feat ${f.id} has no check`);
  }
  const BY_ID = new Map(FEATS.map(f => [f.id, f]));
  const CATEGORIES = [...new Set(FEATS.map(f => f.category))];
  const DISCIPLINES = [...new Set(FEATS.map(f => f.discipline))];
  const stats = () => ({
    total: FEATS.length,
    computable: FEATS.filter(f => f.check.kind !== 'manual').length,
    logbook: FEATS.filter(f => f.check.kind === 'manual').length,
    references: FEATS.filter(f => f.reference).length,
    celebrities: new Set(FEATS.filter(f => !f.reference).map(f => f.who)).size,
    categories: CATEGORIES.length,
  });
  return { FEATS, BY_ID, CATEGORIES, DISCIPLINES, stats };
}

/** The four data files, in load order. Both loaders read this list. */
export const FILES = ['feats-ledger.json', 'feats-extra.json', 'feats-extra2.json', 'feats-extra3.json'];
