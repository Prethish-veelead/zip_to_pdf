/* ── Config ──────────────────────────────────────────────────────────────── */
const MAX_FILE_MB  = 300;
const MAX_FILES    = 30;
const MAX_PDF_NAME_LEN = 100;
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/* ── Capacitor & Plugins ─────────────────────────────────────────────────── */
const { Capacitor } = window;
const { Filesystem, Share, FileOpener } = Capacitor?.Plugins || {};
const Directory = { Cache: 'CACHE', Data: 'DATA', External: 'EXTERNAL', Documents: 'DOCUMENTS' };
const JSZip = window.JSZip;
const { PDFDocument, rgb } = window.PDFLib || {};

/* ── Global State (UI sync) ─────────────────────────────────────────────── */
const state = {
  step:       'upload',
  zips:       [],         
  pages:      [],         
  selectedPages:new Set(),
  selected:   [],         
  startTime:  null,
  totalImages:0,
  pdfSize:    0,
  pdfName:    '',
  pdfNameDirty:false,
  pageSize:   'smart',
  pdfPath:    null,
  isGenerating: false,
  jobId:      null,
  outputFolder: localStorage.getItem('zipforge_output_folder') || 'ZipForge'
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

function sanitizePdfName(raw) {
  let name = raw.replace(INVALID_FILENAME_CHARS, '');
  name = name.trim();
  if (!name) name = 'ZipForge_Output';
  if (name.length > 100) name = name.slice(0, 100);
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  return name;
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

/* ── Device Handlers ─────────────────────────────────────────────────────── */
function isLowRamDevice() {
  return (navigator.deviceMemory && navigator.deviceMemory <= 4);
}

/* ── Storage Pipeline Helpers ────────────────────────────────────────────── */
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(uint8Array) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function generateJobId() {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function readState(jobId) {
  if (!Filesystem) return null;
  const result = await Filesystem.readFile({
    directory: Directory.Data,
    path: `zippdf/${jobId}/state.json`,
    encoding: 'utf8'
  });
  return JSON.parse(result.data);
}

async function writeState(jobId, stateObj) {
  if (!Filesystem) return;
  await Filesystem.writeFile({
    directory: Directory.Data,
    path: `zippdf/${jobId}/state.json`,
    data: JSON.stringify(stateObj),
    encoding: 'utf8',
    recursive: true
  });
}

async function updateState(jobId, fields) {
  if (!Filesystem) return;
  const s = await readState(jobId);
  if (s) {
    Object.assign(s, fields);
    await writeState(jobId, s);
  }
}

// Convert image buffer to base64, preserving format
function bufferToBase64Image(buffer, ext) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/* ── Memory Management & Cleanup ─────────────────────────────────────────── */
async function cleanupJob(jobId) {
  if (!Filesystem) return 0;
  let freed = 0;
  
  async function calcSize(dir, p) {
    let s = 0;
    try {
      const list = await Filesystem.readdir({ directory: dir, path: p });
      for (const f of list.files) {
        if (f.type === 'file') s += f.size || 0;
        else if (f.type === 'directory') s += await calcSize(dir, `${p}/${f.name}`);
      }
    } catch(e) {}
    return s;
  }

  try {
    freed += await calcSize(Directory.Cache, `zippdf/${jobId}`);
    await Filesystem.rmdir({
      directory: Directory.Cache,
      path: `zippdf/${jobId}`,
      recursive: true
    });
  } catch (e) { console.warn('Cache cleanup:', e); }

  try {
    const stateStat = await Filesystem.stat({
      directory: Directory.Data,
      path: `zippdf/${jobId}/state.json`
    });
    if(stateStat) freed += stateStat.size || 0;
    
    await Filesystem.deleteFile({
      directory: Directory.Data,
      path: `zippdf/${jobId}/state.json`
    });
  } catch (e) { console.warn('State cleanup:', e); }
  
  return freed;
}

async function cleanupAbandonedJobs() {
  if (!Filesystem) return;
  try {
    const list = await Filesystem.readdir({
      directory: Directory.Cache,
      path: 'zippdf'
    });
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const folder of list.files) {
      const folderName = folder.name;
      const stateResult = await Filesystem.readFile({
        directory: Directory.Data,
        path: `zippdf/${folderName}/state.json`
      }).catch(() => null);
      if (!stateResult) {
        await Filesystem.rmdir({
          directory: Directory.Cache,
          path: `zippdf/${folderName}`,
          recursive: true
        }).catch(() => {});
        continue;
      }
      const s = JSON.parse(stateResult.data);
      if (new Date(s.createdAt).getTime() < oneDayAgo) {
        await cleanupJob(folderName);
      }
    }
  } catch (e) { /* no jobs folder yet */ }
}

async function cleanupOldPDFs() {
  if (!Filesystem) return;
  const cleanFolder = state.outputFolder.trim() || 'ZipForge';
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // 1. Cleanup PDFs older than 24h in the output folder
  try {
    const res = await Filesystem.readdir({
      directory: Directory.Documents,
      path: cleanFolder
    });
    for (const f of res.files) {
      if (f.name.endsWith('.pdf') && f.mtime > 0 && (now - f.mtime > ONE_DAY)) {
        await Filesystem.deleteFile({
          directory: Directory.Documents,
          path: `${cleanFolder}/${f.name}`
        }).catch(()=>{});
      }
    }
  } catch (e) {}

  // 2. Cleanup legacy 'job_' folders that were incorrectly created in Documents root
  try {
    const rootRes = await Filesystem.readdir({
      directory: Directory.Documents,
      path: ''
    });
    for (const f of rootRes.files) {
      if (f.type === 'directory' && f.name.startsWith('job_')) {
        await Filesystem.rmdir({
          directory: Directory.Documents,
          path: f.name,
          recursive: true
        }).catch(()=>{});
      }
    }
  } catch(e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  if (Capacitor && Capacitor.isNativePlatform()) {
    cleanupAbandonedJobs();
    cleanupOldPDFs();
  }
  
  const pathInput = qs('#output-path-input');
  if (pathInput) {
    pathInput.value = state.outputFolder;
    pathInput.addEventListener('input', e => {
      let val = e.target.value.replace(/[\\:*?"<>|]/g, '').trim();
      if (!val) val = 'ZipForge';
      state.outputFolder = val;
      localStorage.setItem('zipforge_output_folder', val);
    });
  }

  // Bottom Navigation Listeners
  const navZipBtn = qs('#nav-zip-btn');
  const navHistoryBtn = qs('#nav-history-btn');
  const navSettingsBtn = qs('#nav-settings-btn');
  
  if (navZipBtn) navZipBtn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    navZipBtn.classList.add('active');
    goto('upload');
  });
  if (navHistoryBtn) navHistoryBtn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    navHistoryBtn.classList.add('active');
    goto('history');
  });
  
  // Settings Modal Listeners
  const settingsModal = qs('#settings-modal');
  const closeSettingsBtn = qs('#close-settings-btn');
  if (navSettingsBtn && settingsModal) {
    navSettingsBtn.addEventListener('click', () => {
      settingsModal.classList.add('active');
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      navSettingsBtn.classList.add('active');
    });
    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.classList.remove('active');
      // restore active state to whatever screen is actually visible
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      if (qs('#history-list')) navHistoryBtn.classList.add('active');
      else navZipBtn.classList.add('active');
    });
  }
  
  // Clear Cache
  const clearCacheBtn = qs('#clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      clearCache();
      toast('Temporary data cleared', 'success');
    });
  }

  // Theme Toggle Listeners
  const themeBtns = document.querySelectorAll('.theme-btn');
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('zipforge_theme', theme);

      // Update active state
      themeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  const savedTheme = localStorage.getItem('zipforge_theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
    const activeBtn = Array.from(themeBtns).find(b => b.dataset.theme === savedTheme);
    if (activeBtn) activeBtn.classList.add('active');
  } else {
    const darkBtn = Array.from(themeBtns).find(b => b.dataset.theme === 'dark');
    if (darkBtn) darkBtn.classList.add('active');
  }
  
  goto('upload');
});

