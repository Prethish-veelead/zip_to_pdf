import sqlite3
from config import BASE_DIR

DB_PATH = BASE_DIR / "jobs.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id          TEXT    PRIMARY KEY,
            status      TEXT    NOT NULL DEFAULT 'uploaded',
            created_at  REAL    NOT NULL,
            progress    INTEGER DEFAULT 0,
            progress_msg TEXT   DEFAULT '',
            total_images INTEGER DEFAULT 0,
            output_name TEXT,
            page_size   TEXT    DEFAULT 'smart',
            pdf_path    TEXT,
            pdf_size    INTEGER,
            error       TEXT
        );
    """)
    
    # Run migrations if columns are missing
    try:
        conn.execute("ALTER TABLE jobs ADD COLUMN output_name TEXT")
    except sqlite3.OperationalError:
        pass
        
    try:
        conn.execute("ALTER TABLE jobs ADD COLUMN page_size TEXT DEFAULT 'smart'")
    except sqlite3.OperationalError:
        pass

        CREATE TABLE IF NOT EXISTS job_zips (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id          TEXT    NOT NULL,
            zip_name        TEXT    NOT NULL,
            zip_order       INTEGER NOT NULL,
            stored_path     TEXT    NOT NULL,
            size_bytes      INTEGER NOT NULL,
            thumbnail_path  TEXT,
            image_count     INTEGER DEFAULT 0,
            FOREIGN KEY (job_id) REFERENCES jobs(id)
        );
    """)
    conn.commit()
    conn.close()