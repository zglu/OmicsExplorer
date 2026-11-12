// The "Add dataset" dialog: open another h5ad from the UI.
//
// Two sources are supported:
//   * an upload - the browser POSTs the raw file, the server stores it under
//     <project>/uploads/ and discovers it;
//   * a path on the machine that runs the server.
//
// After discovery the user picks the groupings and embeddings to expose, and
// the server converts + registers the dataset in the background; the app then
// integrates it through the ``onAdded`` callback.

import { fetchJSON } from './data.js';
import { el, esc, toast } from './util.js';
import { isLocalMode } from './localfetch.js';

const dialog = {
  open: false,
  path: null,
  info: null,
  job: null,
  poll: null,
  onAdded: null,
};

export function initAddData({ onAdded }) {
  dialog.onAdded = onAdded;
  const btn = document.getElementById('add-data');
  if (!btn) return;
  btn.addEventListener('click', openDialog);
  adaptDialogToMode();

  document.getElementById('add-close').addEventListener('click', closeDialog);
  document.getElementById('add-dialog').addEventListener('click', (ev) => {
    if (ev.target.id === 'add-dialog') closeDialog();
  });

  document.querySelectorAll('.add-tabs button').forEach((tab) => {
    tab.addEventListener('click', () => showPane(tab.dataset.pane));
  });

  // -- upload --------------------------------------------------------------
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('upload-input');
  document.getElementById('upload-browse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) uploadFile(file);
  });
  zone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    zone.classList.remove('drag');
    const files = ev.dataTransfer?.files;
    if (files && files.length) uploadFile(files[0]);
  });

  // -- server path ---------------------------------------------------------
  if (isLocalMode()) {
    // no server: only the upload pane exists
    document.querySelectorAll('.add-tabs button[data-pane="path"]').forEach((tab) => {
      tab.style.display = 'none';
    });
    const tabUpload = document.querySelector('.add-tabs button[data-pane="upload"]');
    if (tabUpload) tabUpload.classList.add('active');
  }
  document.getElementById('path-scan').addEventListener('click', () => {
    scanPath(document.getElementById('path-input').value);
  });
  document.getElementById('path-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') scanPath(ev.target.value);
  });
}

function showPane(name) {
  document.querySelectorAll('.add-tabs button').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
  document.getElementById('add-pane-upload').style.display = name === 'upload' ? '' : 'none';
  document.getElementById('add-pane-path').style.display = name === 'path' ? '' : 'none';
}

async function openDialog() {
  if (!(await stateHasProject())) {
    toast('This build cannot add datasets - serve the project with `omicsexplorer serve`.');
    return;
  }
  document.getElementById('add-dialog').style.display = 'flex';
  document.getElementById('add-info').style.display = 'none';
  document.getElementById('add-info').innerHTML = '';
  document.getElementById('add-progress').style.display = 'none';
  showPane('upload');
  dialog.open = true;
}

function closeDialog() {
  document.getElementById('add-dialog').style.display = 'none';
  dialog.open = false;
  if (dialog.poll) {
    clearInterval(dialog.poll);
    dialog.poll = null;
  }
}

/**
 * Without a server only .h5ad files can be read (the browser parses them
 * locally), so the dialog says so.
 */
function adaptDialogToMode() {
  if (!isLocalMode()) return;
  const zone = document.getElementById('drop-zone');
  if (!zone) return;
  const head = zone.querySelector('p');
  if (head) {
    head.innerHTML = 'Drop a <b>.h5ad</b> file here, or';
  }
  const note = zone.querySelector('p.muted');
  if (note) {
    note.innerHTML =
      'The file is read <b>in your browser</b> and kept in the local storage of ' +
      'this browser - it is never uploaded. Seurat <b>.rds</b> files need the server version.';
  }
  const input = document.getElementById('upload-input');
  if (input) input.setAttribute('accept', '.h5ad');
  const btn = document.getElementById('add-data');
  if (btn) btn.title = 'Add an .h5ad dataset (read in the browser)';
}

function stateHasProject() {
  // a server exposes /api/project; a static site only has data/project.json
  return fetch('/api/project')
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => (ok ? true : fetch('data/project.json').then((r) => r.ok).catch(() => false)));
}

// ------------------------------------------------------------------ sources