async function clearCache() {
  let freed = 0;
  if (state.jobId) {
    freed += await cleanupJob(state.jobId);
  }
  
  // Also clean up any abandoned jobs to free maximum space
  if (Filesystem) {
    try {
      const list = await Filesystem.readdir({ directory: Directory.Cache, path: 'zippdf' });
      for (const folder of list.files) {
         if (folder.name !== state.jobId) {
            freed += await cleanupJob(folder.name);
         }
      }
    } catch(e) {}
  }

  Object.assign(state, {
    zips: [], pages: [], selectedPages: new Set(), selected: [],
    startTime: null, totalImages: 0, pdfSize: 0,
    pdfName: '', pdfNameDirty: false, pageSize: 'smart',
    pdfPath: null, isGenerating: false, jobId: null
  });
  
  goto('upload');
  
  if (freed > 0) {
    const mb = (freed / (1024 * 1024)).toFixed(2);
    toast(`${mb} MB of cache data successfully cleared!`, 'success');
  } else {
    toast('Cache is already fully clean.', 'info');
  }
}

/* ── SVG Icons ───────────────────────────────────────────────────────────── */
const icons = {
  upload: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  file:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  check:  `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  dl:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  eye:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
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

function getStepNavHtml() {
  const cur = STEPS.findIndex(s => s.key === state.step);
  const stepsHtml = STEPS.map((s, i) => {
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
  return `<nav id="step-nav" class="step-nav" aria-label="Progress steps">${stepsHtml}</nav>`;
}

/* ── Navigation ──────────────────────────────────────────────────────────── */
function goto(stepKey) {
  state.step = stepKey;
  if (stepKey === 'upload') renderUpload();
  else if (stepKey === 'review') renderReview();
  else if (stepKey === 'preview') renderPreview();
  else if (stepKey === 'processing') renderProcessing();
  else if (stepKey === 'complete') renderComplete();
  else if (stepKey === 'history') renderHistory();
}

/* ── JSZip Helpers ───────────────────────────────────────────────────────── */
const VALID_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

function isValidImage(filename) {
  if (filename.startsWith('__MACOSX/') || filename.includes('/.')) return false;
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return ext && VALID_EXT.includes(ext[0]);
}

async function getImageDimensionsFromBuffer(buffer, mime) {
  return new Promise((resolve) => {
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.width, height: img.height });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

// Memory-safe extraction to storage
async function extractZipToStorage(jobId, zips) {
  let globalIdx = 1;
  const stateData = {
    jobId: jobId,
    status: 'extracting',
    progress: 0,
    totalImages: state.totalImages,
    processedImages: 0,
    pdfName: '',
    pageMode: 'smart',
    pdfPath: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    zipFiles: [],
    pages: []
  };

  await writeState(jobId, stateData);

  for (const z of zips) {
    const zip = await JSZip.loadAsync(z.fileObj);
    
    for (const entryName of z.validImages) {
      const file = zip.file(entryName);
      if (!file) continue;

      const buffer = await file.async("arraybuffer");
      let ext = entryName.split('.').pop().toLowerCase();
      if (ext === 'jpg') ext = 'jpeg';
      const mime = `image/${ext}`;
      
      const dims = await getImageDimensionsFromBuffer(buffer, mime);

      const base64Data = bufferToBase64Image(buffer, ext);
      await Filesystem.writeFile({
        directory: Directory.Cache,
        path: `zippdf/${jobId}/imgs/${globalIdx}.${ext}`,
        data: base64Data,
        recursive: true
      });
      // Thumbnails reuse the imgs/ files — no duplicate write needed.

      stateData.pages.push({
        index: globalIdx,
        fileName: entryName.split('/').pop(),
        zipName: z.name,
        width: dims.width,
        height: dims.height,
        included: true,
        ext: ext
      });

      state.pages.push({
        page: globalIdx,
        zipId: z.id,
        zipName: z.name,
        imageName: entryName.split('/').pop(),
        entryName: entryName,
        thumbnailUrl: null,
        ext: ext
      });

      globalIdx++;
      
      if (globalIdx % 20 === 0) {
        stateData.processedImages = globalIdx;
        stateData.progress = Math.floor((globalIdx / state.totalImages) * 50); // 50% for extraction
        await writeState(jobId, stateData);
      }
    }
  }

  stateData.progress = 50;
  await writeState(jobId, stateData);
  state.selectedPages = new Set(state.pages.map(p => p.page));
}

/* ── Step: Upload ────────────────────────────────────────────────────────── */
function renderUpload() {
  const main = qs('#main-content');
  main.innerHTML = `
    <div class="section-heading">
      <h1>Convert ZIPs to PDF</h1>
      <p>Upload your ZIP files — we'll stack all images into one clean PDF offline.</p>
    </div>
    ${getStepNavHtml()}

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
      const validImages = Object.keys(zip.files).filter(isValidImage).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

      state.zips.push({
        id: i,
        name: f.name,
        size: f.size,
        imageCount: validImages.length,
        order: i,
        fileObj: f,
        validImages: validImages
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
    ${getStepNavHtml()}

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
        Extract & Preview ${icons.arrow}
      </button>
    </div>
  `;

  initSortable();

  // Load zip thumbnails async
  state.zips.forEach(z => {
    if (!z.fileObj) return;
    JSZip.loadAsync(z.fileObj).then(async zip => {
      const validImages = Object.keys(zip.files).filter(isValidImage).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (validImages.length > 0) {
        const file = zip.file(validImages[0]);
        const buffer = await file.async('arraybuffer');
        let ext = validImages[0].split('.').pop().toLowerCase();
        if (ext === 'jpg') ext = 'jpeg';
        const b64 = uint8ArrayToBase64(new Uint8Array(buffer));

        const img = document.createElement('img');
        img.src = `data:image/${ext};base64,` + b64;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        const thumbEl = qs(`#zip-thumb-${z.id}`);
        if (thumbEl) {
          thumbEl.innerHTML = '';
          thumbEl.appendChild(img);
        }
      }
    }).catch(err => console.error("Thumbnail load error:", err));
  });

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
  qs('#generate-btn').addEventListener('click', doExtraction);
}

