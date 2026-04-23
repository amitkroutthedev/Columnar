/**
 * GridLens — main.js
 * Frontend logic: virtual scroll, Tauri IPC, search, sort, stats, keyboard shortcuts
 * Tauri v2: invoke via window.__TAURI__.core.invoke(...)
 */

'use strict';

// ── Tauri IPC shim ────────────────────────────────────────────
// Works in Tauri v2. Falls back to a mock for browser dev.
const invoke = (typeof window.__TAURI__ !== 'undefined')
  ? window.__TAURI__.core.invoke
  : async (cmd, args) => {
    console.warn(`[DEV] invoke("${cmd}", ${JSON.stringify(args)})`);
    // Return mock data for browser-only development
    if (cmd === 'get_page') return mockPage(args);
    if (cmd === 'search_csv') return mockSearch(args);
    if (cmd === 'get_column_stats') return mockStats(args);
    return null;
  };

// ── State ─────────────────────────────────────────────────────
const state = {
  loaded: false,
  filePath: null,
  fileName: null,
  totalRows: 0,
  totalCols: 0,
  headers: [],
  colWidths: [],      // px widths per column

  // Virtual scroll
  rowH: 32,
  pageSize: 80,
  visibleStart: 0,
  renderedRows: new Map(), // rowIndex → DOM element

  // Sort
  sortCol: -1,
  sortAsc: true,

  // Search
  searchQuery: '',
  searchResults: [],      // array of row indices matching
  searchTimer: null,

  // Column resize
  resizing: null,    // { colIdx, startX, startW }
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const el = {
  emptyState: $('empty-state'),
  gridWrap: $('grid-wrap'),
  gridHeader: $('grid-header'),
  scrollVP: $('scroll-viewport'),
  scrollContent: $('scroll-content'),
  statusbar: $('statusbar'),
  statusRows: $('status-rows'),
  statusCols: $('status-cols'),
  statusScroll: $('status-scroll'),
  statusHint: $('status-hint'),
  toolbar: $('toolbar'),
  topbar: $('topbar'),
  fileName: $('file-name'),
  fileMeta: $('file-meta'),
  searchInput: $('search-input'),
  searchCount: $('search-count'),
  btnClearSearch: $('btn-clear-search'),
  sortIndicator: $('sort-indicator'),
  sortLabel: $('sort-label'),
  loading: $('loading-overlay'),
  loadingLabel: $('loading-label'),
  toastContainer: $('toast-container'),

  // Stats modal
  statsOverlay: $('stats-overlay'),
  statsTitle: $('stats-title'),
  statsGrid: $('stats-grid'),
  statsClose: $('stats-close'),

  // Goto modal
  gotoOverlay: $('goto-overlay'),
  gotoInput: $('goto-input'),
  gotoConfirm: $('goto-confirm'),
  gotoClose: $('goto-close'),
  gotoHint: $('goto-hint'),
};

// ── Entry point ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  bindKeyboard();
  bindDragDrop();

  // ── Menu + progress event listeners ───────────────────────
  // Both are guarded so missing APIs or failures never break the app.
  try {
    const tauriListen = window.__TAURI__?.event?.listen;
    if (tauriListen) {
      // Menu → Open File / Recent Files click → loads the selected path.
      tauriListen('menu://load-path', (event) => {
        const path = event.payload;
        if (typeof path === 'string' && path.length > 0) {
          loadFile(path);
        }
      });

      // Rust-side progress updates during CSV indexing.
      tauriListen('load-progress', (event) => {
        const payload = event.payload || {};
        const read  = Number(payload.bytes_read)  || 0;
        const total = Number(payload.bytes_total) || 0;
        if (!el.loadingLabel) return;
        if (total <= 0) {
          el.loadingLabel.textContent = 'Indexing…';
          return;
        }
        const pct     = Math.floor((read / total) * 100);
        const readMb  = (read  / 1024 / 1024).toFixed(0);
        const totalMb = (total / 1024 / 1024).toFixed(0);
        el.loadingLabel.textContent = `Indexing… ${readMb} / ${totalMb} MB (${pct}%)`;
      });
    }
  } catch (e) {
    console.error('Event listener setup failed:', e);
  }
});

