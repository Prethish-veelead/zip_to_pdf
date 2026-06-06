/* ── Config ──────────────────────────────────────────────────────────────── */
const MAX_FILE_MB  = 300;
const MAX_FILES    = 30;
const MAX_PDF_NAME_LEN = 100;
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  step:       'upload',
  zips:       [],         // [{id, name, size, imageCount, order, fileObj, validImages: []}]
  pages:      [],         // [{page, zipId, zipName, imageName, entryName, thumbnailUrl}]
  selectedPages:new Set(),
  selected:   [],         // File objects chosen but not yet uploaded
  startTime:  null,
  totalImages:0,
  pdfSize:    0,
  pdfName:    '',
  pdfNameDirty:false,
  pageSize:   'smart',
  pdfBlobUrl: null,       // URL for the generated PDF to download
  isGenerating: false
};

/* ── Utilities ───────────────────────────────────────────────────────────── */
const fmtSize = (bytes) => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
};

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

const qs  = (sel) => document.querySelector(sel);
const qsa = (sel) => [...document.querySelectorAll(sel)];

const escapeAttr = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));
const escapeHtml = escapeAttr;

function stripExt(name, ext) {
  const value = String(name || '');
  return value.toLowerCase().endsWith(ext) ? value.slice(0, -ext.length) : value;
}

function sanitizePdfBase(value) {
  return String(value || '')
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\.pdf$/i, '')
    .slice(0, MAX_PDF_NAME_LEN - 4);
}

function finalPdfName(value = state.pdfName) {
  const base = sanitizePdfBase(value).trim().replace(/[. ]+$/g, '');
  if (!base) return '';
  return `${base.slice(0, MAX_PDF_NAME_LEN - 4)}.pdf`;
}

function defaultPdfNameBase() {
  const first = [...state.zips].sort((a, b) => a.order - b.order)[0];
  return sanitizePdfBase(stripExt(first?.name || 'output', '.zip')).trim();
}

function syncDefaultPdfName(force = false) {
  if (force || !state.pdfNameDirty) state.pdfName = defaultPdfNameBase();
}

function updatePdfNameInput() {
  const input = qs('#pdf-name-input');
  if (input) input.value = state.pdfName;
}

function selectedPageList() {
  return [...state.selectedPages].sort((a, b) => a - b);
}