function zipCardHtml(z) {
  return `
    <div class="zip-card" data-id="${z.id}">
      <div class="zip-order">${z.order + 1}</div>
      <div class="zip-thumb" id="zip-thumb-${z.id}">
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

function initSortable() {
  const list = qs('#zip-list');
  new Sortable(list, {
    handle: '.drag-handle',
    animation: 180,
    onEnd() {
      const newOrder = qsa('#zip-list .zip-card').map(c => +c.dataset.id);
      state.zips.sort((a,b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
      state.zips.forEach((z, i) => { z.order = i; });
      qsa('#zip-list .zip-order').forEach((el, i) => { el.textContent = i + 1; });
      syncDefaultPdfName();
      updatePdfNameInput();
    }
  });
}

async function doExtraction() {
  const btn = qs('#generate-btn');
  const outputName = finalPdfName();
  if (!outputName) {
    toast('PDF name cannot be empty', 'error');
    return;
  }

  if (!Capacitor || !Capacitor.isNativePlatform()) {
    toast('This app must be run as an Android APK to use local processing.', 'error');
    return;
  }

  state.pdfName = stripExt(outputName, '.pdf');
  updatePdfNameInput();
  btn.disabled = true;
  btn.textContent = 'Extracting to Storage...';

  try {
    state.jobId = generateJobId();
    state.totalImages = state.zips.reduce((a, z) => a + z.imageCount, 0);
    const sortedZips = [...state.zips].sort((a,b) => a.order - b.order);
    
    await extractZipToStorage(state.jobId, sortedZips);

    goto('preview');
  } catch (e) {
    console.error(e);
    toast('Failed to extract to persistent storage', 'error');
    btn.disabled = false;
    btn.innerHTML = `Extract & Preview ${icons.arrow}`;
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
    ${getStepNavHtml()}

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
          <input type="radio" name="page-size" value="tight" ${state.pageSize === 'tight' ? 'checked' : ''}>
          <div class="radio-content">
            <span class="radio-title">Tight (No Upscaling)</span>
            <span class="radio-desc">Fits image exactly, large images reduced</span>
          </div>
        </label>
        <label class="radio-label">
          <input type="radio" name="page-size" value="uniform" ${state.pageSize === 'uniform' ? 'checked' : ''}>
          <div class="radio-content">
            <span class="radio-title">Uniform (Upscaling Allowed)</span>
            <span class="radio-desc">All pages match the largest image size</span>
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
  lazyLoadStorageThumbnails();
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
        <span class="thumb-placeholder">${icons.image}</span>
      </div>
      <div class="page-name" title="${escapeAttr(p.entryName)}">${escapeHtml(p.imageName)}</div>
    </label>`;
}

