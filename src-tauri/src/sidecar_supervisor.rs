//! Keeps the local server alive without hiding a crash loop.
//!
//! An unexpected sidecar exit is relaunched by the host on the same port with
//! the same host-control token, so the webview only sees a short reconnect.
//! A circuit breaker bounds the relaunches (at most [`MAX_RESTARTS`] in
//! [`RESTART_WINDOW`]); after that the host stops and asks the person.
//!
//! Every unexpected exit also leaves a crash marker (a small JSON file in the
//! host log folder). The next server reads the markers it has not shown yet
//! (`GET /api/diagnostics/crashes`), so the interface can explain what happened
//! after a relaunch or on the next start, and include them in a problem report.
//! The host only writes markers; the server only writes the acknowledgement
//! file next to them, so the two processes never write the same file.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Rolling window and budget of automatic relaunches.
pub const RESTART_WINDOW: Duration = Duration::from_secs(60);
pub const MAX_RESTARTS: usize = 3;
/// Wait before relaunch attempt 1, 2, 3: an instant crash loop is not retried hot.
const RESTART_BACKOFF: [Duration; 3] = [Duration::from_millis(500), Duration::from_secs(2), Duration::from_secs(5)];
/// Crash markers kept on disk (oldest removed first).
pub const MAX_MARKERS: usize = 20;
/// Last stderr lines of a sidecar generation copied into its crash marker.
pub const STDERR_TAIL_LINES: usize = 60;
const MAX_TAIL_LINE_CHARS: usize = 2_000;
/// Host log files are rotated once at launch when they grow past this size.
pub const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Relaunch after `delay`; `attempt` counts relaunches inside the window (1-based).
    Restart { attempt: usize, delay: Duration },
    /// The budget is spent: `recent` relaunches already happened inside the window.
    GiveUp { recent: usize },
}

/// Bounded automatic recovery. History survives successful relaunches on
/// purpose: a server that becomes ready and crashes again is still a loop.
#[derive(Debug)]
pub struct RestartBreaker {
    window: Duration,
    max: usize,
    attempts: VecDeque<Instant>,
}

impl Default for RestartBreaker {
    fn default() -> Self { Self::new(RESTART_WINDOW, MAX_RESTARTS) }
}

impl RestartBreaker {
    pub fn new(window: Duration, max: usize) -> Self { Self { window, max, attempts: VecDeque::new() } }

    fn prune(&mut self, now: Instant) {
        while self.attempts.front().is_some_and(|at| now.saturating_duration_since(*at) >= self.window) {
            self.attempts.pop_front();
        }
    }

    /// Only allowed attempts are recorded, so a refused attempt never extends the window.
    pub fn register(&mut self, now: Instant) -> RestartDecision {
        self.prune(now);
        if self.attempts.len() >= self.max {
            return RestartDecision::GiveUp { recent: self.attempts.len() };
        }
        self.attempts.push_back(now);
        let attempt = self.attempts.len();
        RestartDecision::Restart { attempt, delay: RESTART_BACKOFF[(attempt - 1).min(RESTART_BACKOFF.len() - 1)] }
    }

    /// An explicit "Try again" from the person starts a fresh budget.
    pub fn reset(&mut self) { self.attempts.clear(); }
}

/// The last lines a sidecar generation wrote to stderr, bounded in count and width.
#[derive(Debug, Default)]
pub struct StderrTail { lines: VecDeque<String> }