function toast(msg, type = 'info', dur = 4000) {
  const icons = { info: '◈', success: '✓', error: '✕' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  qs('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), dur);
}

/* ── Memory Management (Clear Cache) ─────────────────────────────────────── */
function clearCache() {
  // Revoke all object URLs to free memory
  if (state.pdfBlobUrl) {
    URL.revokeObjectURL(state.pdfBlobUrl);
    state.pdfBlobUrl = null;
  }
  
  for (const page of state.pages) {
    if (page.thumbnailUrl) {
      URL.revokeObjectURL(page.thumbnailUrl);
      page.thumbnailUrl = null;
    }
  }

  for (const zip of state.zips) {
    if (zip.thumbnailUrl) {
      URL.revokeObjectURL(zip.thumbnailUrl);
      zip.thumbnailUrl = null;
    }
  }

  // Reset state
  Object.assign(state, {
    zips: [], pages: [], selectedPages: new Set(), selected: [],
    startTime: null, totalImages: 0, pdfSize: 0,
    pdfName: '', pdfNameDirty: false, pageSize: 'smart',
    isGenerating: false
  });

  goto('upload');
  toast('Cache cleared and memory freed.', 'success');
}

/* ── SVG Icons ───────────────────────────────────────────────────────────── */
const icons = {
  upload: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  file:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  check:  `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  dl:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  arrow:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  back:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  image:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
};

function dragHandle() {
  return `<div class="drag-handle" title="Drag to reorder">
    <div class="dot-row"><span class="dot"></span><span class="dot"></span></div>
    <div class="dot-row"><span class="dot"></span><span class="dot"></span></div>
    <div class="dot-row"><span class="dot"></span><span class="dot"></span></div>
  </div>`;
}

/* ── Step Nav ────────────────────────────────────────────────────────────── */
const STEPS = [
  { key: 'upload',     label: 'Upload'   },
  { key: 'review',     label: 'Review'   },
  { key: 'preview',    label: 'Preview'  },
  { key: 'processing', label: 'Generate' },
  { key: 'complete',   label: 'Done'     },
];

function renderStepNav() {
  const cur = STEPS.findIndex(s => s.key === state.step);
  const nav = qs('#step-nav');
  nav.innerHTML = STEPS.map((s, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'active' : '';
    const dot  = i < cur ? '✓' : i + 1;
    const line = i < STEPS.length - 1
      ? `<div class="step-line${i < cur ? ' done' : ''}"></div>`
      : '';
    return `
      <div class="step-item ${cls}" aria-current="${i === cur ? 'step' : 'false'}">
        <div class="step-dot">${dot}</div>
        <span class="step-label">${s.label}</span>
      </div>${line}`;
  }).join('');
}

/* ── JSZip Helpers ───────────────────────────────────────────────────────── */
const VALID_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

function isValidImage(filename) {
  if (filename.startsWith('__MACOSX/') || filename.includes('/.')) return false;
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return ext && VALID_EXT.includes(ext[0]);
}

async function createThumbnailBlob(zipFileObj, entryName) {
  try {
    const zip = await JSZip.loadAsync(zipFileObj);
    const file = zip.file(entryName);
    if (!file) return null;
    
    // Get array buffer, make blob
    const buffer = await file.async("arraybuffer");
    let ext = entryName.split('.').pop().toLowerCase();
    if (ext === 'jpg') ext = 'jpeg';
    const blob = new Blob([buffer], { type: `image/${ext}` });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error("Thumbnail error:", e);
    return null;
  }
}

/* ── Step: Upload ────────────────────────────────────────────────────────── */
function renderUpload() {
  const main = qs('#main-content');
  main.innerHTML = `
    <div class="section-heading">
      <h1>Convert ZIPs to PDF</h1>
      <p>Upload your ZIP files — we'll stack all images into one clean PDF offline.</p>
    </div>

    <div class="upload-zone" id="drop-zone" role="button" tabindex="0" aria-label="Upload ZIP files">
      <div class="upload-icon">${icons.upload}</div>
      <h2>Drop ZIP files here</h2>
      <p>or click to browse your files</p>
      <div class="divider">supports</div>
      <div class="upload-limits">
        .zip files only &nbsp;·&nbsp; max ${MAX_FILE_MB} MB each &nbsp;·&nbsp; up to ${MAX_FILES} files
      </div>
    </div>
    <input type="file" id="file-input" accept=".zip" multiple />

    <div id="selected-chips" class="selected-files"></div>

    <div class="action-row">
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="clear-btn" style="display:none">Clear all</button>
      <button class="btn btn-primary" id="upload-btn" disabled>
        Continue ${icons.arrow}
      </button>
    </div>
  `;

  initUploadZone();
  qs('#clear-cache-btn')?.addEventListener('click', clearCache);
}

function initUploadZone() {
  const zone  = qs('#drop-zone');
  const input = qs('#file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop',      e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    addFiles([...e.dataTransfer.files]);
  });

  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });

  qs('#upload-btn').addEventListener('click', doUpload);
  qs('#clear-btn').addEventListener('click', () => { state.selected = []; refreshChips(); });
}

function addFiles(files) {
  const bad = [];
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.zip')) { bad.push(f.name); continue; }
    if (f.size > MAX_FILE_MB * 1048576) { toast(`${f.name} exceeds ${MAX_FILE_MB} MB`, 'error'); continue; }
    if (!state.selected.find(x => x.name === f.name)) state.selected.push(f);
  }
  if (bad.length) toast(`Not ZIP files: ${bad.join(', ')}`, 'error');
  if (state.selected.length > MAX_FILES) {
    state.selected = state.selected.slice(0, MAX_FILES);
    toast(`Capped at ${MAX_FILES} ZIPs`, 'info');
  }
  refreshChips();
}

function refreshChips() {
  const container = qs('#selected-chips');
  const btn       = qs('#upload-btn');
  const clear     = qs('#clear-btn');
  if (!container) return;

  container.innerHTML = state.selected.map((f, i) => `
    <div class="file-chip" data-idx="${i}">
      <span class="chip-icon">${icons.file}</span>
      <span>${f.name}</span>
      <span class="chip-size" style="color:var(--text-3);font-size:11px;">${fmtSize(f.size)}</span>
      <span class="chip-rm" data-idx="${i}" title="Remove">×</span>
    </div>
  `).join('');

  container.querySelectorAll('.chip-rm').forEach(el =>
    el.addEventListener('click', () => {
      state.selected.splice(+el.dataset.idx, 1);
      refreshChips();
    })
  );

  btn.disabled  = state.selected.length === 0;
  clear.style.display = state.selected.length > 0 ? 'inline-flex' : 'none';
}

async function doUpload() {
  const btn = qs('#upload-btn');
  btn.disabled = true;
  btn.textContent = 'Reading ZIP headers…';

  state.zips = [];
  try {
    for (let i = 0; i < state.selected.length; i++) {
      const f = state.selected[i];
      const zip = await JSZip.loadAsync(f);
      const validImages = Object.keys(zip.files)
        .filter(isValidImage)
        .sort(); // sort by name alphabetically

      state.zips.push({
        id: i,
        name: f.name,
        size: f.size,
        imageCount: validImages.length,
        order: i,
        fileObj: f,
        validImages: validImages,
        thumbnailUrl: null
      });
    }

    state.pages = [];
    state.selectedPages = new Set();
    state.selected = [];
    state.pdfNameDirty = false;
    syncDefaultPdfName(true);
    goto('review');
  } catch (e) {
    toast('Error reading ZIP files. Are they corrupted?', 'error');
    console.error(e);
    btn.disabled  = false;
    btn.innerHTML = `Continue ${icons.arrow}`;
  }
}

/* ── Step: Review ────────────────────────────────────────────────────────── */
function renderReview() {
  const totalImages = state.zips.reduce((a, z) => a + z.imageCount, 0);
  const totalSize   = state.zips.reduce((a, z) => a + z.size, 0);

  qs('#main-content').innerHTML = `
    <div class="section-heading">
      <h1>Review ZIP order</h1>
      <p>Drag to arrange ZIPs in the correct sequence before generating.</p>
    </div>

    <div class="summary-bar">
      <span class="tag">${state.zips.length} ZIPs</span>
      <span class="info">${totalImages.toLocaleString()} images total</span>
      <span class="info" style="color:var(--text-3)">${fmtSize(totalSize)}</span>
    </div>

    <label class="pdf-name-field" for="pdf-name-input">
      <span>PDF Name</span>
      <input
        id="pdf-name-input"
        type="text"
        value="${escapeAttr(state.pdfName)}"
        maxlength="${MAX_PDF_NAME_LEN}"
        autocomplete="off"
        spellcheck="false"
      />
    </label>

    <div class="zip-list" id="zip-list">
      ${state.zips.sort((a,b) => a.order - b.order).map(z => zipCardHtml(z)).join('')}
    </div>

    <div class="hint-text">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Grab the <strong style="color:var(--text-2)">&nbsp;⠿ handle&nbsp;</strong> to reorder
    </div>

    <div class="action-row" style="margin-top:28px">
      <button class="btn btn-ghost" id="back-btn">${icons.back} Back</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="generate-btn">
        Preview Pages ${icons.arrow}
      </button>
    </div>
  `;

  initSortable();
  lazyLoadZipThumbnails();

  qs('#pdf-name-input').addEventListener('input', e => {
    const cleaned = sanitizePdfBase(e.target.value);
    if (cleaned !== e.target.value) e.target.value = cleaned;
    state.pdfName = cleaned;
    state.pdfNameDirty = true;
  });

  qs('#pdf-name-input').addEventListener('blur', e => {
    state.pdfName = sanitizePdfBase(e.target.value).trim();
    e.target.value = state.pdfName;
  });

  qs('#back-btn').addEventListener('click', clearCache);
  qs('#generate-btn').addEventListener('click', doPreview);
}

function zipCardHtml(z) {
  return `
    <div class="zip-card" data-id="${z.id}">
      <div class="zip-order">${z.order + 1}</div>
      <div class="zip-thumb" id="thumb-${z.id}">
        <span class="thumb-placeholder">${icons.image}</span>
      </div>
      <div class="zip-info">
        <div class="zip-name" title="${z.name}">${z.name}</div>
        <div class="zip-meta">
          <span>${icons.image} ${z.imageCount.toLocaleString()} images</span>
          <span>${fmtSize(z.size)}</span>
        </div>
      </div>
      ${dragHandle()}
    </div>`;
}

async function lazyLoadZipThumbnails() {
  for (const z of state.zips) {
    if (z.imageCount === 0) continue;
    
    // Check if we already created one
    if (!z.thumbnailUrl) {
      const firstEntry = z.validImages[0];
      z.thumbnailUrl = await createThumbnailBlob(z.fileObj, firstEntry);
    }
    
    const el = qs(`#thumb-${z.id}`);
    if (el && z.thumbnailUrl) {
      const img = new Image();
      img.src = z.thumbnailUrl;
      img.onload = () => { el.innerHTML = ''; el.appendChild(img); };
    }
  }
}

function initSortable() {
  const list = qs('#zip-list');
  new Sortable(list, {
    handle:              '.drag-handle',
    animation:           180,
    delay:               120,
    delayOnTouchOnly:    true,
    touchStartThreshold: 5,
    ghostClass:          'sortable-ghost',
    chosenClass:         'sortable-chosen',
    onEnd() {
      // Read new DOM order and sync state
      const newOrder = qsa('#zip-list .zip-card').map(c => +c.dataset.id);
      state.zips.sort((a,b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
      state.zips.forEach((z, i) => { z.order = i; });
      state.pages = [];
      state.selectedPages = new Set();

      // Update visual order badges
      qsa('#zip-list .zip-order').forEach((el, i) => { el.textContent = i + 1; });

      syncDefaultPdfName();
      updatePdfNameInput();
    }
  });
}

async function doPreview() {
  const btn = qs('#generate-btn');
  const outputName = finalPdfName();
  if (!outputName) {
    toast('PDF name cannot be empty', 'error');
    qs('#pdf-name-input')?.focus();
    return;
  }

  state.pdfName = stripExt(outputName, '.pdf');
  updatePdfNameInput();
  btn.disabled = true;
  btn.textContent = 'Extracting Previews...';

  try {
    // Generate page objects across all ordered zips
    state.pages = [];
    let globalIdx = 1;
    
    // Sort zips by order just in case
    const sortedZips = [...state.zips].sort((a,b) => a.order - b.order);

    for (const z of sortedZips) {
      for (const entryName of z.validImages) {
        state.pages.push({
          page: globalIdx++,
          zipId: z.id,
          zipName: z.name,
          imageName: entryName.split('/').pop(),
          entryName: entryName,
          thumbnailUrl: null // will be lazy loaded
        });
      }
    }

    state.selectedPages = new Set(state.pages.map(p => p.page));
    goto('preview');
  } catch (e) {
    toast('Failed to prepare preview', 'error');
    btn.disabled = false;
    btn.innerHTML = `Preview Pages ${icons.arrow}`;
  }
}

/* ── Step: Preview ───────────────────────────────────────────────────────── */
function renderPreview() {
  const selected = state.selectedPages.size;
  const total = state.pages.length;

  qs('#main-content').innerHTML = `
    <div class="section-heading">
      <h1>Preview pages</h1>
      <p>Check thumbnails and choose which images should be included.</p>
    </div>

    <div class="page-size-selector">
      <h3>Page Size</h3>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" name="page-size" value="original" ${state.pageSize === 'original' ? 'checked' : ''}>
          <div class="radio-content">
            <span class="radio-title">Original</span>
            <span class="radio-desc">Dimensions vary per image</span>
          </div>
        </label>
        <label class="radio-label">
          <input type="radio" name="page-size" value="a4" ${state.pageSize === 'a4' ? 'checked' : ''}>
          <div class="radio-content">
            <span class="radio-title">A4</span>
            <span class="radio-desc">Fit into standard A4 sheets</span>
          </div>
        </label>
        <label class="radio-label recommended">
          <input type="radio" name="page-size" value="smart" ${state.pageSize === 'smart' ? 'checked' : ''}>
          <div class="radio-content">
            <span class="radio-title">Smart Auto Size <span class="tag-rec">Recommended</span></span>
            <span class="radio-desc">Detect most suitable uniform size</span>
          </div>
        </label>
      </div>
    </div>

    <div class="preview-toolbar">
      <div>
        <span class="tag" id="selected-count">${selected.toLocaleString()} selected</span>
        <span class="preview-total">${total.toLocaleString()} pages</span>
      </div>
      <div class="bulk-actions">
        <button class="btn btn-ghost" id="select-all-btn">Select All</button>
        <button class="btn btn-ghost" id="deselect-all-btn">Deselect All</button>
        <button class="btn btn-ghost" id="invert-btn">Invert Selection</button>
      </div>
    </div>

    <div class="preview-grid" id="preview-grid">
      ${state.pages.map(pageCardHtml).join('')}
    </div>

    <div class="action-row" style="margin-top:28px">
      <button class="btn btn-ghost" id="preview-back-btn">${icons.back} Back</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="generate-btn">
        Generate PDF ${icons.arrow}
      </button>
    </div>
  `;

  initPreviewEvents();
  lazyLoadAllPageThumbnails();
}

function pageCardHtml(p) {
  const checked = state.selectedPages.has(p.page) ? 'checked' : '';
  return `
    <label class="page-card ${checked ? 'selected' : ''}" data-page="${p.page}">
      <div class="page-card-top">
        <span>Page ${p.page}</span>
        <input class="page-check" type="checkbox" data-page="${p.page}" ${checked} />
      </div>
      <div class="page-thumb" id="page-thumb-${p.page}">
        ${p.thumbnailUrl ? `<img src="${p.thumbnailUrl}" loading="lazy" />` : `<span class="thumb-placeholder">${icons.image}</span>`}
      </div>
      <div class="page-name" title="${escapeAttr(p.entryName)}">${escapeHtml(p.imageName)}</div>
      <div class="page-zip" title="${escapeAttr(p.zipName)}">${escapeHtml(p.zipName)}</div>
    </label>`;
}

async function lazyLoadAllPageThumbnails() {
  // Use a map to cache zip instances for this loop so we don't reload async 100 times
  const zipCache = {};
  for (const p of state.pages) {
    if (p.thumbnailUrl) continue; // already loaded

    const zipState = state.zips.find(z => z.id === p.zipId);
    if (!zipCache[p.zipId]) {
      zipCache[p.zipId] = await JSZip.loadAsync(zipState.fileObj);
    }
    const zip = zipCache[p.zipId];
    
    try {
      const file = zip.file(p.entryName);
      if (file) {
        const buffer = await file.async("arraybuffer");
        let ext = p.entryName.split('.').pop().toLowerCase();
        if (ext === 'jpg') ext = 'jpeg';
        const blob = new Blob([buffer], { type: `image/${ext}` });
        p.thumbnailUrl = URL.createObjectURL(blob);

        const el = qs(`#page-thumb-${p.page}`);
        if (el) {
          el.innerHTML = `<img src="${p.thumbnailUrl}" loading="lazy" />`;
        }
      }
    } catch(e) {
      console.warn("Failed thumb for", p.entryName);
    }
  }
}

function initPreviewEvents() {
  qs('#preview-back-btn').addEventListener('click', () => goto('review'));
  qs('#generate-btn').addEventListener('click', doGenerate);
  
  qsa('input[name="page-size"]').forEach(el => {
    el.addEventListener('change', e => {
      if (e.target.checked) state.pageSize = e.target.value;
    });
  });
  qs('#select-all-btn').addEventListener('click', () => {
    state.selectedPages = new Set(state.pages.map(p => p.page));
    renderPreview();
  });
  qs('#deselect-all-btn').addEventListener('click', () => {
    state.selectedPages = new Set();
    renderPreview();
  });
  qs('#invert-btn').addEventListener('click', () => {
    const next = new Set();
    state.pages.forEach(p => {
      if (!state.selectedPages.has(p.page)) next.add(p.page);
    });
    state.selectedPages = next;
    renderPreview();
  });

  qs('#preview-grid').addEventListener('change', e => {
    if (!e.target.classList.contains('page-check')) return;
    const page = +e.target.dataset.page;
    if (e.target.checked) state.selectedPages.add(page);
    else state.selectedPages.delete(page);
    e.target.closest('.page-card')?.classList.toggle('selected', e.target.checked);
    updatePreviewSummary();
  });
}

function updatePreviewSummary() {
  const count = qs('#selected-count');
  if (count) count.textContent = `${state.selectedPages.size.toLocaleString()} selected`;
}

async function doGenerate() {
  const btn = qs('#generate-btn');
  const outputName = finalPdfName();
  const pages = selectedPageList();
  
  if (!outputName) {
    toast('PDF name cannot be empty', 'error');
    qs('#pdf-name-input')?.focus();
    return;
  }
  if (!pages.length) {
    toast('Select at least one page', 'error');
    return;
  }

  state.pdfName = stripExt(outputName, '.pdf');
  updatePdfNameInput();
  btn.disabled = true;
  
  state.startTime   = Date.now();
  state.totalImages = pages.length;
  state.isGenerating = true;
  goto('processing');

  // Let DOM update before heavy sync work
  setTimeout(() => runPdfGenerationTask(outputName, pages), 100);
}

/* ── Step: Processing (jsPDF Offline Generation) ─────────────────────────── */
function renderProcessing() {
  const zipNames = state.zips.map((z, i) =>
    `<span class="processing-zip-tag" id="ztag-${z.id}">${z.name}</span>`
  ).join('');

  qs('#main-content').innerHTML = `
    <div class="processing-wrap">
      <div class="section-heading" style="text-align:center">
        <h1>Forging your PDF…</h1>
        <p class="sub" id="progress-msg">Preparing Offline Generation…</p>
      </div>

      <div class="progress-outer">
        <div class="progress-bar" id="progress-bar" style="width:0%"></div>
      </div>
      <div class="progress-meta">
        <span id="progress-detail">Starting up</span>
        <span class="progress-pct" id="progress-pct">0%</span>
      </div>

      <div class="processing-zips">${zipNames}</div>
    </div>
  `;
}

function setProgress(pct, detailMsg) {
  const bar    = qs('#progress-bar');
  const pctEl  = qs('#progress-pct');
  const detail = qs('#progress-detail');
  const msg    = qs('#progress-msg');

  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (detail && detailMsg) detail.textContent = detailMsg;
  if (msg && state.startTime) {
    msg.textContent = `Running offline for ${fmtTime(Date.now() - state.startTime)}`;
  }
}

// Convert image Blob to HTMLImageElement wrapped in Promise
function loadImage(blobUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = blobUrl;
  });
}

async function runPdfGenerationTask(outputName, selectedPageNumbers) {
  try {
    const { jsPDF } = window.jspdf;
    
    // We need to resolve which images to load
    const pagesToProcess = state.pages.filter(p => selectedPageNumbers.includes(p.page));
    
    // 1) Analyze dimensions for Smart Auto
    let smartW = 0, smartH = 0;
    
    if (state.pageSize === 'smart') {
      setProgress(5, "Analyzing image dimensions...");
      const dimCounts = {};
      
      for (let i = 0; i < pagesToProcess.length; i++) {
        // Sample up to 50 images to find the most common ratio
        if (i > 50) break;
        const p = pagesToProcess[i];
        try {
          const img = await loadImage(p.thumbnailUrl);
          const key = `${img.width}x${img.height}`;
          dimCounts[key] = (dimCounts[key] || 0) + 1;
        } catch(e) {}
      }
      
      let bestKey = null;
      let maxCount = 0;
      for (const [key, count] of Object.entries(dimCounts)) {
        if (count > maxCount) {
          maxCount = count;
          bestKey = key;
        }
      }
      
      if (bestKey) {
        const [w, h] = bestKey.split('x').map(Number);
        smartW = w;
        smartH = h;
      } else {
        // Fallback A4 at 72dpi
        smartW = 595.28;
        smartH = 841.89;
      }
    }

    // Initialize Document
    // Default orientation portrait unless smart dimension is landscape
    const defaultOrientation = (smartW > smartH) ? 'l' : 'p';
    let doc = new jsPDF({
      orientation: state.pageSize === 'smart' ? defaultOrientation : 'p',
      unit: 'pt',
      format: state.pageSize === 'a4' ? 'a4' : (state.pageSize === 'smart' ? [smartW, smartH] : 'a4')
    });
    // Remove default first page
    doc.deletePage(1);

    const A4_W = 595.28;
    const A4_H = 841.89;

    let processedCount = 0;
    const total = pagesToProcess.length;

    for (let i = 0; i < total; i++) {
      const p = pagesToProcess[i];
      setProgress(10 + Math.floor((i / total) * 80), `Processing page ${i+1} of ${total}`);
      
      try {
        const img = await loadImage(p.thumbnailUrl);
        const origW = img.width;
        const origH = img.height;
        
        let targetW, targetH;
        let pdfW, pdfH;
        
        if (state.pageSize === 'original') {
          pdfW = origW;
          pdfH = origH;
          doc.addPage([pdfW, pdfH], pdfW > pdfH ? 'l' : 'p');
          doc.addImage(img, 'JPEG', 0, 0, pdfW, pdfH, undefined, 'FAST');
        } 
        else if (state.pageSize === 'a4') {
          pdfW = A4_W;
          pdfH = A4_H;
          doc.addPage('a4', 'p');
          
          // Fit into A4
          const scale = Math.min(pdfW / origW, pdfH / origH);
          targetW = origW * scale;
          targetH = origH * scale;
          const x = (pdfW - targetW) / 2;
          const y = (pdfH - targetH) / 2;
          
          // White background
          doc.setFillColor(255, 255, 255);
          doc.rect(0, 0, pdfW, pdfH, 'F');
          
          doc.addImage(img, 'JPEG', x, y, targetW, targetH, undefined, 'FAST');
        } 
        else if (state.pageSize === 'smart') {
          pdfW = smartW;
          pdfH = smartH;
          doc.addPage([pdfW, pdfH], pdfW > pdfH ? 'l' : 'p');
          
          // Fit into smart size
          const scale = Math.min(pdfW / origW, pdfH / origH);
          targetW = origW * scale;
          targetH = origH * scale;
          const x = (pdfW - targetW) / 2;
          const y = (pdfH - targetH) / 2;
          
          doc.setFillColor(255, 255, 255);
          doc.rect(0, 0, pdfW, pdfH, 'F');
          doc.addImage(img, 'JPEG', x, y, targetW, targetH, undefined, 'FAST');
        }
        
      } catch(e) {
        console.error("Failed to add page", p.entryName, e);
      }
      processedCount++;
    }

    setProgress(95, "Finalizing PDF...");
    
    // Save to Blob and get size
    const pdfBlob = doc.output('blob');
    state.pdfSize = pdfBlob.size;
    state.pdfBlobUrl = URL.createObjectURL(pdfBlob);
    
    state.isGenerating = false;
    goto('complete');

  } catch (e) {
    console.error(e);
    state.isGenerating = false;
    const main = qs('#main-content');
    main.innerHTML += `
      <div class="error-box">
        <h3>Generation failed</h3>
        <p>${e.message || 'An unexpected error occurred during offline generation.'}</p>
        <button class="btn btn-ghost" onclick="App.goto('review')">← Go back</button>
      </div>`;
  }
}

/* ── Step: Complete ──────────────────────────────────────────────────────── */
function renderComplete() {
  const elapsed = state.startTime ? fmtTime(Date.now() - state.startTime) : '—';
  const sizeFmt = state.pdfSize ? fmtSize(state.pdfSize) : '—';

  qs('#main-content').innerHTML = `
    <div class="complete-wrap">
      <div class="success-icon" aria-hidden="true">${icons.check}</div>

      <div class="section-heading" style="text-align:center">
        <h1>PDF ready!</h1>
        <p>Your images have been successfully merged offline.</p>
      </div>

      <div class="complete-stats">
        <div class="stat-item">
          <div class="stat-val">${state.totalImages.toLocaleString()}</div>
          <div class="stat-lbl">Pages</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">${sizeFmt}</div>
          <div class="stat-lbl">File size</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">${elapsed}</div>
          <div class="stat-lbl">Time taken</div>
        </div>
      </div>

      <div class="complete-actions">
        <button class="btn btn-success" id="dl-btn">${icons.dl} Download PDF</button>
        <button class="btn btn-ghost"   id="again-btn">Start over (Clear Memory)</button>
      </div>
    </div>
  `;

  qs('#dl-btn').addEventListener('click', () => {
    if (!state.pdfBlobUrl) return;
    const a = document.createElement('a');
    a.href     = state.pdfBlobUrl;
    a.download = finalPdfName() || 'zipforge_output.pdf';
    a.click();
  });

  qs('#again-btn').addEventListener('click', clearCache);
}

/* ── Navigation ──────────────────────────────────────────────────────────── */
function goto(step) {
  state.step = step;
  renderStepNav();
  qs('#main-content')?.classList.toggle('wide', step === 'preview');
  const renders = {
    upload:     renderUpload,
    review:     renderReview,
    preview:    renderPreview,
    processing: renderProcessing,
    complete:   renderComplete,
  };
  renders[step]?.();
}

function resetApp() {
  clearCache();
}

/* ── Bootstrap ───────────────────────────────────────────────────────────── */
window.App = { goto, resetApp };
goto('upload');