async function lazyLoadStorageThumbnails() {
  for (const p of state.pages) {
    if (!p.thumbnailUrl) {
      try {
        const path = `zippdf/${state.jobId}/imgs/${p.page}.${p.ext || 'jpg'}`;
        const result = await Filesystem.getUri({ directory: Directory.Cache, path: path });
        p.thumbnailUrl = Capacitor.convertFileSrc(result.uri);
      } catch(e) {}
    }
    const el = qs(`#page-thumb-${p.page}`);
    if (el && p.thumbnailUrl) {
      el.innerHTML = `<img src="${p.thumbnailUrl}" loading="lazy" />`;
    }
  }
}

function initPreviewEvents() {
  qs('#preview-back-btn').addEventListener('click', clearCache);
  qs('#generate-btn').addEventListener('click', doGenerate);
  
  qsa('input[name="page-size"]').forEach(el => {
    el.addEventListener('change', e => {
      if (e.target.checked) state.pageSize = e.target.value;
    });
  });

  qs('#preview-grid').addEventListener('change', e => {
    if (!e.target.classList.contains('page-check')) return;
    const page = +e.target.dataset.page;
    if (e.target.checked) state.selectedPages.add(page);
    else state.selectedPages.delete(page);
    e.target.closest('.page-card')?.classList.toggle('selected', e.target.checked);
    qs('#selected-count').textContent = `${state.selectedPages.size.toLocaleString()} selected`;
  });
}

