// Gene search and resolution.
//
// The search accepts a lot of shapes because different projects name their
// genes differently: full ids ("CRM22_000123"), ids with a dash
// ("CRM22-000123"), the bare numeric suffix ("123"), or a product
// description.

import { fetchJSON, normaliseFeature, state } from './data.js';

let geneIndex = null; // {geneId: {panels: [...]}}
let geneDetails = null; // {geneId: {product, ...}}

export async function ensureGeneIndex(bust = false) {
  if (geneIndex && !bust) return geneIndex;
  try {
    geneIndex = (await fetchJSON('data/genes.json', { bust })).genes || {};
  } catch (err) {
    console.warn('no gene index found', err);
    geneIndex = {};
  }
  return geneIndex;
}

export async function ensureGeneDetails() {
  if (geneDetails) return geneDetails;
  try {
    geneDetails = await fetchJSON('data/gene_details.json');
  } catch (err) {
    geneDetails = {};
  }
  return geneDetails;
}

/** All known gene ids. */
export function allGenes() {
  return geneIndex ? Object.keys(geneIndex) : [];
}

/** Every spelling of a gene id we accept. */
export function geneAliases(gene) {
  const base = String(gene);
  const out = new Set([base, base.toUpperCase()]);
  out.add(base.replace(/_/g, '-'));
  out.add(base.replace(/-/g, '_'));
  return Array.from(out);
}

/**
 * Score a candidate gene against the query.  Higher is better, 0 means no
 * match at all.
 */
export function geneScore(gene, query) {
  const g = gene.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (g === q) return 100;
  if (g.replace(/_/g, '-') === q.replace(/_/g, '-')) return 95;
  if (g.startsWith(q)) return 80;
  // "4783" should match "CRM22_00004783"
  const m = q.match(/^(.*?)(\d+)$/);
  if (m) {
    const prefix = m[1];
    const digits = m[2].replace(/^0+(?=\d)/, '');
    if (!prefix) {
      const tail = g.match(/(\d+)$/);
      if (tail && tail[1].replace(/^0+(?=\d)/, '') === digits) return 70;
    } else if (g.startsWith(prefix.toLowerCase())) {
      const tail = g.match(/(\d+)$/);
      if (tail && tail[1].replace(/^0+(?=\d)/, '') === digits) return 75;
    }
  }
  if (g.includes(q)) return 40;
  const detail = geneDetailScore(gene, q);
  return detail;
}

/**
 * Score a gene by its product description (only when the bundle carries one).
 */
export function geneDetailScore(gene, query) {
  if (!geneDetails) return 0;
  const entry = geneDetails[gene];
  if (!entry) return 0;
  const product = String(entry.product || entry.description || '').toLowerCase();
  const q = query.toLowerCase();
  if (!product) return 0;
  if (product === q) return 62;
  if (product.startsWith(q)) return 50;
  if (product.includes(q)) return 30;
  return 0;
}

/** Suggest genes for a partially typed query. */
export function searchGenes(query, limit = 12) {
  if (!geneIndex) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const scored = [];
  for (const gene of Object.keys(geneIndex)) {
    const score = geneScore(gene, q);
    if (score > 0) scored.push({ gene, score });
  }
  scored.sort((a, b) => b.score - a.score || a.gene.length - b.gene.length || a.gene.localeCompare(b.gene));
  return scored.slice(0, limit).map((s) => s.gene);
}

/**
 * All genes that start with the query (dash/underscore spelling agnostic).
 * Powers the "prefix finds several genes" behaviour of the search: typing
 * 'Smp-' or 'CRM22_' adds every matching gene instead of failing.
 */
export function prefixGenes(query, limit = 50) {
  if (!geneIndex) return [];
  const q = normaliseFeature(String(query || '').trim());
  if (!q || q.length < 2) return [];
  const spellings = new Set([q, q.replace(/_/g, '-'), q.replace(/-/g, '_')]);
  const hits = [];
  for (const gene of Object.keys(geneIndex)) {
    const g = normaliseFeature(gene);
    for (const spelling of spellings) {
      if (g.startsWith(spelling)) {
        hits.push(gene);
        break;
      }
    }
  }
  hits.sort((a, b) => (geneIndex[b].panels?.length || 0) - (geneIndex[a].panels?.length || 0) || a.localeCompare(b));
  return hits.slice(0, limit);
}

/**
 * Resolve a user query to a single gene id, or null.
 */
export function resolveGene(query) {
  if (!geneIndex) return null;
  const q = String(query || '').trim();
  if (!q) return null;
  const genes = Object.keys(geneIndex);

  // exact (any spelling)
  const norm = normaliseFeature(q);
  for (const gene of genes) if (normaliseFeature(gene) === norm) return gene;

  // unique prefix of at least 4 characters
  if (q.length >= 4) {
    const prefix = genes.filter((g) => normaliseFeature(g).startsWith(norm));
    if (prefix.length === 1) return prefix[0];
  }

  // bare numeric suffix
  const numeric = q.match(/^(.*?)(\d+)$/);
  if (numeric) {
    const digits = numeric[2].replace(/^0+(?=\d)/, '');
    const prefix = numeric[1] ? normaliseFeature(numeric[1]) : '';
    const hits = genes.filter((g) => {
      const gn = normaliseFeature(g);
      if (prefix && !gn.startsWith(prefix)) return false;
      const tail = gn.match(/(\d+)$/);
      return tail && tail[1].replace(/^0+(?=\d)/, '') === digits;
    });
    if (hits.length === 1) return hits[0];
  }

  // unique substring
  const substr = genes.filter((g) => normaliseFeature(g).includes(norm));
  if (substr.length === 1) return substr[0];

  return null;
}

/** Panels that contain a given gene. */
export function panelsForGene(gene) {
  if (!geneIndex || !geneIndex[gene]) return [];
  const ids = geneIndex[gene].panels || [];
  // show the dataset names (the ids can be cryptic, e.g. "converted")
  const panels = state.project?.panels || [];
  return ids.map((id) => {
    const panel = panels.find((p) => p.id === id);
    return panel ? panel.name || id : id;
  });
}

/** Product description of a gene, when the bundle carries one. */
export function geneProduct(gene) {
  if (!geneDetails) return '';
  const entry = geneDetails[gene];
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.product || entry.description || '';
}
