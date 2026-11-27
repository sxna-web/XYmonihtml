import concurrent.futures
import os
import sqlite3
import tempfile
import threading
import unittest

RESERVE_SQL = """
INSERT INTO app_card_device_slots (card_id, device_id, created_at)
SELECT ?, ?, ?
WHERE (SELECT COUNT(*) FROM app_card_device_slots WHERE card_id = ?) < ?
ON CONFLICT(card_id, device_id) DO NOTHING
RETURNING card_id, device_id, created_at
"""

class AtomicDeviceSlotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(delete=False)
        self.path = self.tmp.name
        self.tmp.close()
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE app_card_device_slots (card_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(card_id, device_id))")

    def tearDown(self):
        os.unlink(self.path)

    def reserve(self, device, limit=3):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute("PRAGMA busy_timeout=10000")
            row = db.execute(RESERVE_SQL, ("card_A", device, "2026-11-27T12:00:00Z", "card_A", limit)).fetchone()
            db.commit()
            if row:
                return "inserted"
            exists = db.execute("SELECT 1 FROM app_card_device_slots WHERE card_id=? AND device_id=?", ("card_A", device)).fetchone()
            return "duplicate" if exists else "full"
        finally:
            db.close()

    def test_concurrent_distinct_devices_never_exceed_limit(self):
        barrier = threading.Barrier(12)
        def worker(i):
            barrier.wait()
            return self.reserve(f"device_{i}", 3)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(worker, range(12)))
        with sqlite3.connect(self.path) as db:
            count = db.execute("SELECT COUNT(*) FROM app_card_device_slots WHERE card_id='card_A'").fetchone()[0]
        self.assertEqual(count, 3)
        self.assertEqual(results.count("inserted"), 3)

    def test_same_device_concurrent_retries_are_idempotent(self):
        barrier = threading.Barrier(8)
        def worker(_):
            barrier.wait()
            return self.reserve("device_same", 1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(worker, range(8)))
        with sqlite3.connect(self.path) as db:
            count = db.execute("SELECT COUNT(*) FROM app_card_device_slots WHERE card_id='card_A'").fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(results.count("inserted"), 1)
        self.assertEqual(results.count("duplicate"), 7)

    def test_capacity_is_independent_per_card(self):
        self.reserve("device_A", 1)
        with sqlite3.connect(self.path) as db:
            db.execute(RESERVE_SQL, ("card_B", "device_A", "2026-11-27T12:00:00Z", "card_B", 1))
            db.commit()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_card_device_slots WHERE card_id='card_A'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_card_device_slots WHERE card_id='card_B'").fetchone()[0], 1)

if __name__ == "__main__":
    unittest.main(verbosity=2)