async function uploadFile(file) {
  if (!/\.(h5ad|hdf|h5|rds|rdata|rda)$/i.test(file.name)) {
    toast(`${file.name} is not an .h5ad or .rds file`);
    return;
  }
  const info = document.getElementById('add-info');
  info.style.display = 'block';
  info.innerHTML = `<p class="muted">Uploading ${esc(file.name)} (${(file.size / 1e6).toFixed(1)} MB)…</p>`;
  if (isLocalMode()) {
    // no server: the browser reads the file and builds the bundle itself
    await discoverLocal(file);
    return;
  }
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: await file.arrayBuffer(),
    });
    if (!res.ok) throw new Error(await res.text());
    const stored = await res.json();
    discover(stored.path);
  } catch (err) {
    info.innerHTML = `<p class="muted small">Upload failed: ${esc(String(err.message || err))}</p>`;
  }
}

/** Read the file in the browser and show what it contains. */
async function discoverLocal(file) {
  const info = document.getElementById('add-info');
  info.style.display = 'block';
  info.innerHTML = `<p class="muted">Reading ${esc(file.name)} in the browser…</p>`;
  try {
    const { readH5ad } = await import('./h5ad.js');
    const { detectContent } = await import('./builder.js');
    const h5ad = await readH5ad(file);
    const content = detectContent(h5ad);
    dialog.localFile = file;
    dialog.localContent = content;
    const payload = {
      filename: file.name,
      path: file.name,
      format: 'h5ad',
      n_cells: h5ad.nCells,
      n_features: h5ad.nGenes,
      size_mb: Math.round((file.size / 1e6) * 10) / 10,
      groups: content.groups.map((name) => {
        const cats = content.categories[name] || [];
        return {
          column: name,
          name,
          label: name,
          n_categories: cats.length,
          notes: 'categorical',
        };
      }),
      other_columns: Object.entries(h5ad.obs)
        .filter(([name, col]) => col.type === 'number')
        .map(([name]) => ({ column: name, kind: 'numeric', note: 'quantitative (usable as a metric)' })),
      embeddings: content.embeddings.map((name) => ({
        obsm: name,
        name,
        label: name,
        kind: 'umap',
      })),
      suggested_id: (file.name.replace(/\.[^.]+$/, '') || 'dataset')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, ''),
    };
    dialog.path = file.name;
    dialog.info = payload;
    renderInfo(payload);
  } catch (err) {
    console.error(err);
    info.innerHTML = `<p class="muted small">Could not read the file: ${esc(String(err.message || err))}</p>`;
  }
}

/** Build the dataset in the browser and hand it to the app. */
async function addLocal(name, groups, embeddings) {
  const { buildDatasetFromH5ad } = await import('./builder.js');
  const file = dialog.localFile;
  const result = await buildDatasetFromH5ad(file, {
    id: dialog.info?.suggested_id,
    name: name || file.name.replace(/\.[^.]+$/, ''),
    groups,
    embeddings,
    filename: file.name,
  });
  return result;
}

async function scanPath(raw) {
  const path = String(raw || '').trim();
  if (!path) {
    toast('Enter a path first');
    return;
  }
  discover(path);
}

// ----------------------------------------------------------------- pipeline

async function discover(path) {
  dialog.path = null;
  const info = document.getElementById('add-info');
  info.style.display = 'block';
  const rds = /\.(rds|rdata|rda)$/i.test(path);
  info.innerHTML = `<p class="muted">Scanning ${esc(path)}${rds ? ' (converting the Seurat/R object with R first - this can take a moment)' : ''}…</p>`;
  try {
    const payload = await postJSON('/api/datasets/discover', { path });
    dialog.path = payload.path;
    dialog.info = payload;
    renderInfo(payload);
  } catch (err) {
    info.innerHTML = `<p class="muted small">${esc(String(err.message || err))}</p>`;
  }
}

