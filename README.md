# ZipForge — ZIP to PDF Converter

Upload multiple ZIP files full of images → reorder them → select pages → generate one merged PDF on Android.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Data Flow](#data-flow)
- [Frontend (app.js)](#frontend-appjs)
- [Backend (FastAPI)](#backend-fastapi)
- [Android Native Plugin](#android-native-plugin)
- [State & Data Structures](#state--data-structures)
- [Configuration](#configuration)
- [Setup & Running](#setup--running)
- [Limits](#limits)

---

## Overview

ZipForge is a **Capacitor 7 hybrid Android app** backed by a **FastAPI Python server**. The core workflow:

1. User uploads one or more ZIP files (each containing images)
2. App shows per-ZIP thumbnails; user reorders ZIPs via drag-and-drop
3. Images are extracted from ZIPs one at a time to device storage (memory-safe)
4. User previews all pages, selects/deselects, picks page size
5. Native Android Kotlin plugin generates the PDF using `android.graphics.pdf.PdfDocument`
6. User opens, shares, or downloads the final PDF

The memory-safety design is the key innovation: images are never all loaded into RAM at once. They stream from ZIP → device storage → native PDF canvas, with `bitmap.recycle()` called after every page.

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Android APK (Capacitor 7)        │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  WebView (frontend/)             │   │
│  │  HTML + CSS + Vanilla JS         │   │
│  │  JSZip · Sortable.js             │   │
│  └────────────┬─────────────────────┘   │
│               │ Capacitor Bridge        │
│  ┌────────────▼─────────────────────┐   │
│  │  Native Plugins                  │   │
│  │  • NativePdfGenerator (Kotlin)   │   │
│  │  • @capacitor/filesystem         │   │
│  │  • @capacitor/share              │   │
│  │  • @capacitor-community/file-opener│  │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
         │ HTTP (optional, web mode)
┌────────▼────────────────────────────────┐
│  FastAPI Python Backend                 │
│  main.py · worker.py · database.py      │
│  Pillow · ReportLab · SQLite            │
└─────────────────────────────────────────┘
```

The FastAPI backend is used in **web/desktop mode** only. In the Android app, all processing (ZIP extraction, PDF generation) happens on-device via Capacitor plugins — the backend is bypassed.

---

## Project Structure

```
zip_to_pdf/
├── frontend/
│   ├── index.html              # HTML shell: Capacitor scaffold, modals, nav
│   ├── app.js                  # ~1350 lines: full state machine, ZIP handling, UI rendering
│   ├── style.css               # ~500 lines: dark/light theme, mobile-first responsive
│   └── libs/
│       ├── jszip.min.js        # ZIP file parsing
│       └── Sortable.min.js     # Drag-to-reorder lists
│
├── backend/
│   ├── main.py                 # FastAPI routes (upload, job status, download, cleanup)
│   ├── worker.py               # Background PDF generation worker (memory-safe streaming)
│   ├── database.py             # SQLite connection + schema helpers
│   ├── config.py               # Limits and settings constants
│   ├── requirements.txt        # Python dependencies
│   ├── jobs.db                 # SQLite database (auto-created)
│   └── uploads/                # Temporary job storage (auto-created)
│
├── android/
│   └── app/src/main/
│       ├── java/com/zipforge/app/
│       │   ├── MainActivity.java          # Capacitor entry point; registers plugins
│       │   └── NativePdfGenerator.kt      # Native PDF generation plugin (Kotlin)
│       ├── assets/public/                 # Bundled frontend (copied by Capacitor sync)
│       ├── AndroidManifest.xml            # Permissions + largeHeap config
│       └── res/                           # Icons and splash screens
│
├── capacitor.config.json       # App ID: com.veelead.ziptopdf; webDir: frontend
├── package.json                # Capacitor 7 npm dependencies
└── README.md                   # This file
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend UI | HTML5 + CSS3 | Shell and responsive layout |
| Frontend Logic | Vanilla JavaScript (ES6+) | State machine, ZIP parsing, UI rendering |
| ZIP Library | JSZip | Client-side ZIP reading |
| Drag-Drop | Sortable.js | ZIP card reordering |
| Mobile Framework | Capacitor 7.x | WebView → Android native bridge |
| Native PDF | Kotlin + `android.graphics.pdf.PdfDocument` | Memory-efficient PDF generation |
| Native I/O | `@capacitor/filesystem` | Read/write to device cache + data dirs |
| Backend API | FastAPI + Uvicorn | REST API for web mode |
| Image Processing | Pillow (PIL) | Resize, format-convert images |
| PDF Generation (web) | ReportLab | PDF creation on backend |
| Database | SQLite | Job state persistence (backend) |
| Build | Gradle + Kotlin plugin | Android APK compilation |

---

## Data Flow

```
USER UPLOADS ZIPs
       │
       ▼
app.js: renderUpload() + initUploadZone()
  • Validate: .zip only, ≤300MB each, ≤30 files
  • Collect in state.selected[]
       │
       ▼
doUpload() → POST /api/jobs  [WEB MODE ONLY]
  OR
state saved locally           [ANDROID MODE]
  • Backend: stream files to disk (256KB chunks)
  • generate_thumbnail() → first image → 240×320 JPEG
  • count_images() → count valid image entries
  • INSERT into jobs + job_zips tables
  • Returns {jobId, zips: [{id, name, size, imageCount, ...}]}
       │
       ▼
app.js: renderReview()
  • Show ZIP cards with thumbnails
  • Sortable.js drag-to-reorder on .zip-list
  • Input PDF output name (auto-filled from first ZIP name)
  • User clicks "Extract & Preview"
       │
       ▼
doExtraction() → extractZipToStorage(jobId, sortedZips)
  • JSZip reads each ZIP file
  • For each image in each ZIP (one at a time):
      - Extract ArrayBuffer
      - Get dimensions
      - Write full image to CACHE/zippdf/{jobId}/imgs/
      - Write thumbnail to CACHE/zippdf/{jobId}/thumbs/
      - Append to stateData.pages[]
  • Write state.json to DATA/zippdf/{jobId}/
  • Progress: 0%→50% during extraction
       │
       ▼
app.js: renderPreview()
  • Load thumbnails from Capacitor Filesystem
  • Show page grid with checkboxes
  • Page size options: Original | A4 | Smart Auto
  • User selects/deselects pages
  • User clicks "Generate PDF"
       │
       ▼
doGenerate() → runPdfGenerationTask(selectedPageNumbers)
  • Collect absolute file paths of selected images
  • Call NativePdfGenerator.generatePdf({images, outputName, outputFolder})
  • Progress: 10% → 40% → 100%
       │
       ▼
NativePdfGenerator.kt (background thread)
  • For each image path:
      BitmapFactory.decodeFile()  → load bitmap (native memory)
      PdfDocument.PageInfo(width, height)
      canvas.drawBitmap()
      bitmap.recycle()            → FREE MEMORY IMMEDIATELY
  • Write PDF to Documents/{outputFolder}/{fileName}.pdf
  • Return {relativePath, absolutePath}
       │
       ▼
app.js: renderComplete()
  • Success animation + file size info
  • Buttons: Open | Preview | Share | Convert Another
  • renderHistory(): list recent PDFs; auto-delete >24h old
```

---

## Frontend (app.js)

### Global State Object

```javascript
state = {
  step: 'upload|review|preview|processing|complete',
  zips: [
    {id, name, size, imageCount, order, fileObj, validImages}
  ],
  pages: [
    {page, zipId, imageName, entryName, ext, thumbnailUrl}
  ],
  selectedPages: Set<pageNumber>,
  jobId: 'job_TIMESTAMP_RANDOM',
  totalImages: number,
  pdfName: string,
  pageSize: 'original|a4|smart',
  outputFolder: string,
  isGenerating: boolean
}
```

### Key Functions

| Function | Purpose |
|----------|---------|
| `addFiles(files)` | Validate and add ZIP files to `state.selected` |
| `doUpload()` | Send ZIPs to backend or process locally; get job ID |
| `extractZipToStorage(jobId, zips)` | Extract images one-by-one to Capacitor Filesystem |
| `runPdfGenerationTask(pages)` | Gather image paths, call native PDF plugin |
| `renderUpload()` | Upload zone with drag-drop area |
| `renderReview()` | ZIP cards with thumbnails + Sortable drag handles |
| `renderPreview()` | Page grid with checkboxes + page size selector |
| `renderProcessing()` | Animated progress bar + status messages |
| `renderComplete()` | Success screen with action buttons |
| `renderHistory()` | Recent PDFs list (loads from Documents dir) |
| `cleanupJob(jobId)` | Remove extracted images + state file for a job |
| `cleanupAbandonedJobs()` | Clean up jobs older than 24h from cache |
| `cleanupOldPDFs()` | Delete PDFs older than 24h from Documents |

### Step Navigation

```
upload → review → preview → processing → complete
  ●         ○         ○          ○            ○
```

Steps rendered by `STEPS` array; active step shown in top progress dots.

### Theme System

- Dark theme default (`--bg: #07090F`, accent `--accent: #E8A020`)
- Light theme toggled via `data-theme="light"` on `<html>`
- Persisted in `localStorage.theme`

---

## Backend (FastAPI)

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/jobs` | Create job from uploaded ZIP files |
| `GET` | `/api/jobs/{job_id}` | Get job status + ZIP list |
| `PUT` | `/api/jobs/{job_id}/order` | Update ZIP order |
| `POST` | `/api/jobs/{job_id}/start` | Start PDF generation |
| `GET` | `/api/jobs/{job_id}/pages` | Get page preview list |
| `GET` | `/api/jobs/{job_id}/pages/{page}/thumbnail` | Serve page thumbnail JPEG |
| `GET` | `/api/jobs/{job_id}/thumbnail/{zip_order}` | Serve ZIP thumbnail JPEG |
| `GET` | `/api/jobs/{job_id}/download` | Download final PDF |
| `DELETE` | `/api/jobs/{job_id}` | Clean up job files + DB records |

### SQLite Schema

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT,    -- 'uploaded' | 'pending' | 'processing' | 'complete' | 'error'
  created_at   REAL,
  progress     INTEGER, -- 0-100
  progress_msg TEXT,
  total_images INTEGER,
  output_name  TEXT,    -- PDF filename
  page_size    TEXT,    -- 'original' | 'a4' | 'smart'
  pdf_path     TEXT,
  pdf_size     INTEGER,
  error        TEXT
);

CREATE TABLE job_zips (
  id             INTEGER PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  zip_name       TEXT,
  zip_order      INTEGER,
  stored_path    TEXT,
  size_bytes     INTEGER,
  thumbnail_path TEXT,
  image_count    INTEGER
);
```

### Background Worker (worker.py)

| Function | Description |
|----------|-------------|
| `count_images(zip_path)` | Count valid image entries in a ZIP |
| `generate_thumbnail(zip_path, job_id, zip_order)` | Extract first image, resize to 240×320, save as JPEG |
| `generate_page_previews(job_id)` | Extract + resize all images; return page list |
| `process_job(job_id, selected_pages, page_size)` | Background thread: stream images → ReportLab PDF |

**Page size modes:**
- `original` — each page matches the image's native pixel dimensions
- `a4` — all pages 595.27×841.89 pts; image centered with letterboxing
- `smart` — analyzes all images, picks most common size, applies to all pages

---

## Android Native Plugin

### NativePdfGenerator.kt

**Plugin name:** `NativePdfGenerator`  
**Capacitor method:** `generatePdf`

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `images` | `JSArray` | Absolute file paths to extracted images |
| `outputName` | `String` | PDF filename (with or without .pdf) |
| `outputFolder` | `String` | Subfolder under Documents/ |

**Process:**

```kotlin
for (imagePath in images) {
    val bitmap = BitmapFactory.decodeFile(imagePath)
    val pageInfo = PdfDocument.PageInfo.Builder(bitmap.width, bitmap.height, pageNum).create()
    val page = pdf.startPage(pageInfo)
    page.canvas.drawBitmap(bitmap, 0f, 0f, null)
    pdf.finishPage(page)
    bitmap.recycle()   // ← critical: free native memory immediately
}
// write to Documents/{outputFolder}/{outputName}.pdf
```

**Returns:** `{ relativePath: string, absolutePath: string }`

**Threading:** Runs entirely on a background thread (`taskQueue`) to prevent ANR.

### AndroidManifest Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
```

`android:largeHeap="true"` is set on `<application>` to allow expanded heap for large image sets.

---

## State & Data Structures

### Capacitor Filesystem Layout

```
CACHE/zippdf/{jobId}/
  imgs/
    0_0_image.jpg       # {zipIndex}_{imageIndex}_{originalName}
    0_1_image.jpg
    1_0_image.jpg
    ...
  thumbs/
    0_0_image.jpg       # Scaled thumbnails (same naming)
    ...

DATA/zippdf/{jobId}/
  state.json            # Job metadata + full pages list
```

### state.json Schema

```json
{
  "jobId": "job_1749999999999_abc123",
  "status": "complete",
  "progress": 100,
  "processedImages": 150,
  "totalImages": 150,
  "pdfName": "MyDocument",
  "pageMode": "smart",
  "createdAt": 1749999999999,
  "completedAt": 1750000001234,
  "pages": [
    {
      "index": 0,
      "fileName": "0_0_page001.jpg",
      "width": 2480,
      "height": 3508,
      "ext": ".jpg"
    }
  ]
}
```

---

## Configuration

### backend/config.py

```python
MAX_ZIP_COUNT     = 30          # Maximum number of ZIP files per job
MAX_ZIP_SIZE_MB   = 300         # Maximum size per ZIP file
MAX_TOTAL_SIZE_MB = 1000        # Maximum total upload size
ALLOWED_IMAGE_EXTS = {
    '.jpg', '.jpeg', '.png', '.webp',
    '.jfif', '.bmp', '.tiff', '.gif'
}
THUMBNAIL_SIZE    = (240, 320)  # Preview thumbnail dimensions
DEFAULT_DPI       = 96.0        # DPI fallback for images without EXIF DPI
TTL_MINUTES       = 30          # Job time-to-live (web mode)
```

### capacitor.config.json

```json
{
  "appId": "com.veelead.ziptopdf",
  "appName": "zip_to_pdf",
  "webDir": "frontend"
}
```

---

## Setup & Running

### Android App

```bash
# Install Node dependencies
npm install

# Sync frontend + plugins to Android project
npx cap sync android

# Open in Android Studio
npx cap open android
# Then: Build > Build APK  (or Run on device)
```

### Backend (Web / Dev Mode)

```bash
cd backend
python -m venv venv
venv\Scripts\activate       # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# Open: http://localhost:8000
```

### Frontend Dev Server (hot reload)

```bash
cd frontend
python -m http.server 5500
# Open: http://localhost:5500
# app.js auto-detects port 5500 and targets API at localhost:8000
```

---

## Limits

| Setting | Value |
|---------|-------|
| Max ZIP files per job | 30 |
| Max size per ZIP | 300 MB |
| Max total upload size | 1,000 MB |
| Supported image formats | JPG, JPEG, PNG, WEBP, BMP, TIFF, GIF, JFIF |
| Job TTL (web mode) | 30 minutes |
| PDF auto-delete (device) | 24 hours |
| Thumbnail size | 240 × 320 px |

---

## Notes

- Free hosting (Render Free) works for demos with ≤ 50 MB ZIPs.
- For 300–400 MB ZIPs with 2000+ images: use a paid VM or container with ≥2 GB RAM.
- SQLite is used for MVP; swap in Postgres for multi-worker deployments.
- CORS is open to all origins in `main.py` — restrict for production.
- The backend is **not used** in Android mode; all processing is on-device.

---

## Changelog & Implementation Notes

### PDF Engine Migration: Android PdfDocument → iText

The original native plugin used `android.graphics.pdf.PdfDocument` with `BitmapFactory.decodeFile()` + `canvas.drawBitmap()`. This caused two problems:

1. **File size explosion** — each JPEG was fully decompressed into a raw ARGB bitmap before being re-encoded into the PDF. A 30 MB ZIP produced a 60–120 MB PDF.
2. **Quality loss** — Android's PDF canvas re-compressed images, introducing a second lossy JPEG compression on top of the original.

The plugin was migrated to **iText** (`com.itextpdf`). iText reads JPEG bytes directly and embeds them as a `DCTDecode` stream — no decompression, no re-encoding. Result: a 30 MB ZIP now produces a ~32 MB PDF with **zero quality loss**.

| | Old (Android PdfDocument) | New (iText) |
|--|--------------------------|-------------|
| 30 MB ZIP → PDF size | 60–120 MB | ~32 MB |
| Image quality | Reduced (double compression) | 100% original |
| How images are stored | Re-encoded pixels | Original JPEG bytes |

---

### PDF Page Size Modes

Three modes are available, selectable in the Preview step:

| Mode | Behaviour |
|------|-----------|
| **Original** | Each page matches the image's exact pixel dimensions. No scaling. |
| **A4** | All pages fixed at 595×842 pt. Images scaled to fit with letterboxing/pillarboxing, centered. |
| **Smart Auto** | Analyses all images; picks the dominant size per orientation group. See below. |

**Why file sizes look the same across all three modes:**
iText embeds JPEG image data as-is regardless of page size. Changing page layout only affects the PDF coordinate geometry, not the image bytes. All three modes will produce near-identical file sizes for the same input ZIP.

The visual difference is in page dimensions and image positioning — open the PDF to verify the mode is working correctly, not the file size.

---

### Smart Auto Mode — Implementation Detail

**Previous behaviour (single dominant size):**
- Scanned all image headers with `BitmapFactory.inJustDecodeBounds`
- Found the single most common `width×height` pair
- Used that as the page size for every image

**Problems with the old approach:**

| Scenario | Problem |
|----------|---------|
| `2480×3508` mixed with `1240×1754` (half size) | Half-size images scaled UP 2× → blurry |
| `2480×3508` mixed with `3508×2480` (portrait + landscape) | Landscape squished into tall portrait pages |

**Current behaviour (orientation-aware, no scale-up):**

Two dominant sizes are now computed — one for portrait images (`width ≤ height`) and one for landscape (`width > height`). Each image is placed on a page matching its own orientation group's dominant size.

Additionally, scale is capped at `1.0f` in Smart mode: images smaller than the dominant page size are **never scaled up**. They are centered at their native resolution with white space around them, preserving sharpness.

```kotlin
// Portrait and landscape are analysed separately
val smartSizes = computeSmartSizes(imagePaths)  // returns SmartSizes(portrait, landscape)

// Each image picks the page size matching its orientation
val target = if (isLandscape) smartSizes.landscape else smartSizes.portrait

// Scale capped at 1.0 — never blow up a small image
val scale = minOf(pageW / imgW, pageH / imgH, 1.0f)
```

**How each scenario is handled now:**

| Scenario | Result |
|----------|--------|
| `2480×3508` + `1240×1754` (half size) | Small images centered at native size, white border around them |
| `2480×3508` + `3508×2480` (portrait + landscape) | Portrait gets portrait page, landscape gets landscape page |
| `2480×3508` + `2000×2500` (different sizes) | Proportional scale-down, centered — minor white bars |

---

### Known Issue: Image Naming Conflicts in ZIP

ZIP files containing images named with and without leading zeros (e.g. `001.jpg` alongside `1.jpg`) cause ordering and path-resolution issues:

- **Lexicographic sort** places all `0xx` files before `1.jpg`–`7.jpg`, duplicating the first 7 pages at the end.
- **Natural sort** treats `001` and `1` as the same number → one of each pair may be silently dropped from a map/object.

With a ZIP of 49 files (`001`–`049`) plus 7 files (`1`–`7`), up to 7 images can be lost and the remaining 49 appear in the wrong order. The native plugin then receives an invalid or mismatched path → "format not recognised" error.

**Planned fix:** Store extracted images using pure index-based names (`{zipIndex}_{imageIndex}.{ext}`) so original filenames have no influence on ordering or path resolution.
