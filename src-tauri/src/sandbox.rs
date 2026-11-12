//! Experiment sandbox. Generated code runs as an isolated child process:
//! scrubbed environment, throwaway working directory, a read-only copy of any
//! granted dataset, in-interpreter network blocking, a hard wall-clock limit
//! and capped output. This is process-level isolation, not an OS-level
//! container: the UI says so, and a stricter backend is on the roadmap.

use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const OUTPUT_CAP: usize = 200_000;

const GUARD: &str = r#"
import socket as _s, random as _r, os as _o
def _blocked(*a, **k):
    raise OSError("network access is blocked by the Elenchia sandbox")
for _n in ("connect", "connect_ex"):
    setattr(_s.socket, _n, _blocked)
_s.create_connection = _blocked
_s.getaddrinfo = _blocked
_seed = int(_o.environ.get("ELENCHIA_SEED", "0"))
_r.seed(_seed)
try:
    import numpy as _np
    _np.random.seed(_seed % (2**32))
except Exception:
    pass
"#;

pub async fn find_python() -> Value {
    for (cmd, pre) in [("python", vec![]), ("python3", vec![]), ("py", vec!["-3"])] {
        let mut c = tokio::process::Command::new(cmd);
        c.args(&pre).arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        c.creation_flags(0x0800_0000);
        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(4), c.output()).await {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if out.status.success() && text.trim_start().starts_with("Python 3") {
                return json!({"found": true, "cmd": cmd, "pre": pre, "version": text.trim()});
            }
        }
    }
    json!({"found": false})
}

/// Static scan of generated code. `needs` raise a resource gate; `forbidden`
/// blocks approval outright. This is a tripwire for the human reviewer, not a
/// security boundary on its own.
pub fn scan_code(code: &str) -> (Vec<String>, Vec<String>) {
    let has = |pats: &[&str]| pats.iter().any(|p| code.contains(p));
    let mut needs = vec![];
    let mut forbidden = vec![];
    if has(&["import requests", "urllib", "import socket", "http.client", "ftplib", "httpx", "aiohttp"]) {
        needs.push("network".to_string());
    }
    if has(&["open(", "pathlib", "os.listdir", "glob.", "shutil", "read_csv", "np.load", "loadtxt"]) {
        needs.push("files".to_string());
    }
    if has(&["subprocess", "os.system", "os.popen", "ctypes", "os.exec", "os.spawn", "__import__", "importlib", "pty."]) {
        forbidden.push("spawns processes or loads arbitrary modules".to_string());
    }
    if has(&["rmtree", "os.remove", "os.unlink", "os.rmdir"]) {
        forbidden.push("deletes files".to_string());
    }
    (needs, forbidden)
}

pub struct ExecRequest<'a> {
    pub dir: &'a Path,
    pub code: &'a str,
    pub seed: u64,
    pub timeout_secs: u64,
    pub dataset: Option<&'a Path>,
    pub python: &'a Value,
    pub native: Option<Value>,
}

pub struct ExecResult {
    pub exit: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub timed_out: bool,
    pub executor: String,
}

pub async fn execute(req: ExecRequest<'_>) -> ExecResult {
    let started = std::time::Instant::now();
    let fail = |msg: String| ExecResult {
        exit: -1,
        stdout: String::new(),
        stderr: msg,
        duration_ms: started.elapsed().as_millis(),
        timed_out: false,
        executor: "none".into(),
    };

    if let Err(e) = std::fs::create_dir_all(req.dir) {
        return fail(format!("cannot create run directory: {e}"));
    }
    if let Some(ds) = req.dataset {
        let data_dir = req.dir.join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        if let Some(name) = ds.file_name() {
            let target = data_dir.join(name);
            if std::fs::copy(ds, &target).is_ok() {
                if let Ok(meta) = std::fs::metadata(&target) {
                    let mut p = meta.permissions();
                    p.set_readonly(true);
                    let _ = std::fs::set_permissions(&target, p);
                }
            }
        }
    }
    let _ = std::fs::write(req.dir.join("experiment.py"), req.code);
    let _ = std::fs::write(req.dir.join("_guard.py"), GUARD);

    let py_ok = req.python["found"].as_bool().unwrap_or(false);
    if !py_ok {
        // Demo experiments carry a native kernel so the product can be shown
        // without Python. The result is labelled with its executor.
        if let Some(params) = req.native {
            let out = crate::demo::native_kernel(&params, req.seed);
            return ExecResult {
                exit: 0,
                stdout: out,
                stderr: String::new(),
                duration_ms: started.elapsed().as_millis(),
                timed_out: false,
                executor: "native-demo-kernel (no Python found)".into(),
            };
        }
        return fail("No Python 3 interpreter found on PATH. Install Python 3.9+ and restart Elenchia.".into());
    }

    let cmd = req.python["cmd"].as_str().unwrap_or("python");
    let mut c = tokio::process::Command::new(cmd);
    for p in req.python["pre"].as_array().into_iter().flatten() {
        if let Some(s) = p.as_str() {
            c.arg(s);
        }
    }
    c.args([
        "-I",
        "-B",
        "-c",
        "import runpy;exec(open('_guard.py').read());runpy.run_path('experiment.py',run_name='__main__')",
    ])
    .current_dir(req.dir)
    .env_clear()
    .env("ELENCHIA_SEED", req.seed.to_string())
    .env("PYTHONHASHSEED", (req.seed % 4_294_967_295).to_string())
    .env("PYTHONIOENCODING", "utf-8")
    .env("PATH", std::env::var("PATH").unwrap_or_default())
    .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_default())
    .env("TEMP", req.dir)
    .env("TMP", req.dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);

    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return fail(format!("could not start Python: {e}")),
    };
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let h_out = tokio::spawn(read_capped(so));
    let h_err = tokio::spawn(read_capped(se));

    let (exit, timed_out) = match tokio::time::timeout(Duration::from_secs(req.timeout_secs), child.wait()).await {
        Ok(Ok(st)) => (st.code().unwrap_or(-1), false),
        Ok(Err(_)) => (-1, false),
        Err(_) => {
            let _ = child.kill().await;
            (-1, true)
        }
    };
    let stdout = h_out.await.unwrap_or_default();
    let mut stderr = h_err.await.unwrap_or_default();
    if timed_out {
        stderr.push_str(&format!("\n[sandbox] killed: exceeded {}s wall-clock limit", req.timeout_secs));
    }
    ExecResult {
        exit,
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis(),
        timed_out,
        executor: format!("{} ({})", req.python["version"].as_str().unwrap_or("python"), "isolated process"),
    }
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(n) = r.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        if buf.len() < OUTPUT_CAP {
            buf.extend_from_slice(&chunk[..n]);
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}
