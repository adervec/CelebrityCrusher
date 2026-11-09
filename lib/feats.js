// The ledger, Node side. feats-ledger.json is generated from the original artifact;
// the feats-extra*.json files are the expansion packs. All plain data — edit freely.
// The browser loads the same files over fetch; see public/local.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble, FILES } from './feats-core.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const { FEATS, BY_ID, CATEGORIES, DISCIPLINES, stats } =
  assemble(FILES.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))));
