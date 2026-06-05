import shutil
import time
import uuid
import re
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import MAX_ZIP_COUNT, MAX_ZIP_SIZE_MB, UPLOAD_DIR
from database import get_conn, init_db
from worker import (
    count_images,
    generate_page_previews,
    generate_thumbnail,
    page_thumbnail_path,
    process_job,
)

# ── app setup ─────────────────────────────────────────────────────────────────

app = FastAPI(title="ZipForge API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

INVALID_FILENAME_RE = re.compile(r'[\\/:*?"<>|]')
MAX_OUTPUT_NAME_LEN = 100


def sanitize_pdf_filename(value: str | None) -> str:
    name = INVALID_FILENAME_RE.sub("", value or "").strip()
    if name.lower().endswith(".pdf"):
        name = name[:-4].strip()
    name = name.rstrip(". ").strip()
    if not name:
        return ""
    return f"{name[:MAX_OUTPUT_NAME_LEN - 4]}.pdf"


@app.on_event("startup")
async def startup():
    init_db()
    UPLOAD_DIR.mkdir(exist_ok=True)


# ── routes ────────────────────────────────────────────────────────────────────

@app.post("/api/jobs")
async def create_job(files: List[UploadFile] = File(...)):
    """Upload ZIPs → create job, generate thumbnails, return zip metadata."""

    if len(files) > MAX_ZIP_COUNT:
        raise HTTPException(400, f"Max {MAX_ZIP_COUNT} ZIPs allowed")

    job_id = str(uuid.uuid4())
    job_dir = UPLOAD_DIR / job_id / "zips"
    job_dir.mkdir(parents=True)

    conn = get_conn()
    conn.execute(
        "INSERT INTO jobs (id, status, created_at) VALUES (?, 'uploaded', ?)",
        (job_id, time.time()),
    )
    conn.commit()

    zips_out = []

    for order, file in enumerate(files):
        if not file.filename.lower().endswith(".zip"):
            raise HTTPException(400, f"'{file.filename}' is not a ZIP file")

        safe_name = Path(file.filename).name
        stored = job_dir / f"{order:03d}_{safe_name}"
        size = 0

        # Stream to disk — never load whole file into RAM
        with open(stored, "wb") as out:
            while True:
                chunk = await file.read(256 * 1024)  # 256 KB
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ZIP_SIZE_MB * 1024 * 1024:
                    out.close()
                    stored.unlink(missing_ok=True)
                    raise HTTPException(
                        400, f"'{file.filename}' exceeds {MAX_ZIP_SIZE_MB} MB"
                    )
                out.write(chunk)

        # Thumbnail + image count (fast — only reads first image)
        thumb_path = generate_thumbnail(str(stored), job_id, order)
        img_count = count_images(str(stored))

        conn.execute(
            """INSERT INTO job_zips
               (job_id, zip_name, zip_order, stored_path, size_bytes, thumbnail_path, image_count)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (job_id, safe_name, order, str(stored), size, thumb_path, img_count),
        )
        conn.commit()

        row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        zips_out.append(
            {
                "id": row_id,
                "name": safe_name,
                "order": order,
                "size": size,
                "imageCount": img_count,
                "hasThumbnail": thumb_path is not None,
            }
        )

    conn.close()
    return {"jobId": job_id, "zips": zips_out}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    conn = get_conn()
    job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise HTTPException(404, "Job not found")

    zips = conn.execute(
        "SELECT * FROM job_zips WHERE job_id=? ORDER BY zip_order", (job_id,)
    ).fetchall()
    conn.close()

    return {
        "jobId": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "progressMsg": job["progress_msg"],
        "totalImages": job["total_images"],
        "outputName": job["output_name"],
        "pdfSize": job["pdf_size"],
        "error": job["error"],
        "zips": [dict(z) for z in zips],
    }


class ReorderBody(BaseModel):
    order: List[int]  # list of job_zip row IDs in desired sequence


class StartBody(BaseModel):
    fileName: str | None = None
    selected_pages: List[int] | None = None


@app.put("/api/jobs/{job_id}/order")
async def update_order(job_id: str, body: ReorderBody):
    conn = get_conn()
    job = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] not in ("uploaded", "pending"):
        raise HTTPException(400, "Cannot reorder after processing started")

    for new_pos, zip_id in enumerate(body.order):
        conn.execute(
            "UPDATE job_zips SET zip_order=? WHERE id=? AND job_id=?",
            (new_pos, zip_id, job_id),
        )
    conn.commit()
    conn.close()
    return {"success": True}


@app.post("/api/jobs/{job_id}/start")
async def start_job(job_id: str, body: StartBody | None = None):
    conn = get_conn()
    job = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] not in ("uploaded", "pending"):
        raise HTTPException(400, "Job already running or complete")

    requested_name = body.fileName if body else None
    if not requested_name:
        first_zip = conn.execute(
            "SELECT zip_name FROM job_zips WHERE job_id=? ORDER BY zip_order LIMIT 1",
            (job_id,),
        ).fetchone()
        requested_name = Path(first_zip["zip_name"]).stem if first_zip else "output"

    output_name = sanitize_pdf_filename(requested_name)
    if not output_name:
        raise HTTPException(400, "PDF name cannot be empty")

    total_pages = conn.execute(
        "SELECT COALESCE(SUM(image_count), 0) FROM job_zips WHERE job_id=?",
        (job_id,),
    ).fetchone()[0]
    if total_pages < 1:
        raise HTTPException(400, "No images found in uploaded ZIP files")

    selected_pages = None
    if body and body.selected_pages is not None:
        selected_pages = sorted(set(body.selected_pages))
        if not selected_pages:
            raise HTTPException(400, "Select at least one page")
        if selected_pages[0] < 1 or selected_pages[-1] > total_pages:
            raise HTTPException(400, "Selected pages are outside the preview range")

    conn.execute(
        "UPDATE jobs SET status='pending', output_name=? WHERE id=?",
        (output_name, job_id),
    )
    conn.commit()
    conn.close()

    process_job(job_id, selected_pages)
    return {"success": True, "jobId": job_id}


@app.get("/api/jobs/{job_id}/pages")
async def get_pages(job_id: str):
    conn = get_conn()
    job = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] not in ("uploaded", "pending"):
        raise HTTPException(400, "Cannot preview after processing started")

    pages = generate_page_previews(job_id)
    return {"jobId": job_id, "pages": pages, "totalPages": len(pages)}


@app.get("/api/jobs/{job_id}/pages/{page}/thumbnail")
async def get_page_thumbnail(job_id: str, page: int):
    conn = get_conn()
    job = conn.execute("SELECT id FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if not job:
        raise HTTPException(404, "Job not found")

    thumb = page_thumbnail_path(job_id, page)
    if not thumb.exists():
        raise HTTPException(404, "Thumbnail file missing")

    return FileResponse(str(thumb), media_type="image/jpeg")


@app.get("/api/jobs/{job_id}/thumbnail/{zip_order}")
async def get_thumbnail(job_id: str, zip_order: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT thumbnail_path FROM job_zips WHERE job_id=? AND zip_order=?",
        (job_id, zip_order),
    ).fetchone()
    conn.close()

    if not row or not row["thumbnail_path"]:
        raise HTTPException(404, "No thumbnail")

    thumb = Path(row["thumbnail_path"])
    if not thumb.exists():
        raise HTTPException(404, "Thumbnail file missing")

    return FileResponse(str(thumb), media_type="image/jpeg")


@app.get("/api/jobs/{job_id}/download")
async def download_pdf(job_id: str):
    conn = get_conn()
    job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()

    if not job or job["status"] != "complete":
        raise HTTPException(404, "PDF not ready")

    pdf = Path(job["pdf_path"])
    if not pdf.exists():
        raise HTTPException(404, "PDF file missing")

    return FileResponse(
        str(pdf),
        media_type="application/pdf",
        filename=job["output_name"] or f"zipforge_{job_id[:8]}.pdf",
    )


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    job_dir = UPLOAD_DIR / job_id
    if job_dir.exists():
        shutil.rmtree(str(job_dir))

    conn = get_conn()
    conn.execute("DELETE FROM job_zips WHERE job_id=?", (job_id,))
    conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    conn.commit()
    conn.close()
    return {"success": True}


# ── serve frontend (must be LAST) ─────────────────────────────────────────────

_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="static")
