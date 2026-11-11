// The local mode: the app reads its data from the browser instead of a
// server.  A small fetch interceptor answers the requests for "data/..." from
// the local store (including HTTP range requests, which the expression blob
// needs) and serves the project manifest from there as well.

import { deleteFile, getFile, getJSON, listFiles, putJSON } from './localfs.js';

let installed = false;

/** True when the app runs without a server (a static site). */
export function isLocalMode() {
  return window.__OMICEXPLORER_LOCAL__ === true;
}

/**
 * Find out whether a server is behind this page.  When there is none the
 * local (browser only) mode is switched on.
 */
export async function detectMode() {
  if (window.__OMICEXPLORER_LOCAL__ === true) return 'local';
  let ok = false;
  try {
    const res = await fetch('/api/project', { method: 'GET' });
    ok = res.ok;
  } catch (err) {
    ok = false;
  }
  window.__OMICEXPLORER_LOCAL__ = !ok;
  if (!ok) installLocalFetch();
  return ok ? 'server' : 'local';
}

function rangeOf(init, url) {
  const headers = init?.headers;
  if (headers) {
    if (typeof headers.get === 'function') return headers.get('Range');
    if (Array.isArray(headers)) {
      const hit = headers.find((h) => String(h[0]).toLowerCase() === 'range');
      return hit ? hit[1] : null;
    }
  }
  return null;
}

/** Serve one stored file (with range support). */
function serveBuffer(buf, init, method) {
  const bytes = new Uint8Array(buf);
  const range = rangeOf(init);
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : bytes.length - 1;
      const slice = bytes.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'Accept-Ranges': 'bytes',
  };
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}

/** Install the interceptor (idempotent). */
export function installLocalFetch() {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    let url;
    try {
      url = new URL(raw, location.href);
    } catch (err) {
      return original(input, init);
    }
    const method = (init?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (url.pathname.startsWith('/data/')) {
      const path = url.pathname.slice(1);
      const buf = await getFile(path);
      // not in the local store -> let the server (or the static host) answer
      if (!buf) return original(input, init);
      return serveBuffer(buf, init, method);
    }
    if (url.pathname === '/api/datasets/remove' && method === 'POST') {
      // delete a dataset of the local project
      const payload = await parseBody(init);
      const result = await removeLocalDataset(payload.id);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/project') {
      const buf = await getFile('data/project.json');
      if (!buf) {
        return new Response(
          JSON.stringify({ name: 'OmicsExplorer', subtitle: 'runs entirely in your browser', panels: [] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(input, init);
  };
}

async function parseBody(init) {
  try {
    if (init && typeof init.body === 'string') return JSON.parse(init.body);
    if (init && init.body && typeof init.body.text === 'function') return JSON.parse(await init.body.text());
  } catch (err) { /* no body */ }
  return {};
}

/**
 * Delete a dataset from the local project: its files go away and it is
 * dropped from the manifest (the gene index keeps the shared genes).
 */
async function removeLocalDataset(dsId) {
  const id = String(dsId || '').trim();
  if (!id) throw new Error('missing id');
  const files = await listFiles(`data/${id}/`);
  for (const f of files) await deleteFile(f);
  const project = await getJSON('data/project.json');
  if (project) {
    project.panels = (project.panels || []).filter((p) => p.id !== id);
    await putJSON('data/project.json', project);
  }
  const genes = await getJSON('data/genes.json');
  if (genes && genes.genes) {
    for (const entry of Object.values(genes.genes)) {
      if (entry && entry.panels) entry.panels = entry.panels.filter((p) => p !== id);
    }
    await putJSON('data/genes.json', genes);
  }
  return { id, removed: files.length };
}

/** The local project manifest (or null). */
export async function localProject() {
  const { getJSON } = await import('./localfs.js');
  return getJSON('data/project.json');
}

/** All datasets of the local project. */
export async function localDatasets() {
  const paths = await listFiles('data/');
  const dirs = new Set();
  paths.forEach((p) => {
    const m = /^data\/([^/]+)\/index\.json$/.exec(p);
    if (m) dirs.add(m[1]);
  });
  return [...dirs];
}
