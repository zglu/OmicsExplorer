// Colour system.
//
//  * cell types have a curated palette so a cell type keeps its colour in
//    every plot, legend and table;
//  * every other grouping (sample, stage, cluster, ...) gets its own palette,
//    and a category keeps the same colour everywhere because the palette index
//    comes from the group's COMPLETE category list, not from the position in
//    the currently shown rows.

export const VIRIDIS = [
  '#440154','#440256','#450457','#450559','#46075a','#46085c','#460a5d','#460b5e',
  '#470d60','#470e61','#471063','#471164','#471365','#481467','#481668','#481769',
  '#48186a','#481a6c','#481b6d','#481c6e','#481d6f','#481f70','#482071','#482173',
  '#482374','#482475','#482576','#482677','#482878','#482979','#472a7a','#472c7a',
  '#472d7b','#472e7c','#472f7d','#46307e','#46327e','#46337f','#463480','#453581',
  '#453781','#453882','#443983','#443a83','#443b84','#433d84','#433e85','#423f85',
  '#424086','#424186','#414287','#414487','#404588','#404688','#3f4788','#3f4889',
  '#3e4989','#3e4a89','#3e4c8a','#3d4d8a','#3d4e8a','#3c4f8a','#3c508b','#3b518b',
  '#3b528b','#3a538b','#3a548c','#39558c','#39568c','#38588c','#38598c','#375a8c',
  '#375b8c','#365c8d','#365d8d','#355e8d','#355f8d','#34608d','#34618d','#33628d',
  '#33628d','#32648e','#32658e','#31668e','#31678e','#31688e','#30698e','#306a8e',
  '#2f6b8e','#2f6c8e','#2e6d8e','#2e6e8e','#2e6f8e','#2d708e','#2d718e','#2c718e',
  '#2c728e','#2c738e','#2b748e','#2b758e','#2a768e','#2a778e','#2a788e','#29798e',
  '#297a8e','#297b8e','#287c8e','#287d8e','#277e8e','#277f8e','#27808e','#26818e',
  '#26828e','#26828e','#25838e','#25848e','#25858e','#24868e','#24878e','#23888e',
  '#23898e','#238a8d','#228b8d','#228c8d','#228d8d','#218e8d','#218f8d','#21908d',
  '#21918c','#20928c','#20928c','#20938c','#1f948c','#1f958b','#1f968b','#1f978b',
  '#1f988b','#1f998a','#1f9a8a','#1e9b8a','#1e9c89','#1e9d89','#1f9e89','#1f9f88',
  '#1fa088','#1fa188','#1fa187','#1fa287','#20a386','#20a486','#21a585','#21a685',
  '#22a785','#22a884','#23a983','#24aa83','#25ab82','#25ac82','#26ad81','#27ad81',
  '#28ae80','#29af7f','#2ab07f','#2cb17e','#2db17d','#2eb37c','#2fb47c','#31b57b',
  '#32b67a','#34b679','#35b779','#37b878','#38b977','#3aba76','#3bbb75','#3dbc74',
  '#3fbc73','#40bd72','#42be71','#44bf70','#46c06f','#48c16e','#4ac16d','#4cc26c',
  '#4ec36b','#50c46a','#52c569','#54c568','#56c667','#58c765','#5ac864','#5cc863',
  '#5ec962','#60ca60','#63cb5f','#65cb5e','#67cc5c','#69cd5b','#6ccd5a','#6ece58',
  '#70cf57','#73d056','#75d054','#77d153','#7ad151','#7cd250','#7fd34e','#81d34d',
  '#84d44b','#86d549','#89d548','#8bd646','#8ed645','#90d743','#93d741','#95d840',
  '#98d83e','#9bd93c','#9dd93b','#a0da39','#a2da37','#a5db36','#a8db34','#aadc32',
  '#addc30','#b0dd2f','#b2dd2d','#b5de2b','#b8de28','#bade28','#bddf26','#c0df25',
  '#c2df23','#c5e021','#c8e020','#cae11f','#cde11d','#d0e11c','#d2e21b','#d5e21a',
  '#d8e219','#dae319','#dde318','#dfe318','#e2e418','#e5e419','#e7e419','#eae51a',
  '#ece51b','#efe51c','#f1e51d','#f4e61e','#f6e620','#f8e621','#fbe723','#fde725',
];

