import io
import zipfile
import threading
from pathlib import Path
from collections import Counter

import natsort
from PIL import Image
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.lib.utils import ImageReader

from config import UPLOAD_DIR, ALLOWED_IMAGE_EXTS, THUMBNAIL_SIZE, DEFAULT_DPI
from database import get_conn


# ── helpers ──────────────────────────────────────────────────────────────────

def _valid_names(zf: zipfile.ZipFile) -> list[str]:
    """Return image filenames from a ZIP in natural sort order, skipping junk."""
    names = [
        n for n in zf.namelist()
        if Path(n).suffix.lower() in ALLOWED_IMAGE_EXTS
        and "__MACOSX" not in n
        and not Path(n).name.startswith(".")
    ]
    return natsort.natsorted(names)


def _to_rgb(img: Image.Image) -> Image.Image:
    """Convert image to RGB safely (handles RGBA, P, L, etc.)."""
    if img.mode == "RGBA":
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        return bg
    if img.mode not in ("RGB", "L"):
        return img.convert("RGB")
    return img


def _img_pts(img: Image.Image) -> tuple[float, float]:
    """Convert pixel dimensions → PDF points using embedded DPI or fallback."""
    dpi_info = img.info.get("dpi", (DEFAULT_DPI, DEFAULT_DPI))
    dpi_x = float(dpi_info[0] if isinstance(dpi_info, tuple) else dpi_info)
    if not (1 < dpi_x < 2400):
        dpi_x = DEFAULT_DPI
    scale = 72.0 / dpi_x
    return img.width * scale, img.height * scale


# ── public API ────────────────────────────────────────────────────────────────

def count_images(zip_path: str) -> int:
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            return len(_valid_names(zf))
    except Exception:
        return 0


def generate_thumbnail(zip_path: str, job_id: str, zip_order: int) -> str | None:
    """Extract first image from ZIP and save a JPEG thumbnail. Returns path or None."""
    try:
        thumb_dir = UPLOAD_DIR / job_id / "thumbs"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        thumb_path = thumb_dir / f"zip_{zip_order}.jpg"

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = _valid_names(zf)
            if not names:
                return None
            with zf.open(names[0]) as f:
                img = Image.open(io.BytesIO(f.read()))
                img.load()

        img = _to_rgb(img)
        img.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)
        img.save(str(thumb_path), "JPEG", quality=85)
        return str(thumb_path)
    except Exception:
        return None


def process_job(job_id: str, selected_pages: list[int] | None = None, page_size: str = "smart"):
    """Kick off background PDF generation thread."""
    thread = threading.Thread(target=_run_job, args=(job_id, selected_pages, page_size), daemon=True)
    thread.start()


# ── background worker ─────────────────────────────────────────────────────────

def _run_job(job_id: str, selected_pages: list[int] | None, page_size: str):
    conn = get_conn()
    try:
        zips = conn.execute(
            "SELECT * FROM job_zips WHERE job_id = ? ORDER BY zip_order",
            (job_id,),
        ).fetchall()

        output_path = UPLOAD_DIR / job_id / "output.pdf"
        pages_to_process = set(selected_pages) if selected_pages else None
        total = len(pages_to_process) if pages_to_process else sum(z["image_count"] for z in zips)

        conn.execute(
            "UPDATE jobs SET status='processing', total_images=?, progress=0 WHERE id=?",
            (total, job_id),
        )
        conn.commit()

        target_w, target_h = None, None

        if page_size == "smart":
            conn.execute("UPDATE jobs SET progress_msg='Analyzing dimensions...' WHERE id=?", (job_id,))
            conn.commit()
            
            dim_counts = Counter()
            scan_idx = 0
            
            for zip_row in zips:
                with zipfile.ZipFile(zip_row["stored_path"], "r") as zf:
                    for name in _valid_names(zf):
                        scan_idx += 1
                        if pages_to_process and scan_idx not in pages_to_process:
                            continue
                            
                        try:
                            with zf.open(name) as f:
                                img = Image.open(io.BytesIO(f.read()))
                                w_pts, h_pts = _img_pts(img)
                                
                                bucket_w = round(w_pts / 5.0) * 5
                                bucket_h = round(h_pts / 5.0) * 5
                                dim_counts[(bucket_w, bucket_h)] += 1
                                img.close()
                        except Exception:
                            pass
                            
            if dim_counts:
                best_dim = dim_counts.most_common(1)[0][0]
                target_w, target_h = best_dim
                
        elif page_size == "a4":
            target_w, target_h = 595.27, 841.89

        c = pdf_canvas.Canvas(str(output_path))
        processed = 0
        global_page_idx = 0

        for zip_row in zips:
            with zipfile.ZipFile(zip_row["stored_path"], "r") as zf:
                for name in _valid_names(zf):
                    global_page_idx += 1
                    if pages_to_process and global_page_idx not in pages_to_process:
                        continue

                    try:
                        with zf.open(name) as f:
                            img = Image.open(io.BytesIO(f.read()))
                            img.load()

                        img = _to_rgb(img)
                        w_pts, h_pts = _img_pts(img)

                        if target_w and target_h:
                            c.setPageSize((target_w, target_h))
                            scale = min(target_w / w_pts, target_h / h_pts)
                            draw_w = w_pts * scale
                            draw_h = h_pts * scale
                            x = (target_w - draw_w) / 2.0
                            y = (target_h - draw_h) / 2.0
                            c.drawImage(ImageReader(img), x, y, draw_w, draw_h)
                        else:
                            c.setPageSize((w_pts, h_pts))
                            c.drawImage(ImageReader(img), 0, 0, w_pts, h_pts)
                            
                        c.showPage()
                        img.close()

                    except Exception as e:
                        print(f"[worker] skipping {name}: {e}")

                    processed += 1

                    # Update DB every 20 images to reduce writes
                    if processed % 20 == 0 or processed == total:
                        pct = int(processed / max(total, 1) * 100)
                        conn.execute(
                            "UPDATE jobs SET progress=?, progress_msg=? WHERE id=?",
                            (pct, f"Processing image {processed} of {total}", job_id),
                        )
                        conn.commit()

        c.save()
        size = output_path.stat().st_size if output_path.exists() else 0

        conn.execute(
            """UPDATE jobs
               SET status='complete', progress=100,
                   progress_msg='Done', pdf_path=?, pdf_size=?
               WHERE id=?""",
            (str(output_path), size, job_id),
        )
        conn.commit()

    except Exception as exc:
        conn.execute(
            "UPDATE jobs SET status='error', error=? WHERE id=?",
            (str(exc), job_id),
        )
        conn.commit()
    finally:
        conn.close()