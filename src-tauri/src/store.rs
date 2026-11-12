//! Append-only local store: labs, runs, settings and a hash-chained event log.
//! The event log *is* the audit log and the notebook source: every view in the
//! UI is a reduction over these events, so any moment can be replayed.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Serialize, Clone, Debug)]
pub struct EventRow {
    pub seq: i64,
    pub run_id: String,
    pub ts: i64,
    pub kind: String,
    pub data: Value,
    pub hash: String,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS labs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, lab_id TEXT, lab_name TEXT, question TEXT NOT NULL,
  status TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"#;

fn digest(prev: &str, run_id: &str, ts: i64, kind: &str, payload: &str) -> String {
    let mut h = Sha256::new();
    for part in [prev, run_id, &ts.to_string(), kind, payload] {
        h.update(part.as_bytes());
        h.update([0u8]);
    }
    hex::encode(h.finalize())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn append(&self, run_id: &str, kind: &str, data: &Value) -> Result<EventRow> {
        let conn = self.conn.lock().unwrap();
        let prev: String = conn
            .query_row(
                "SELECT hash FROM events WHERE run_id=?1 ORDER BY seq DESC LIMIT 1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "genesis".into());
        let ts = chrono::Utc::now().timestamp_millis();
        let payload = serde_json::to_string(data)?;
        let hash = digest(&prev, run_id, ts, kind, &payload);
        conn.execute(
            "INSERT INTO events(run_id,ts,kind,payload,prev_hash,hash) VALUES(?1,?2,?3,?4,?5,?6)",
            params![run_id, ts, kind, payload, prev, hash],
        )?;
        let seq = conn.last_insert_rowid();
        Ok(EventRow { seq, run_id: run_id.into(), ts, kind: kind.into(), data: data.clone(), hash })
    }

    pub fn events(&self, run_id: &str) -> Result<Vec<EventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT seq,run_id,ts,kind,payload,hash FROM events WHERE run_id=?1 ORDER BY seq",
        )?;
        let rows = st
            .query_map([run_id], |r| {
                let payload: String = r.get(4)?;
                Ok(EventRow {
                    seq: r.get(0)?,
                    run_id: r.get(1)?,
                    ts: r.get(2)?,
                    kind: r.get(3)?,
                    data: serde_json::from_str(&payload).unwrap_or(Value::Null),
                    hash: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Recompute the hash chain; returns (events checked, first broken seq).
    pub fn verify(&self, run_id: &str) -> Result<(usize, Option<i64>)> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT seq,ts,kind,payload,prev_hash,hash FROM events WHERE run_id=?1 ORDER BY seq",
        )?;
        let mut prev = "genesis".to_string();
        let mut n = 0;
        let mut rows = st.query([run_id])?;
        while let Some(r) = rows.next()? {
            let (seq, ts, kind, payload, p, h): (i64, i64, String, String, String, String) =
                (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?);
            if p != prev || digest(&p, run_id, ts, &kind, &payload) != h {
                return Ok((n, Some(seq)));
            }
            prev = h;
            n += 1;
        }
        Ok((n, None))
    }

    pub fn create_run(&self, id: &str, lab_id: &str, lab_name: &str, question: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO runs(id,lab_id,lab_name,question,status,created) VALUES(?1,?2,?3,?4,'running',?5)",
            params![id, lab_id, lab_name, question, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    pub fn set_run_status(&self, id: &str, status: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("UPDATE runs SET status=?2 WHERE id=?1", params![id, status])?;
        Ok(())
    }

    /// Runs left "running" by a crash or close are marked interrupted at startup.
    pub fn interrupt_stale(&self) -> Result<()> {
        self.conn.lock().unwrap().execute("UPDATE runs SET status='interrupted' WHERE status='running'", [])?;
        Ok(())
    }

    pub fn runs(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id,lab_name,question,status,created FROM runs ORDER BY created DESC")?;
        let v = st
            .query_map([], |r| {
                Ok(json!({"id": r.get::<_, String>(0)?, "lab": r.get::<_, String>(1)?,
                          "question": r.get::<_, String>(2)?, "status": r.get::<_, String>(3)?,
                          "created": r.get::<_, i64>(4)?}))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(v)
    }

    pub fn save_lab(&self, id: &str, name: &str, lab: &Value) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO labs(id,name,json,updated) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET name=?2,json=?3,updated=?4",
            params![id, name, serde_json::to_string(lab)?, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    pub fn labs(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT json FROM labs ORDER BY updated DESC")?;
        let v = st
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|s| s.ok().and_then(|s| serde_json::from_str(&s).ok()))
            .collect();
        Ok(v)
    }

    pub fn delete_lab(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM labs WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn setting(&self, k: &str) -> Option<String> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT v FROM settings WHERE k=?1", [k], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, k: &str, v: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=?2",
            params![k, v],
        )?;
        Ok(())
    }
}