// ── File Loading ──────────────────────────────────────────────
async function openFile() {
  try {
    // Tauri v2: dialog plugin is accessed via window.__TAURI_PLUGIN_DIALOG__
    // Requires tauri-plugin-dialog in Cargo.toml and "dialog:allow-open" in capabilities
    const dialogOpen = window.__TAURI_PLUGIN_DIALOG__?.open
      ?? window.__TAURI__?.dialog?.open;

    let path;

    if (dialogOpen) {
      path = await dialogOpen({
        multiple: false,
        filters: [
          { name: 'CSV Files', extensions: ['csv', 'tsv'] },
        ],
      });
    } else {
      // Dev fallback (browser preview only)
      path = prompt('Enter CSV file path (dev mode):');
    }

    // User cancelled
    if (!path) return;

    await loadFile(path);
  } catch (err) {
    toast(`Failed to open file dialog: ${err}`, 'error');
  }
}

async function loadFile(filePath) {
  showLoading('Loading file…');
  try {
    const result = await invoke('load_csv', { filePath });
    if (!result) throw new Error('No data returned from backend');

    state.loaded = true;
    state.filePath = filePath;
    state.fileName = filePath.split(/[/\\]/).pop();
    state.totalRows = result.total_rows;
    state.totalCols = result.headers.length;
    state.headers = result.headers;
    state.colWidths = result.headers.map(() => 160); // default column width
    state.sortCol = -1;
    state.sortAsc = true;
    state.searchQuery = '';
    state.searchResults = [];

    el.searchInput.value = '';
    el.searchCount.textContent = '';
    el.btnClearSearch.style.display = 'none';

    renderShell();
    scrollTo(0);
    await renderPage(0);
    updateStatusBar();
    updateFileInfo(result);
    hideLoading();
    toast(`Loaded ${fmt(state.totalRows)} rows`, 'success');
  } catch (err) {
    hideLoading();
    toast(`Error loading file: ${err}`, 'error');
    console.error(err);
  }
}

// ── Shell (header + scroll container) ────────────────────────
function renderShell() {
  el.emptyState.style.display = 'none';
  el.gridWrap.style.display = '';
  el.statusbar.style.display = '';

  // Build header row
  el.gridHeader.innerHTML = '';

  // Row index column
  const idxH = document.createElement('div');
  idxH.className = 'col-header col-header-idx';
  idxH.textContent = '#';
  el.gridHeader.appendChild(idxH);

  state.headers.forEach((h, i) => {
    const cell = document.createElement('div');
    cell.className = 'col-header';
    cell.style.width = state.colWidths[i] + 'px';
    cell.dataset.colIdx = i;
    cell.innerHTML = `<span class="col-label">${escHtml(h)}</span><span class="sort-arrow"></span>`;

    cell.addEventListener('click', e => {
      if (e.shiftKey) { showStats(i); return; }
      sortByColumn(i);
    });
    cell.addEventListener('dblclick', () => showStats(i));

    // Resize handle
    const rh = document.createElement('div');
    rh.className = 'resize-handle';
    rh.addEventListener('mousedown', e => startResize(e, i));
    cell.appendChild(rh);

    el.gridHeader.appendChild(cell);
  });

  // Set scroll content height for virtual scroll
  el.scrollContent.style.height = (state.totalRows * state.rowH) + 'px';
  el.scrollContent.style.width = totalWidth() + 'px';
  el.gridHeader.style.width = totalWidth() + 'px';

  // Sync horizontal scroll of header with viewport
  el.scrollVP.addEventListener('scroll', onScroll, { passive: true });
}

function totalWidth() {
  return 52 + state.colWidths.reduce((a, b) => a + b, 0); // 52 = idx col
}

// ── Virtual Scroll ────────────────────────────────────────────
let scrollRaf = null;