export const CURATED = {
  // liver flukes / nematodes
  vitellocyte: '#c0392b', 'vitellocyte.early': '#e74c3c', 'vitellocyte.late': '#a93226',
  'vitellocyte.early-late': '#922b21', 'vitellocyte.late-mature': '#884ea0',
  'vitellocyte.mature': '#7d3c98',
  spermatocyte: '#2e86de', spermatocyte_diffuse: '#5dade2', spermatogonia: '#85c1e9',
  oocyte: '#8e44ad', oogonia: '#9b59b6', germline_stem: '#a569bd',
  'germline progenitors': '#bb8fce', GSC: '#e67e22', uterus: '#e84393',
  'uterus/reproductive tract': '#fd79a8', 'seminal_receptacle': '#bd8c5e',
  neuron: '#f1c40f', muscle: '#d35400', 'muscle_ventral-sucker': '#e67e22',
  parenchyma: '#27ae60', tegument: '#16a085', 'tegument progenitor': '#1abc9c',
  tegument_progenitor: '#1abc9c', gut: '#0e6655', gut_pharynx: '#148f77',
  'gut-associated secretory/immune': '#52be80', Mehlis_gland: '#7f8c8d',
  'Mehlis gland': '#839192', ovary: '#c39bd3', S1: '#b7950b', 'S1 progeny': '#f4d03f',
  'neoblast&progeny': '#d7bde2', 'neoblast progeny': '#d7bde2', neoblast: '#af7ac5',
  somatic: '#95a5a6', low_quality: '#5d6d7e', proliferating: '#f7dc6f',
  unknown: '#abb2b9', ambiguous: '#aeb6bf', ambiguous1: '#aeb6bf', ambiguous2: '#85929e',
  flame: '#48c9b0', 'flame cell': '#48c9b0', 'mehlis gland': '#839192',
  'female late': '#fd79a8', 'male late': '#5dade2',
  'L2_parenchyma': '#27ae60', 'L10_tegument': '#16a085',
  excretory: '#7f8c8d', 'flame cell ': '#48c9b0',
  // Haemonchus contortus
  '?': '#b0b6bd',
  'Anterior intestine+neuronal': '#0e7c6b', 'Posterior intestine': '#0e6655',
  'Intestinal/Excretory': '#148f77',
  'Apoptotic germ cells': '#b294c7', 'Germ cells': '#8e44ad',
  Embryonic: '#d1a5f2', 'Gonadal sheath': '#c39bd3',
  Spermatheca: '#c77dd6', Spermatids: '#2e86de',
  'Spermatozoa+neuronal': '#5dade2',
  Muscle: '#d35400', 'Muscle-L4': '#e67e22', 'Neuronal+muscle': '#9c6a1c',
  Neuronal: '#f1c40f', 'Neuronal-L3': '#eeb90a', 'Neuaaronal-L3': '#e0b33f',
  Pharyngeal: '#8bc34a', 'Seam?': '#48c9b0',
  // stages
  Adult: '#e8734c', L3: '#4c9be8', L4: '#3fb984',
};

export const GROUP_PALETTE = [
  '#4c9be8', '#e8734c', '#3fb984', '#c77dd6', '#e0b33f', '#4bc7c7',
  '#d96b9a', '#9aa8e0', '#8fbf3f', '#e05c5c', '#5c9de0', '#b08968',
];

export const CLUSTER_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948',
  '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#1b9e77', '#d95f02',
  '#7570b3', '#e7298a', '#66a61e', '#a6761d', '#6b6b6b', '#3b6ea5',
  '#c49c94', '#aec7e8', '#98df8a', '#ffbb78',
];

const CLUSTER_GROUPS = new Set(['rpca_clusters', 'cluster', 'leiden', 'clusters']);
const CLUSTER_HINTS = ['cluster', 'leiden'];

const groupColorMaps = new Map();
const catCache = new Map();
const clusterCatColors = new Map();

