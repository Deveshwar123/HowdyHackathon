"""SQLite storage: catches + simple duplicate detection via image hash."""
import sqlite3
import hashlib
import time

DB_PATH = "fish.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)   # wait up to 10s for a lock
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS catches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            angler      TEXT NOT NULL,
            species     TEXT NOT NULL,
            length_cm   REAL NOT NULL,
            weight_lb   REAL NOT NULL,
            weight_low  REAL NOT NULL,
            weight_high REAL NOT NULL,
            image_hash  TEXT UNIQUE,
            created_at  INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def image_hash(image_bytes):
    return hashlib.sha256(image_bytes).hexdigest()


def is_duplicate(img_hash):
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM catches WHERE image_hash = ?", (img_hash,)
    ).fetchone()
    conn.close()
    return row is not None


def save_catch(angler, result, img_hash):
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO catches
           (angler, species, length_cm, weight_lb, weight_low,
            weight_high, image_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (angler, result["species"], result["length_cm"],
         result["weight_lb"], result["weight_low_lb"],
         result["weight_high_lb"], img_hash, int(time.time())),
    )
    conn.commit()
    conn.close()


def top_catches(limit=20, species=None):
    conn = get_conn()
    if species:
        rows = conn.execute(
            """SELECT * FROM catches WHERE species = ?
               ORDER BY weight_lb DESC LIMIT ?""",
            (species, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM catches ORDER BY weight_lb DESC LIMIT ?",
            (limit,),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]