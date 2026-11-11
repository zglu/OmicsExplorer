// Grouping maths: category counts, the canonical cell-type ontology and the
// per-sample composition.

import { state } from './data.js';
import { naturalCompare } from './util.js';

const compCache = new Map();

/** The categories of a grouping (already sorted naturally by the converter). */
export function categoriesOf(ds, group) {
  return ds.categories[group] || [];
}

/** The category code of every cell. */
export function codesOf(ds, group) {
  return ds.codes.get(group) || null;
}

/**
 * Counts per category of a grouping.
 * Returns {cats, counts, total} where counts[i] is the number of cells in
 * category i.
 */
export function groupCounts(ds, group) {
  const key = `${ds.id}::${group}`;
  if (compCache.has(key)) return compCache.get(key);
  const cats = categoriesOf(ds, group);
  const codes = codesOf(ds, group);
  const counts = new Int32Array(cats.length);
  let total = 0;
  if (codes) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c >= 0 && c < counts.length) {
        counts[c]++;
        total++;
      }
    }
  }
  const result = { cats, counts, total };
  compCache.set(key, result);
  return result;
}

/**
 * A canonical cell type for every category of a grouping.
 * Returns {cats, codes} where cats are the canonical names (in first-seen
 * order) and codes[i] is the canonical index of cell i (-1 when unknown).
 */
export function canonicalOf(ds, group) {
  const ontology = state.ontology || {};
  const lookup = new Map();
  for (const [canonical, aliases] of Object.entries(ontology)) {
    for (const alias of aliases || []) lookup.set(String(alias).toLowerCase(), canonical);
    lookup.set(String(canonical).toLowerCase(), canonical);
  }
  const cats = categoriesOf(ds, group);
  const codes = codesOf(ds, group);
  const catIndex = new Map();
  const outCats = [];
  const outCodes = new Int32Array(ds.n).fill(-1);
  cats.forEach((cat, i) => {
    const canonical = lookup.get(String(cat).toLowerCase()) || cat;
    if (!catIndex.has(canonical)) {
      catIndex.set(canonical, outCats.length);
      outCats.push(canonical);
    }
    outCodes[i] = catIndex.get(canonical);
  });
  if (codes) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      outCodes[i] = c >= 0 ? outCodes[c] : -1;
    }
  }
  return { cats: outCats, codes: outCodes };
}

/**
 * The canonical grouping for a dataset, when the ontology knows something
 * about it; otherwise the dataset's own cell-type grouping.
 */
export function canonicalGroup(ds) {
  const preferred = ['cell_type', 'cell_type_manual', 'celltype', 'cell_type_leiden'];
  for (const name of preferred) {
    if (ds.categories[name]) return name;
  }
  return ds.groupNames[0] || null;
}

/** The categories sorted by abundance (descending). */
export function sortedByCount(ds, group) {
  const { cats, counts } = groupCounts(ds, group);
  const order = cats.map((c, i) => i).sort((a, b) => counts[b] - counts[a] || naturalCompare(cats[a], cats[b]));
  return { cats: order.map((i) => cats[i]), counts: order.map((i) => counts[i]), order };
}

/**
 * Composition of a dataset by category across a second grouping (usually the
 * sample).  Returns {rows: [{label, values: Float64Array, total}], cats}.
 */
export function compositionAcross(ds, rowGroup, colGroup) {
  const rowCats = categoriesOf(ds, rowGroup);
  const colCats = categoriesOf(ds, colGroup);
  const rowCodes = codesOf(ds, rowGroup);
  const colCodes = codesOf(ds, colGroup);
  const rows = colCats.map((label) => ({ label, values: new Float64Array(rowCats.length), total: 0 }));
  if (rowCodes && colCodes) {
    for (let i = 0; i < ds.n; i++) {
      const r = rowCodes[i];
      const c = colCodes[i];
      if (r < 0 || c < 0) continue;
      rows[c].values[r]++;
      rows[c].total++;
    }
  }
  return { rows, cats: rowCats };
}

export function clearCompositionCache() {
  compCache.clear();
}
