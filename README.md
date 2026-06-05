# zip_to_pdf
learing and thinking possible ways

# ZipForge — ZIP to PDF Converter

Upload multiple ZIP files full of images → reorder them → download one merged PDF.

## Project Structure

```
zip-to-pdf/
├── frontend/
│   ├── index.html     ← HTML shell
│   ├── style.css      ← Dark "forge" theme, fully responsive
│   └── app.js         ← State machine, API calls, drag-to-reorder
└── backend/
    ├── main.py        ← FastAPI routes
    ├── worker.py      ← Background PDF generation (memory-safe)
    ├── database.py    ← SQLite helpers
    ├── config.py      ← Settings (limits, paths)
    └── requirements.txt
```

## Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The backend serves the frontend automatically from `../frontend/`.
Open → http://localhost:8000

### Dev: Frontend only (separate server)

If you want live-reload on the frontend, serve it from a separate port:

```bash
# e.g. using Python's built-in server
cd frontend
python -m http.server 5500
```

The frontend auto-detects port 5500 and sends API calls to `http://localhost:8000`.

---

## Features (Phase 1)

- Upload up to 30 ZIP files
- Per-ZIP thumbnail preview (first image from each ZIP)
- Drag-and-drop ZIP reordering (works on Android + desktop)
- Memory-safe PDF generation (one image in RAM at a time)
- Progress bar with live status
- Download generated PDF

## Limits

| Setting              | Default   |
|----------------------|-----------|
| Max ZIP files        | 30        |
| Max ZIP size         | 300 MB    |
| Supported images     | JPG PNG WEBP BMP TIFF GIF JFIF |

## Notes

- Free hosting (Render Free) works for demos with ≤ 50 MB ZIPs.
- For 300–400 MB ZIPs with 2000+ images: use a paid VM or container.
- SQLite is used for MVP; swap in Postgres if you scale beyond one worker.
git init
git add .
git commit -m "first commit"
git branch -M main
git push -u origin main