async function doGenerate() {
  const btn = qs('#generate-btn');
  const pages = selectedPageList();
  
  if (!pages.length) {
    toast('Select at least one page', 'error');
    return;
  }

  // Check RAM flag for large jobs
  if (pages.length > 800 && isLowRamDevice()) {
    toast('Large job — may be slow on older devices. Please wait.', 'info');
  }

  btn.disabled = true;
  state.startTime = Date.now();
  state.isGenerating = true;
  
  updateState(state.jobId, {
    pageMode: state.pageSize,
    pdfName: state.pdfName
  });

  goto('processing');
  setTimeout(() => runPdfGenerationTask(pages), 100);
}

/* ── Step: Processing (pdf-lib Offline Generation) ───────────────────────── */
function renderProcessing() {
  qs('#main-content').innerHTML = `
    <div class="processing-wrap">
      <div class="section-heading" style="text-align:center">
        <h1>Forging your PDF…</h1>
        <p class="sub" id="progress-msg">Processing entirely offline</p>
      </div>
      ${getStepNavHtml()}

      <div class="progress-outer">
        <div class="progress-bar" id="progress-bar" style="width:0%"></div>
      </div>
      <div class="progress-meta">
        <span id="progress-detail">Starting up</span>
        <span class="progress-pct" id="progress-pct">0%</span>
      </div>
      
      <div id="animation-container" style="display: flex; justify-content: center; align-items: center; width: 100%; margin: 40px 0 20px 0;">
        <img id="process-animation" class="processing-animation" src="extracting.svg" alt="Processing Animation" style="height: 140px; object-fit: contain;" />
      </div>
    </div>
  `;
}

function setProgress(pct, detailMsg) {
  const bar    = qs('#progress-bar');
  const pctEl  = qs('#progress-pct');
  const detail = qs('#progress-detail');
  const anim   = qs('#process-animation');

  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (detail && detailMsg) detail.textContent = detailMsg;

  if (anim) {
    const currentSrc = anim.getAttribute('src') || '';
    if (pct < 40 && currentSrc !== 'extracting.svg') {
      anim.setAttribute('src', 'extracting.svg');
    } else if (pct >= 40 && pct < 90 && currentSrc !== 'forging.svg') {
      anim.setAttribute('src', 'forging.svg');
    } else if (pct >= 90 && currentSrc !== 'merging.svg') {
      anim.setAttribute('src', 'merging.svg');
    }
  }
}

