"""SQLite storage: catches + simple duplicate detection via image hash."""
import hashlib
import os
import sqlite3
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("TIDECAST_DB", os.path.join(HERE, "fish.db"))

# Columns added after the first version of the table (added in place on start-up).
EXTRA_COLUMNS = {
    "points": "INTEGER NOT NULL DEFAULT 0",
    "location": "TEXT",
    "lat": "REAL",
    "lon": "REAL",
    "photo": "TEXT",            # file name in Catch/photos, if the photo was kept
    "sample": "INTEGER NOT NULL DEFAULT 0",   # 1 = demo row, not a real catch
}


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
    have = {r["name"] for r in conn.execute("PRAGMA table_info(catches)")}
    for name, kind in EXTRA_COLUMNS.items():
        if name not in have:
            conn.execute(f"ALTER TABLE catches ADD COLUMN {name} {kind}")
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


def save_catch(angler, result, img_hash, points=0, location=None, lat=None, lon=None,
               photo=None, sample=False, created_at=None):
    conn = get_conn()
    cur = conn.execute(
        """INSERT OR REPLACE INTO catches
           (angler, species, length_cm, weight_lb, weight_low,
            weight_high, image_hash, created_at, points, location, lat, lon, photo, sample)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (angler, result["species"], result["length_cm"],
         result["weight_lb"], result["weight_low_lb"],
         result["weight_high_lb"], img_hash, int(created_at or time.time()),
         int(points), location, lat, lon, photo, 1 if sample else 0),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def week_start(now=None):
    """Monday 00:00 (server local time) of the current week, as a timestamp."""
    t = time.localtime(now or time.time())
    midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    return int(midnight - t.tm_wday * 86400)


def top_catches(limit=20, species=None, period="all", order="points"):
    """Best catches, ranked by points (or by weight, as in the first version)."""
    where, args = [], []
    if species:
        where.append("species = ?")
        args.append(species)
    if period == "week":
        where.append("created_at >= ?")
        args.append(week_start())
    sql = "SELECT * FROM catches"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY " + ("weight_lb" if order == "weight" else "points") + " DESC, created_at ASC LIMIT ?"
    args.append(limit)
    conn = get_conn()
    rows = conn.execute(sql, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def rank_of(catch_id, period="all"):
    """1-based leaderboard position of one catch."""
    conn = get_conn()
    row = conn.execute("SELECT points, created_at FROM catches WHERE id = ?", (catch_id,)).fetchone()
    if not row:
        conn.close()
        return None
    since = week_start() if period == "week" else 0
    better = conn.execute(
        """SELECT COUNT(*) FROM catches WHERE created_at >= ? AND
           (points > ? OR (points = ? AND created_at < ?))""",
        (since, row["points"], row["points"], row["created_at"])).fetchone()[0]
    conn.close()
    return better + 1


def stats():
    conn = get_conn()
    real = "WHERE sample = 0"
    row = conn.execute(f"""SELECT COUNT(*) AS catches, COUNT(DISTINCT angler) AS anglers,
            COUNT(DISTINCT species) AS species, COALESCE(SUM(weight_lb), 0) AS total_lb,
            COUNT(DISTINCT location) AS waters,
            AVG(CASE WHEN weight_lb > 0 THEN (weight_high - weight_low) / 2.0 / weight_lb END) AS avg_err
            FROM catches {real}""").fetchone()
    samples = conn.execute("SELECT COUNT(*) FROM catches WHERE sample = 1").fetchone()[0]
    every = conn.execute("""SELECT COUNT(*) AS catches, COUNT(DISTINCT angler) AS anglers,
            COUNT(DISTINCT species) AS species, COALESCE(SUM(weight_lb), 0) AS total_lb,
            COUNT(DISTINCT location) AS waters FROM catches""").fetchone()
    conn.close()
    out = dict(row)
    out["sample_rows"] = samples
    out["including_samples"] = dict(every)
    return out


def photo_posted(name):
    conn = get_conn()
    row = conn.execute("SELECT 1 FROM catches WHERE photo = ?", (name,)).fetchone()
    conn.close()
    return row is not None


def count():
    conn = get_conn()
    n = conn.execute("SELECT COUNT(*) FROM catches").fetchone()[0]
    conn.close()
    return n
