from pathlib import Path

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_ZIP_COUNT = 30
MAX_ZIP_SIZE_MB = 300
MAX_TOTAL_SIZE_MB = 1000
ALLOWED_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.jfif', '.bmp', '.tiff', '.gif'}
THUMBNAIL_SIZE = (240, 320)
DEFAULT_DPI = 96.0
TTL_MINUTES = 30