function onScroll() {
  // Sync header horizontal scroll
  el.gridHeader.scrollLeft = el.scrollVP.scrollLeft;

  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    const scrollTop = el.scrollVP.scrollTop;
    const vpH = el.scrollVP.clientHeight;
    const firstVisible = Math.floor(scrollTop / state.rowH);
    const lastVisible = Math.min(state.totalRows - 1, Math.ceil((scrollTop + vpH) / state.rowH));

    // Render a buffer around the visible range
    const bufferRows = 20;
    const renderStart = Math.max(0, firstVisible - bufferRows);
    const renderEnd = Math.min(state.totalRows - 1, lastVisible + bufferRows);

    renderRange(renderStart, renderEnd);
    updateStatusScroll(firstVisible + 1);
  });
}

async function renderPage(startRow) {
  const endRow = Math.min(state.totalRows - 1, startRow + state.pageSize + 40);
  await renderRange(startRow, endRow);
}

async function renderRange(startRow, endRow) {
  if (!state.loaded) return;

  // Determine which rows we need to fetch
  const needed = [];
  for (let i = startRow; i <= endRow; i++) {
    if (!state.renderedRows.has(i)) needed.push(i);
  }

  if (needed.length === 0) return;

  // Fetch in page-sized chunks
  const chunkSize = state.pageSize;
  const chunks = [];
  for (let i = 0; i < needed.length; i += chunkSize) {
    chunks.push(needed.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    const page = Math.floor(chunk[0] / state.pageSize);
    const rows = await invoke('get_page', { page, pageSize: state.pageSize });
    if (!rows || !rows.length) continue;

    const frag = document.createDocumentFragment();
    rows.forEach((rowData, localIdx) => {
      const rowIdx = page * state.pageSize + localIdx;
      if (rowIdx > endRow || state.renderedRows.has(rowIdx)) return;

      const rowEl = buildRow(rowData, rowIdx);
      state.renderedRows.set(rowIdx, rowEl);
      frag.appendChild(rowEl);
    });
    el.scrollContent.appendChild(frag);
  }

  // Prune far-away rows to keep DOM lean (keep 3× viewport worth)
  pruneRows(startRow, endRow);
}

function buildRow(rowData, rowIdx) {
  const row = document.createElement('div');
  row.className = `grid-row ${rowIdx % 2 === 0 ? 'even' : 'odd'}`;
  row.style.top = (rowIdx * state.rowH) + 'px';
  row.dataset.row = rowIdx;

  // Highlight if in search results
  if (state.searchResults.length && state.searchResults.includes(rowIdx)) {
    row.classList.add('highlighted');
  }

  // Index cell
  const idxCell = document.createElement('div');
  idxCell.className = 'grid-cell cell-idx';
  idxCell.textContent = (rowIdx + 1).toString();
  row.appendChild(idxCell);

  // Data cells
  rowData.forEach((val, colIdx) => {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.style.width = state.colWidths[colIdx] + 'px';
    cell.title = val;

    if (state.searchQuery && val.toLowerCase().includes(state.searchQuery.toLowerCase())) {
      cell.classList.add('cell-match');
      cell.innerHTML = highlightMatch(val, state.searchQuery);
    } else {
      cell.textContent = val;
    }

    row.appendChild(cell);
  });

  return row;
}

function pruneRows(keepStart, keepEnd) {
  const margin = 60;
  const pruneStart = keepStart - margin;
  const pruneEnd = keepEnd + margin;

  for (const [rowIdx, rowEl] of state.renderedRows) {
    if (rowIdx < pruneStart || rowIdx > pruneEnd) {
      rowEl.remove();
      state.renderedRows.delete(rowIdx);
    }
  }
}

function scrollTo(rowIdx) {
  el.scrollVP.scrollTop = rowIdx * state.rowH;
}

function scrollToRow(rowIdx) {
  const target = Math.max(0, Math.min(state.totalRows - 1, rowIdx));
  scrollTo(target);
  renderPage(target);
  updateStatusScroll(target + 1);
}

// ── Sort ──────────────────────────────────────────────────────
async function sortByColumn(colIdx) {
  const ascending = state.sortCol === colIdx ? !state.sortAsc : true;
  showLoading('Sorting…');
  try {
    await invoke('sort_column', { colIndex: colIdx, ascending });
    state.sortCol = colIdx;
    state.sortAsc = ascending;

    clearRenderedRows();
    scrollTo(0);
    await renderPage(0);
    updateSortUI();
    updateStatusScroll(1);
  } catch (err) {
    toast(`Sort failed: ${err}`, 'error');
  } finally {
    hideLoading();
  }
}

function updateSortUI() {
  // Reset all headers
  document.querySelectorAll('.col-header').forEach(h => {
    h.classList.remove('sorted');
    const arrow = h.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = '';
  });

  if (state.sortCol < 0) {
    el.sortIndicator.style.display = 'none';
    return;
  }

  const headers = document.querySelectorAll('.col-header:not(.col-header-idx)');
  const target = headers[state.sortCol];
  if (target) {
    target.classList.add('sorted');
    const arrow = target.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = state.sortAsc ? '↑' : '↓';
  }

  el.sortIndicator.style.display = 'flex';
  el.sortLabel.textContent = `${state.headers[state.sortCol]} ${state.sortAsc ? '↑' : '↓'}`;
}

// ── Search ────────────────────────────────────────────────────
function onSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(state.searchTimer);

  if (!q) {
    clearSearch();
    return;
  }

  el.btnClearSearch.style.display = '';
  el.searchCount.textContent = '…';
  state.searchTimer = setTimeout(() => runSearch(q), 300);
}