async function runPdfGenerationTask(selectedPageNumbers) {
  try {
    const s = await readState(state.jobId);
    const pagesToProcess = s.pages.filter(p => selectedPageNumbers.includes(p.index));
    
    setProgress(10, 'Preparing images for native processing...');
    
    // 1. Gather absolute paths of extracted images
    const imagePaths = [];
    for (let i = 0; i < pagesToProcess.length; i++) {
      const p = pagesToProcess[i];
      const ext = p.ext || 'jpeg';
      const path = `zippdf/${state.jobId}/imgs/${p.index}.${ext}`;
      
      const uriResult = await Filesystem.getUri({
        directory: Directory.Cache,
        path: path
      });
      // BitmapFactory needs a real filesystem path, not a file:// URI
      let realPath = uriResult.uri;
      if (realPath.startsWith('file://')) {
        realPath = realPath.substring(7);
      }
      imagePaths.push(realPath);
    }

    const cleanFolder = state.outputFolder.trim().replace(/^\/+|\/+$/g, '') || 'ZipForge';
    const fileName = sanitizePdfName(state.pdfName);
    
    const { NativePdfGenerator } = Capacitor.Plugins;
    if (!NativePdfGenerator) {
       throw new Error("NativePdfGenerator plugin not found. Please sync your Android project.");
    }

    const CHUNK_SIZE = 100;
    const numChunks = Math.ceil(imagePaths.length / CHUNK_SIZE);
    const chunkPdfPaths = [];

    for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, imagePaths.length);
        const chunkImages = imagePaths.slice(start, end);
        
        const chunkPercent = Math.floor((i / numChunks) * 50); // 40% to 90%
        setProgress(40 + chunkPercent, `Generating PDF chunk ${i + 1} of ${numChunks}...`);

        const chunkResult = await NativePdfGenerator.generatePdf({
            images: chunkImages,
            outputName: `temp_chunk_${state.jobId}_${i}.pdf`,
            outputFolder: cleanFolder,
            pageSize: state.pageSize
        });
        
        chunkPdfPaths.push(chunkResult.path);
    }

    setProgress(90, 'Merging all PDF chunks into final file...');
    
    const result = await NativePdfGenerator.mergePdfs({
        chunks: chunkPdfPaths,
        outputName: fileName,
        outputFolder: cleanFolder
    });

    setProgress(95, 'Moving PDF to public Documents...');

    const docPath = `${cleanFolder}/${fileName}`;
    
    // Copy the generated PDF from Cache to public Documents
    await Filesystem.copy({
      from: result.path,
      directory: Directory.Cache,
      to: docPath,
      toDirectory: Directory.Documents
    });

    // Optionally delete the cache file to free up memory
    await Filesystem.deleteFile({
      path: result.path,
      directory: Directory.Cache
    }).catch(e => console.warn("Failed to clean up cache:", e));

    setProgress(100, 'Saving final PDF...');

    // Get the final URI so FileOpener/Share can use it
    const finalUri = await Filesystem.getUri({
      path: docPath,
      directory: Directory.Documents
    });

    state.pdfPath = finalUri.uri;
    
    await updateState(state.jobId, {
      status: 'complete',
      progress: 100,
      pdfPath: state.pdfPath,
      outputPath: docPath,
      completedAt: new Date().toISOString()
    });

    goto('complete');

  } catch (e) {
    console.error("PDF Generation Error", e);
    toast('Generation failed: ' + e.message, 'error');
  }
};