function renderInfo(info) {
  const host = document.getElementById('add-info');
  host.innerHTML = '';
  const head = el('div', 'file-head');
  head.innerHTML =
    `<span class="file-name">${esc(info.filename)}</span>` +
    (info.format === 'rds' ? `<span class="file-stats">converted from Seurat/R</span>` : '') +
    `<span class="file-stats">${fmtNum(info.n_cells)} cells · ${fmtNum(info.n_features)} features · ${esc(info.size_mb)} MB</span>`;
  host.appendChild(head);

  const groups = (info.groups || []).filter((g) => g.notes !== 'high cardinality');
  const embeddings = info.embeddings || [];
  if (!embeddings.length) {
    host.appendChild(el('p', 'muted small', 'No 2-D embedding in obsm - this file cannot be displayed.'));
    return;
  }

  host.appendChild(el('div', 'add-col-label', 'Groupings'));
  const gBox = el('div', 'add-groups');
  groups.forEach((g, i) => {
    const label = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = i < 12;
    cb.value = g.column;
    label.append(cb, el('span', null, `${g.label || g.name} (${g.n_categories})`));
    gBox.appendChild(label);
  });
  if (info.groups.some((g) => g.notes === 'high cardinality')) {
    host.appendChild(gBox);
    host.appendChild(el('p', 'muted small', 'High-cardinality columns are skipped as groupings.'));
  } else {
    host.appendChild(gBox);
  }

  // what else the file contains - so it is clear what is (not) available
  const others = info.other_columns || [];
  if (others.length) {
    host.appendChild(el('div', 'add-col-label', 'Other metadata in this file'));
    const list = el('div', 'add-others');
    others.forEach((o) => {
      const item = el('span', 'add-other');
      item.append(el('b', null, o.column), el('span', 'muted', o.note));
      list.appendChild(item);
    });
    host.appendChild(list);
  }

  host.appendChild(el('div', 'add-col-label', 'Embeddings'));
  const eBox = el('div', 'add-embeddings');
  embeddings.forEach((e) => {
    const label = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = e.name;
    label.append(cb, el('span', null, `${e.label || e.name} (${e.kind})`));
    eBox.appendChild(label);
  });
  host.appendChild(eBox);

  const nameRow = el('div', 'add-name-row');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = info.filename.replace(/\.(h5ad|hdf|h5|rds|rdata|rda)$/i, '');
  nameInput.spellcheck = false;
  nameRow.append(el('span', 'add-col-label', 'Name'), nameInput);
  host.appendChild(nameRow);

  const actions = el('div', 'add-actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', closeDialog);
  const submit = el('button', 'btn btn-primary', 'Convert & add');
  submit.addEventListener('click', async () => {
    const groupCols = Array.from(gBox.querySelectorAll('input:checked')).map((c) => c.value);
    const embNames = Array.from(eBox.querySelectorAll('input:checked')).map((c) => c.value);
    const name = nameInput.value.trim() || info.filename.replace(/\.(h5ad|hdf|h5|rds|rdata|rda)$/i, '');
    if (isLocalMode()) {
      submit.disabled = true;
      submit.textContent = 'Building…';
      try {
        const result = await addLocal(name, groupCols, embNames);
        closeDialog();
        if (dialog.onAdded) dialog.onAdded(result.id);
      } catch (err) {
        console.error(err);
        toast(`Could not build the dataset: ${err.message}`);
        submit.disabled = false;
        submit.textContent = 'Convert & add';
      }
      return;
    }
    runAdd({
      id: info.suggested_id,
      path: info.path,
      name,
      groups: groupCols,
      embeddings: embNames,
    });
  });
  actions.append(cancel, submit);
  host.appendChild(actions);
}

async function runAdd(params) {
  const progress = document.getElementById('add-progress');
  const logEl = document.getElementById('add-log');
  progress.style.display = 'block';
  logEl.textContent = '';
  try {
    const res = await postJSON('/api/datasets/add', params);
    dialog.job = res.job;
  } catch (err) {
    logEl.textContent += `${String(err.message || err)}\n`;
    return;
  }
  logEl.textContent += 'converting…\n';
  dialog.poll = setInterval(async () => {
    try {
      const job = await fetchJSON(`/api/datasets/job/${dialog.job}`);
      logEl.textContent = job.log.join('\n') + '\n';
      progress.scrollTop = progress.scrollHeight;
      if (job.status === 'done') {
        clearInterval(dialog.poll);
        dialog.poll = null;
        if (dialog.onAdded && job.dataset) dialog.onAdded(job.dataset.id);
        closeDialog();
        toast(`${job.dataset.name || job.dataset.id} added · ${fmtNum(job.dataset.n_cells)} cells`);
      } else if (job.status === 'error') {
        clearInterval(dialog.poll);
        dialog.poll = null;
        logEl.textContent += `\n(error) ${job.error}\n`;
      }
    } catch (err) {
      /* keep polling - the server may still be starting */
    }
  }, 500);
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} - ${text.slice(0, 220)}`);
  }
  return res.json();
}