async function runSearch(query) {
  if (!state.loaded) return;
  try {
    const results = await invoke('search_csv', { query });
    state.searchQuery = query;
    state.searchResults = results ?? [];

    el.searchCount.textContent = state.searchResults.length
      ? `${fmt(state.searchResults.length)} match${state.searchResults.length !== 1 ? 'es' : ''}`
      : 'No matches';

    // Re-render visible rows with highlights
    clearRenderedRows();
    const firstMatch = state.searchResults[0] ?? 0;
    scrollTo(firstMatch);
    await renderPage(firstMatch);
    updateStatusScroll(firstMatch + 1);
  } catch (err) {
    el.searchCount.textContent = 'Error';
    console.error(err);
  }
}

function clearSearch() {
  state.searchQuery = '';
  state.searchResults = [];
  el.searchInput.value = '';
  el.searchCount.textContent = '';
  el.btnClearSearch.style.display = 'none';
  if (!state.loaded) return;
  clearRenderedRows();
  renderPage(Math.floor(el.scrollVP.scrollTop / state.rowH));
}

// ── Column Stats Modal ────────────────────────────────────────
async function showStats(colIdx) {
  if (!state.loaded) return;
  showLoading('Computing stats…');
  try {
    const stats = await invoke('get_column_stats', { colIndex: colIdx });
    hideLoading();

    el.statsTitle.textContent = `${state.headers[colIdx]}`;
    el.statsGrid.innerHTML = '';

    const entries = [
      { label: 'Type', value: stats.col_type, cls: 'accent' },
      { label: 'Count', value: fmt(stats.count), cls: '' },
      { label: 'Unique', value: fmt(stats.unique_count), cls: '' },
      { label: 'Nulls', value: fmt(stats.null_count), cls: stats.null_count > 0 ? 'yellow' : '' },
      { label: 'Min', value: stats.min ?? '—', cls: 'green' },
      { label: 'Max', value: stats.max ?? '—', cls: 'green' },
      { label: 'Mean', value: fmtNum(stats.mean), cls: '' },
      { label: 'Median', value: fmtNum(stats.median), cls: '' },
      { label: 'Std Dev', value: fmtNum(stats.std_dev), cls: '' },
      { label: 'Sample', value: (stats.sample_values ?? []).join(', '), cls: '', full: true },
    ];

    entries.forEach(({ label, value, cls, full }) => {
      if (value === undefined || value === null) return;
      const cell = document.createElement('div');
      cell.className = `stat-cell${full ? ' full-width' : ''}`;
      cell.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value ${cls}">${escHtml(String(value))}</div>`;
      el.statsGrid.appendChild(cell);
    });

    el.statsOverlay.style.display = 'flex';
  } catch (err) {
    hideLoading();
    toast(`Stats failed: ${err}`, 'error');
  }
}