/* ── Step: Complete ──────────────────────────────────────────────────────── */
function renderComplete() {
  qs('#main-content').innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; text-align:center; padding: 24px 16px;">
      <div style="background: linear-gradient(135deg, var(--accent) 0%, #a25dfa 100%); width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 12px 24px rgba(111,81,250,0.3); margin-bottom: 24px; animation: scaleIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      
      <h1 style="font-size: 28px; font-weight: 800; margin-bottom: 8px; color: var(--text-1);">Success!</h1>
      <p style="font-size: 15px; color: var(--text-2); margin-bottom: 32px; max-width: 280px; line-height: 1.5;">Your PDF has been successfully generated and securely saved.</p>
      
      <div style="background: var(--bg-1); border: 1px solid var(--border); border-radius: 16px; padding: 16px; width: 100%; text-align: left; margin-bottom: 32px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size: 13px; color: var(--text-3);">Filename</span>
          <span style="font-size: 14px; font-weight: 600; color: var(--accent);">${escapeHtml(state.pdfName)}.pdf</span>
        </div>
        <div style="height: 1px; background: var(--border);"></div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size: 13px; color: var(--text-3);">Location</span>
          <span style="font-size: 12px; color: var(--text-2); max-width: 60%; word-break: break-all; text-align: right;">Internal Storage / Documents / ${escapeHtml(state.outputFolder)}</span>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; margin-bottom: 24px;">
        <button class="btn btn-secondary" id="preview-pdf-btn" style="border-radius: 12px; padding: 14px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          Preview
        </button>
        <button class="btn btn-primary" id="dl-btn" style="border-radius: 12px; padding: 14px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          Open
        </button>
      </div>
      
      <button class="btn btn-secondary" id="share-btn" style="width: 100%; border-radius: 12px; margin-bottom: 24px; padding: 14px; background: rgba(255,255,255,0.05);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
        Share PDF
      </button>

      <button id="start-over-btn" style="background: none; border: none; color: var(--text-3); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: underline; padding: 8px;">Convert Another File</button>
    </div>
    
    <style>
      @keyframes scaleIn { 0% { transform: scale(0); } 70% { transform: scale(1.1); } 100% { transform: scale(1); } }
    </style>
  `;

  qs('#dl-btn').addEventListener('click', async () => {
    if (state.pdfPath && FileOpener) {
      await FileOpener.open({
        filePath: state.pdfPath,
        contentType: 'application/pdf',
        openWithDefault: true
      });
    }
  });

  qs('#preview-pdf-btn').addEventListener('click', openFlipbookPreview);

  qs('#share-btn').addEventListener('click', async () => {
    if (state.pdfPath && Share) {
      await Share.share({
        title: state.pdfName,
        url: state.pdfPath,
        dialogTitle: 'Share your PDF'
      });
    }
  });

  qs('#start-over-btn').addEventListener('click', () => {
    cleanupJob(state.jobId);
    clearCache();
  });
}

function openFlipbookPreview() {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; background: #07090F;
    z-index: 9999; overflow-y: auto; -webkit-overflow-scrolling: touch;
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    position: sticky; top: env(safe-area-inset-top, 16px);
    left: calc(100% - 56px); display: block; width: 44px; height: 44px;
    background: rgba(255,255,255,0.12); border: none; border-radius: 50%;
    color: white; font-size: 18px; cursor: pointer; z-index: 10;
    margin: 16px 16px 0 auto;
  `;
  closeBtn.onclick = () => overlay.remove();
  overlay.appendChild(closeBtn);

  const flipbook = document.createElement('div');
  flipbook.style.cssText = `
    display: flex; flex-direction: column; align-items: center;
    gap: 4px; padding: 16px 0 calc(32px + env(safe-area-inset-bottom, 0px));
  `;

  const pages = selectedPageList();
  pages.forEach(async (pageIdx, i) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `width: 100%; position: relative; background: #0C1018; margin-bottom: 4px;`;

    const badge = document.createElement('div');
    badge.textContent = `${i + 1}`;
    badge.style.cssText = `
      position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7);
      color: rgba(255,255,255,0.7); font-size: 11px; font-family: monospace;
      padding: 2px 7px; border-radius: 10px; z-index: 2;
    `;
    wrapper.appendChild(badge);

    const img = document.createElement('img');
    img.style.cssText = `width: 100%; height: auto; display: block;`;
    img.loading = 'lazy';

    try {
      const path = `zippdf/${state.jobId}/imgs/${pageIdx}.${state.pages.find(p=>p.page===pageIdx)?.ext || 'jpg'}`;
      const uriResult = await Filesystem.getUri({ directory: Directory.Cache, path: path });
      img.src = Capacitor.convertFileSrc(uriResult.uri);
    } catch(e) {}

    wrapper.appendChild(badge);
    wrapper.appendChild(img);
    flipbook.appendChild(wrapper);
  });

  overlay.appendChild(flipbook);
  document.body.appendChild(overlay);
}