function hsl(hue, sat, light) {
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; } else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; } else { r = c; b = x; }
  const to2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${to2(r + m)}${to2(g + m)}${to2(b + m)}`;
}

/** Golden-angle hues for groups with more categories than the base palette. */
export function paletteColor(i) {
  if (i < GROUP_PALETTE.length) return GROUP_PALETTE[i];
  return hsl((i * 137.508 + 205) % 360, 0.62, 0.56);
}

export function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return hsl(h % 360, 0.62, 0.62);
}

export function isClusterGroup(group) {
  if (CLUSTER_GROUPS.has(group)) return true;
  const low = String(group).toLowerCase();
  return CLUSTER_HINTS.some((h) => low.includes(h));
}

export function groupColorMap(group) {
  if (!groupColorMaps.has(group)) groupColorMaps.set(group, new Map());
  return groupColorMaps.get(group);
}

/** Register a group's categories (in data order) so their colours are stable. */
export function registerGroupColors(group, cats) {
  const map = groupColorMap(group);
  const cluster = isClusterGroup(group);
  cats.forEach((c) => {
    if (map.has(c)) return;
    const colour = cluster
      ? CLUSTER_PALETTE[map.size % CLUSTER_PALETTE.length]
      : paletteColor(map.size);
    map.set(c, colour);
    if (cluster) clusterCatColors.set(c, colour);
  });
  return map;
}

export function groupColorFor(group, cat, fallbackIndex = 0) {
  const map = groupColorMap(group);
  if (map.has(cat)) return map.get(cat);
  return isClusterGroup(group)
    ? CLUSTER_PALETTE[(fallbackIndex || 0) % CLUSTER_PALETTE.length]
    : paletteColor(fallbackIndex);
}

/** The colour of one category of a grouping. */
export function catColor(cat) {
  if (!cat) return '#888';
  if (catCache.has(cat)) return catCache.get(cat);
  let colour;
  if (CURATED[cat]) colour = CURATED[cat];
  else if (clusterCatColors.has(cat)) colour = clusterCatColors.get(cat);
  else colour = hashColor(cat);
  catCache.set(cat, colour);
  return colour;
}

// ----------------------------------------------------------------- colours

export function hex2rgb(hex) {
  let h = String(hex).trim();
  if (h.startsWith('hsl')) {
    const m = h.match(/hsl\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s));
      const [hue, sat, light] = parts;
      const c = (1 - Math.abs(2 * light - 1)) * sat;
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
      const mm = light - c / 2;
      let r = 0, g = 0, b = 0;
      if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; }
      else if (hue < 180) { g = c; b = x; } else if (hue < 240) { g = x; b = c; }
      else if (hue < 300) { r = x; b = c; } else { r = c; b = x; }
      return [Math.round((r + mm) * 255), Math.round((g + mm) * 255), Math.round((b + mm) * 255)];
    }
  }
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [136, 136, 136];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex, alpha) {
  const [r, g, b] = hex2rgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Pick black or white text for a coloured background. */
export function chipTextColor(hex) {
  const [r, g, b] = hex2rgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#111' : '#fff';
}

/** Lighten / darken a colour so a label stays readable on top of it. */
export function lightenForLabel(hex, amount = 0.35) {
  const [r, g, b] = hex2rgb(hex);
  const mix = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

export function darkenForLabel(hex, amount = 0.35) {
  const [r, g, b] = hex2rgb(hex);
  const mix = (v) => Math.round(v * (1 - amount));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// ------------------------------------------------------------------ themes

export function isLightTheme() {
  return document.documentElement.dataset.theme === 'light';
}

export function canvasTheme() {
  const light = isLightTheme();
  return light
    ? {
        bg: '#ffffff',
        panel: '#f7f8fa',
        fg: '#1b1f24',
        muted: '#6a7280',
        line: '#d9dee5',
        grid: '#eceff3',
        zero: '#e9edf2',
        accent: '#1f6feb',
        selection: '#ffd166',
        label: '#111827',
      }
    : {
        bg: '#0e1116',
        panel: '#161b22',
        fg: '#e6edf3',
        muted: '#8b949e',
        line: '#2a3038',
        grid: '#1e242c',
        zero: '#1a1f26',
        accent: '#58a6ff',
        selection: '#f0b429',
        label: '#f0f6fc',
      };
}

/** Sequential colour schemes for expression values. */
export const SCHEMES = {
  viridis: VIRIDIS,
  magma: ['#000004','#1c1044','#4f0a6b','#781c6d','#a52c60','#cf4446','#ed6925','#fb9b06','#f7d13d','#fcffa4'],
  inferno: ['#000004','#1b0c41','#4a0c6b','#781c6d','#a52c60','#cf4446','#ed6925','#fb9b06','#f7d13d','#fcffa4'],
  plasma: ['#0d0887','#46039f','#7201a8','#9c179e','#bd3786','#d8576b','#ed7953','#fb9f3a','#fdca26','#f0f921'],
  turbo: ['#30123b','#4145ab','#4675ed','#39a2fc','#1bcfd4','#24eca6','#61fc6c','#a4fc3b','#d1e834','#f3c63a','#fe9b2d','#f36315','#d93806','#b11901','#7a0402'],
  cividis: ['#00204c','#00336f','#39486b','#575d6d','#707173','#8a8678','#a59c74','#c3b369','#e1cc55','#fee838'],
};

/** The colour of a sequential ramp at t in [0, 1] (the dots of the gene
 *  dotplots and the expression colouring of the cells use the same ramps). */
export function rampColor(ramp, t) {
  const idx = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
  return ramp[idx];
}

export function schemeColors(name) {
  const ramp = SCHEMES[name] || VIRIDIS;
  const n = ramp.length;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = hex2rgb(ramp[i]);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}