function closeStats() {
  el.statsOverlay.style.display = 'none';
}

// ── Go To Row Modal ───────────────────────────────────────────
function openGoto() {
  el.gotoHint.textContent = `1 – ${fmt(state.totalRows)}`;
  el.gotoInput.value = '';
  el.gotoOverlay.style.display = 'flex';
  el.gotoInput.focus();
}

function closeGoto() {
  el.gotoOverlay.style.display = 'none';
}

function confirmGoto() {
  const n = parseInt(el.gotoInput.value, 10);
  if (isNaN(n) || n < 1 || n > state.totalRows) {
    toast(`Enter a row between 1 and ${fmt(state.totalRows)}`, 'error');
    return;
  }
  closeGoto();
  scrollToRow(n - 1);
}

// ── Column Resize ─────────────────────────────────────────────
function startResize(e, colIdx) {
  e.preventDefault();
  e.stopPropagation();
  state.resizing = { colIdx, startX: e.clientX, startW: state.colWidths[colIdx] };
  e.target.classList.add('dragging');
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', endResize);
}

function onResize(e) {
  if (!state.resizing) return;
  const { colIdx, startX, startW } = state.resizing;
  const newW = Math.max(60, startW + (e.clientX - startX));
  state.colWidths[colIdx] = newW;

  // Update header cell width
  const headers = document.querySelectorAll('.col-header:not(.col-header-idx)');
  if (headers[colIdx]) headers[colIdx].style.width = newW + 'px';

  // Update data cells in rendered rows
  state.renderedRows.forEach(rowEl => {
    const cells = rowEl.querySelectorAll('.grid-cell:not(.cell-idx)');
    if (cells[colIdx]) cells[colIdx].style.width = newW + 'px';
  });

  // Update total widths
  const tw = totalWidth() + 'px';
  el.scrollContent.style.width = tw;
  el.gridHeader.style.width = tw;
}

function endResize() {
  document.querySelectorAll('.resize-handle.dragging').forEach(h => h.classList.remove('dragging'));
  state.resizing = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', endResize);
}

// ── Keyboard Shortcuts ────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === 'o') { e.preventDefault(); openFile(); return; }
    if (ctrl && e.key === 'f') { e.preventDefault(); el.searchInput.focus(); el.searchInput.select(); return; }
    if (ctrl && e.key === 'g') { e.preventDefault(); if (state.loaded) openGoto(); return; }

    if (e.key === 'Escape') {
      if (el.statsOverlay.style.display !== 'none') { closeStats(); return; }
      if (el.gotoOverlay.style.display !== 'none') { closeGoto(); return; }
      if (state.searchQuery) { clearSearch(); return; }
    }

    // Arrow key navigation when viewport focused
    if (!e.target.matches('input') && state.loaded) {
      if (e.key === 'ArrowDown') { e.preventDefault(); el.scrollVP.scrollTop += state.rowH; }
      if (e.key === 'ArrowUp') { e.preventDefault(); el.scrollVP.scrollTop -= state.rowH; }
      if (e.key === 'PageDown') { e.preventDefault(); el.scrollVP.scrollTop += el.scrollVP.clientHeight; }
      if (e.key === 'PageUp') { e.preventDefault(); el.scrollVP.scrollTop -= el.scrollVP.clientHeight; }
      if (e.key === 'Home') { e.preventDefault(); scrollTo(0); }
      if (e.key === 'End') { e.preventDefault(); scrollTo(state.totalRows - 1); }
    }

    if (e.key === 'Enter' && el.gotoOverlay.style.display !== 'none') {
      confirmGoto();
    }
  });
}