impl StderrTail {
    pub fn push(&mut self, chunk: &str) {
        for line in chunk.lines().map(str::trim_end).filter(|line| !line.is_empty()) {
            if self.lines.len() == STDERR_TAIL_LINES { self.lines.pop_front(); }
            self.lines.push_back(line.chars().take(MAX_TAIL_LINE_CHARS).collect());
        }
    }
    pub fn snapshot(&self) -> Vec<String> { self.lines.iter().cloned().collect() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrashOutcome {
    /// The host relaunched the server automatically.
    Restarted,
    /// The breaker tripped (or the relaunch failed): the server stayed stopped.
    Stopped,
}

/// One unexpected sidecar exit. The schema is read by
/// `server/modules/diagnostics` (keep both in step; additive changes only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashMarker {
    pub version: u32,
    /// Unique, sortable id: `<epoch ms>-<pid>`.
    pub id: String,
    pub at_ms: u64,
    pub at: String,
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub uptime_ms: u64,
    /// Whether this generation had answered the health check before it exited.
    pub was_ready: bool,
    pub outcome: CrashOutcome,
    /// Relaunches inside the breaker window, this one included when restarted.
    pub recent_restarts: usize,
    pub max_restarts: usize,
    pub window_secs: u64,
    /// Raw stderr; the server redacts it before it reaches a report or the UI.
    pub stderr_tail: Vec<String>,
}

pub struct ExitFacts {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub uptime: Duration,
    pub was_ready: bool,
    pub stderr_tail: Vec<String>,
}

pub fn epoch_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

impl CrashMarker {
    pub fn new(facts: ExitFacts, decision: RestartDecision, now: SystemTime) -> Self {
        let at_ms = epoch_ms(now);
        let (outcome, recent_restarts) = match decision {
            RestartDecision::Restart { attempt, .. } => (CrashOutcome::Restarted, attempt),
            RestartDecision::GiveUp { recent } => (CrashOutcome::Stopped, recent),
        };
        Self {
            version: 1,
            id: format!("{at_ms:013}-{}", facts.pid),
            at_ms,
            at: rfc3339(now),
            pid: facts.pid,
            exit_code: facts.exit_code,
            signal: facts.signal,
            uptime_ms: facts.uptime.as_millis() as u64,
            was_ready: facts.was_ready,
            outcome,
            recent_restarts,
            max_restarts: MAX_RESTARTS,
            window_secs: RESTART_WINDOW.as_secs(),
            stderr_tail: facts.stderr_tail,
        }
    }

    /// The breaker tripped after the marker for a relaunch was planned (the relaunch itself failed).
    pub fn mark_stopped(&mut self) { self.outcome = CrashOutcome::Stopped; }
}

/// `<log dir>/crashes`: one `crash-<id>.json` per unexpected exit.
pub fn crash_dir(log_dir: &Path) -> PathBuf { log_dir.join("crashes") }

/// Write atomically (temporary file + rename) so the server never reads half a
/// marker, then keep only the newest [`MAX_MARKERS`].
pub fn write_marker(dir: &Path, marker: &CrashMarker) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(format!("crash-{}.json", marker.id));
    let partial = dir.join(format!(".crash-{}.json.partial", marker.id));
    let body = serde_json::to_vec_pretty(marker).map_err(std::io::Error::other)?;
    {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(&body)?;
        file.sync_all()?;
    }
    std::fs::rename(&partial, &target)?;
    prune_markers(dir, MAX_MARKERS);
    Ok(target)
}

pub fn prune_markers(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut markers: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("crash-") && name.ends_with(".json")))
        .collect();
    // Ids start with a zero-padded epoch, so names sort chronologically.
    markers.sort();
    let excess = markers.len().saturating_sub(keep);
    for path in markers.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// Rotate `path` to `path.1` when it is larger than `max_bytes` (one generation kept).
pub fn rotate_log(path: &Path, max_bytes: u64) {
    if std::fs::metadata(path).map(|meta| meta.len() > max_bytes).unwrap_or(false) {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        let _ = std::fs::rename(path, PathBuf::from(rotated));
    }
}

/// Append one timestamped line to a host log file (best effort).
pub fn append_log(path: &Path, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", rfc3339(SystemTime::now()), line.trim_end());
    }
}