/* ── History View ─────────────────────────────────────────────────────────── */
async function renderHistory() {
  const main = qs('#main-content');
  main.innerHTML = `
    <div class="screen" style="padding: 16px;">
      <div class="header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
        <h2 style="margin:0; font-size:22px; font-weight:700;">Recent PDFs</h2>
        <button id="history-back-btn" class="btn-secondary" style="padding:6px 12px; font-size:12px;">Back</button>
      </div>
      <div id="history-list" style="display:flex; flex-direction:column; gap:12px;">
        <div style="text-align:center; color:var(--text-3); padding:20px;">Loading history...</div>
      </div>
    </div>
  `;

  qs('#history-back-btn').addEventListener('click', () => goto('upload'));

  const listEl = qs('#history-list');
  try {
    const cleanFolder = state.outputFolder.trim() || 'ZipForge';
    let res;
    try {
      res = await Filesystem.readdir({
        directory: Directory.Documents,
        path: cleanFolder
      });
    } catch (e) {
      listEl.innerHTML = `<div style="text-align:center; color:var(--text-3); padding:20px;">No recent PDFs found in "${escapeHtml(cleanFolder)}".</div>`;
      return;
    }

    const files = res.files
      .filter(f => f.name.endsWith('.pdf'))
      .map(f => ({
        name: f.name,
        path: `${cleanFolder}/${f.name}`,
        mtime: f.mtime || 0
      }));

    if (files.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; color:var(--text-3); padding:20px;">No recent PDFs found in "${escapeHtml(cleanFolder)}".</div>`;
      return;
    }

    // Auto-delete older than 24h
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const validFiles = [];

    for (const f of files) {
      if (f.mtime > 0 && (now - f.mtime > ONE_DAY)) {
        try {
          await Filesystem.deleteFile({ directory: Directory.Documents, path: f.path });
        } catch (e) { }
      } else {
        validFiles.push(f);
      }
    }

    validFiles.sort((a, b) => b.mtime - a.mtime);

    if (validFiles.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; color:var(--text-3); padding:20px;">No recent PDFs found.</div>`;
      return;
    }

    listEl.innerHTML = validFiles.map(f => `
      <div class="complete-card" style="display:flex; justify-content:space-between; align-items:center; padding:16px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px;">
        <div style="display:flex; flex-direction:column; overflow:hidden; flex:1; margin-right: 12px;">
          <span style="font-weight:600; font-size: 14px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; color: var(--text-1);">${escapeHtml(f.name)}</span>
          <span style="font-size:11px; color:var(--text-3); margin-top:4px;">${f.mtime > 0 ? new Date(f.mtime).toLocaleString() : 'Recently generated'}</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-primary open-hist-btn" data-path="${escapeHtml(f.path)}" style="padding:10px; width:auto; border-radius:8px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          </button>
          <button class="btn-secondary del-hist-btn" data-path="${escapeHtml(f.path)}" style="padding:10px; width:auto; border-radius:8px; border-color:var(--error); color:var(--error);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      </div>
    `).join('');

    // Listeners for history actions
    document.querySelectorAll('.open-hist-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!FileOpener) { toast('File opener not supported', 'error'); return; }
        try {
          const fileUri = await Capacitor.Plugins.Filesystem.getUri({ directory: Directory.Documents, path: btn.dataset.path });
          await FileOpener.open({ filePath: fileUri.uri, contentType: 'application/pdf', openWithDefault: true });
        } catch (e) {
          toast('Failed to open PDF', 'error');
        }
      });
    });

    document.querySelectorAll('.del-hist-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const path = btn.dataset.path;
        try {
          await Filesystem.deleteFile({ directory: Directory.Documents, path });
          toast('PDF Deleted', 'success');
          renderHistory(); // Refresh
        } catch (e) {
          toast('Failed to delete', 'error');
        }
      });
    });

  } catch (e) {
    listEl.innerHTML = `<div style="text-align:center; color:var(--error); padding:20px;">Failed to load history</div>`;
  }
}