// ── Drag & Drop ───────────────────────────────────────────────
function bindDragDrop() {
  document.body.addEventListener('dragover', e => {
    e.preventDefault();
    document.body.classList.add('drag-over');
  });
  document.body.addEventListener('dragleave', e => {
    if (!e.relatedTarget) document.body.classList.remove('drag-over');
  });
  document.body.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      // In Tauri, we get the path via the file object
      const path = file.path ?? file.name;
      await loadFile(path);
    }
  });
}

// ── UI Bindings ───────────────────────────────────────────────
function bindUI() {
  $('btn-open').addEventListener('click', openFile);
  $('btn-open-empty').addEventListener('click', openFile);
  $('btn-goto').addEventListener('click', () => { if (state.loaded) openGoto(); });
  $('btn-clear-search').addEventListener('click', clearSearch);
  el.searchInput.addEventListener('input', onSearchInput);
  el.statsClose.addEventListener('click', closeStats);
  el.gotoClose.addEventListener('click', closeGoto);
  el.gotoConfirm.addEventListener('click', confirmGoto);

  // Close modals on overlay click
  el.statsOverlay.addEventListener('click', e => { if (e.target === el.statsOverlay) closeStats(); });
  el.gotoOverlay.addEventListener('click', e => { if (e.target === el.gotoOverlay) closeGoto(); });
}

// ── Status Bar ────────────────────────────────────────────────
function updateStatusBar() {
  el.statusRows.textContent = `${fmt(state.totalRows)} rows`;
  el.statusCols.textContent = `${state.totalCols} cols`;
  updateStatusScroll(1);
}

function updateStatusScroll(row) {
  el.statusScroll.textContent = `Row ${fmt(row)}`;
}

function updateFileInfo(result) {
  el.fileName.textContent = state.fileName;
  el.fileName.classList.add('loaded');
  const mb = result.file_size_bytes ? ` · ${(result.file_size_bytes / 1024 / 1024).toFixed(1)} MB` : '';
  el.fileMeta.textContent = `${fmt(state.totalRows)} rows · ${state.totalCols} cols${mb}`;
}

// ── Loading ───────────────────────────────────────────────────
function showLoading(label = 'Loading…') {
  el.loadingLabel.textContent = label;
  el.loading.style.display = 'flex';
}

function hideLoading() {
  el.loading.style.display = 'none';
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut 0.25s ease forwards';
    setTimeout(() => t.remove(), 280);
  }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────
function clearRenderedRows() {
  state.renderedRows.forEach(el => el.remove());
  state.renderedRows.clear();
}

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtNum(n) {
  if (n == null || n === '') return '—';
  const f = parseFloat(n);
  if (isNaN(f)) return '—';
  return f.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(text, query) {
  const safe = escHtml(text);
  const safeQ = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(safeQ, 'gi'), m => `<mark>${m}</mark>`);
}

// ── Mock data (browser-only dev mode) ─────────────────────────
function mockPage({ page, pageSize }) {
  const rows = [];
  for (let i = 0; i < pageSize; i++) {
    const rowIdx = page * pageSize + i;
    rows.push([
      `value_${rowIdx}_0`,
      `value_${rowIdx}_1`,
      (Math.random() * 1000).toFixed(2),
      rowIdx % 2 === 0 ? 'true' : 'false',
      new Date(Date.now() - rowIdx * 86400000).toISOString().split('T')[0],
    ]);
  }
  return rows;
}

function mockSearch({ query }) {
  const results = [];
  for (let i = 0; i < 100; i++) results.push(i * 3);
  return results;
}

function mockStats({ colIndex }) {
  return {
    col_type: 'Numeric',
    count: 500000,
    unique_count: 499123,
    null_count: 42,
    min: '0.01',
    max: '9999.99',
    mean: '512.34',
    median: '487.21',
    std_dev: '201.88',
    sample_values: ['42.0', '128.5', '999.9', '7.77'],
  };
}