/// UTC RFC 3339 with milliseconds, without a date-time dependency.
pub fn rfc3339(time: SystemTime) -> String {
    let ms = epoch_ms(time);
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant), valid for every date after 1970.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60, ms % 1000)
}

/// Human description of an exit for the dialog and the host log.
pub fn describe_exit(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (_, Some(signal)) => format!("signal {signal}"),
        (Some(code), None) => format!("exit code {code}"),
        (None, None) => "an unknown exit status".into(),
    }
}

/// The message shown when the breaker stops relaunching.
pub fn give_up_message(recent: usize, exit: &str, log_dir: &Path) -> String {
    format!(
        "The local Specrails server stopped unexpectedly ({exit}). Specrails restarted it {recent} times in the last minute and has stopped trying, so it does not hide a crash loop. Your saved projects remain on disk.\n\nChoose Try again to start the server now, or quit and reopen Specrails. To share what happened, use Settings › About › Report a problem once the server is running.\n\nDiagnostics: {}",
        log_dir.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> ExitFacts {
        ExitFacts { pid: 42, exit_code: Some(1), signal: None, uptime: Duration::from_millis(1_500), was_ready: true, stderr_tail: vec!["boom".into()] }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("specrails-supervisor-{name}-{}-{}", std::process::id(), epoch_ms(SystemTime::now())));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn breaker_allows_three_restarts_per_minute_with_growing_backoff() {
        let mut breaker = RestartBreaker::default();
        let start = Instant::now();
        assert_eq!(breaker.register(start), RestartDecision::Restart { attempt: 1, delay: Duration::from_millis(500) });
        assert_eq!(breaker.register(start + Duration::from_secs(5)), RestartDecision::Restart { attempt: 2, delay: Duration::from_secs(2) });
        assert_eq!(breaker.register(start + Duration::from_secs(10)), RestartDecision::Restart { attempt: 3, delay: Duration::from_secs(5) });
        assert_eq!(breaker.register(start + Duration::from_secs(20)), RestartDecision::GiveUp { recent: 3 });
    }

    #[test]
    fn refused_attempts_do_not_extend_the_window_and_old_attempts_expire() {
        let mut breaker = RestartBreaker::default();
        let start = Instant::now();
        for offset in [0, 1, 2] { breaker.register(start + Duration::from_secs(offset)); }
        // Refusals at 30 s and 59 s are not recorded...
        assert!(matches!(breaker.register(start + Duration::from_secs(30)), RestartDecision::GiveUp { .. }));
        assert!(matches!(breaker.register(start + Duration::from_secs(59)), RestartDecision::GiveUp { .. }));
        // ...so the first attempt leaves the window exactly 60 s after it happened.
        assert_eq!(breaker.register(start + Duration::from_secs(60)), RestartDecision::Restart { attempt: 3, delay: Duration::from_secs(5) });
        assert_eq!(breaker.register(start + Duration::from_secs(200)), RestartDecision::Restart { attempt: 1, delay: Duration::from_millis(500) });
    }

    #[test]
    fn reset_starts_a_fresh_budget_after_try_again() {
        let mut breaker = RestartBreaker::new(RESTART_WINDOW, 1);
        let now = Instant::now();
        breaker.register(now);
        assert_eq!(breaker.register(now), RestartDecision::GiveUp { recent: 1 });
        breaker.reset();
        assert!(matches!(breaker.register(now), RestartDecision::Restart { attempt: 1, .. }));
    }

    #[test]
    fn stderr_tail_keeps_the_last_bounded_lines() {
        let mut tail = StderrTail::default();
        for index in 0..(STDERR_TAIL_LINES + 5) { tail.push(&format!("line {index}\n\n")); }
        tail.push(&"x".repeat(MAX_TAIL_LINE_CHARS + 50));
        let lines = tail.snapshot();
        assert_eq!(lines.len(), STDERR_TAIL_LINES);
        assert_eq!(lines[0], "line 6");
        assert_eq!(lines.last().unwrap().len(), MAX_TAIL_LINE_CHARS);
    }

    #[test]
    fn marker_records_the_exit_and_the_breaker_decision() {
        let now = UNIX_EPOCH + Duration::from_millis(1_763_460_000_123);
        let restarted = CrashMarker::new(facts(), RestartDecision::Restart { attempt: 2, delay: Duration::ZERO }, now);
        assert_eq!(restarted.outcome, CrashOutcome::Restarted);
        assert_eq!(restarted.recent_restarts, 2);
        assert_eq!(restarted.id, "1763460000123-42");
        assert_eq!(restarted.at, "2025-11-18T10:00:00.123Z");
        let json: serde_json::Value = serde_json::to_value(&restarted).unwrap();
        for key in ["atMs", "exitCode", "uptimeMs", "wasReady", "recentRestarts", "maxRestarts", "windowSecs", "stderrTail"] {
            assert!(json.get(key).is_some(), "{key}");
        }
        assert_eq!(json["outcome"], "restarted");
        let mut stopped = CrashMarker::new(facts(), RestartDecision::GiveUp { recent: 3 }, now);
        assert_eq!((stopped.outcome, stopped.recent_restarts), (CrashOutcome::Stopped, 3));
        let mut planned = restarted.clone();
        planned.mark_stopped();
        assert_eq!(planned.outcome, CrashOutcome::Stopped);
        stopped.stderr_tail.clear();
        assert!(serde_json::to_string(&stopped).unwrap().contains("\"outcome\":\"stopped\""));
    }

    #[test]
    fn markers_are_written_atomically_and_pruned_oldest_first() {
        let dir = temp_dir("markers");
        for index in 0..(MAX_MARKERS as u64 + 3) {
            let marker = CrashMarker::new(facts(), RestartDecision::GiveUp { recent: 3 }, UNIX_EPOCH + Duration::from_secs(1_000 + index));
            let path = write_marker(&dir, &marker).unwrap();
            let read: CrashMarker = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(read, marker);
        }
        // The server's acknowledgement file is never pruned by the host.
        std::fs::write(dir.join("acknowledged.json"), "{}").unwrap();
        prune_markers(&dir, MAX_MARKERS);
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert!(names.contains(&"acknowledged.json".to_string()));
        assert!(!names.iter().any(|name| name.ends_with(".partial")));
        let markers: Vec<&String> = names.iter().filter(|name| name.starts_with("crash-")).collect();
        assert_eq!(markers.len(), MAX_MARKERS);
        assert!(markers[0].starts_with("crash-0000001003000-"), "{}", markers[0]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn logs_rotate_once_past_the_limit_and_lines_are_timestamped() {
        let dir = temp_dir("logs");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("desktop.log");
        append_log(&log, "first\n");
        let body = std::fs::read_to_string(&log).unwrap();
        assert!(body.ends_with(" first\n"));
        assert!(body.starts_with("20") && body.as_bytes()[10] == b'T', "{body}");
        rotate_log(&log, 1);
        assert!(!log.exists());
        assert!(dir.join("desktop.log.1").exists());
        append_log(&log, "second");
        rotate_log(&log, MAX_LOG_BYTES);
        assert!(log.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rfc3339_formats_known_instants() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_millis(951_782_400_000)), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_millis(4_102_444_799_999)), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn exit_descriptions_and_give_up_message_are_actionable() {
        assert_eq!(describe_exit(Some(1), None), "exit code 1");
        assert_eq!(describe_exit(None, Some(9)), "signal 9");
        assert_eq!(describe_exit(None, None), "an unknown exit status");
        let message = give_up_message(3, "signal 9", Path::new("/logs"));
        for needle in ["signal 9", "3 times", "Try again", "Report a problem", "/logs", "saved projects remain"] {
            assert!(message.contains(needle), "{needle}");
        }
    }
}
