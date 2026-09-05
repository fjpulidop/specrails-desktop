use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum BackendReadiness {
    Ready,
    TimedOut,
    Stopped,
}

/// `/api/state` requires authentication, so its 401 is not readiness evidence.
/// Check the public health contract instead of accepting any HTTP responder.
fn is_backend_health(status: u16, body: &str) -> bool {
    if status != 200 {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value["status"] == "ok"
        && value["mode"] == "super"
        && value["version"].is_string()
        && value["projects"].as_u64().is_some()
}

fn poll_readiness(
    timeout: Duration,
    interval: Duration,
    is_running: impl Fn() -> bool,
    mut probe: impl FnMut() -> bool,
) -> BackendReadiness {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !is_running() {
            return BackendReadiness::Stopped;
        }
        if probe() {
            // The process may exit while the HTTP request is in flight.
            return if is_running() {
                BackendReadiness::Ready
            } else {
                BackendReadiness::Stopped
            };
        }
        std::thread::sleep(interval.min(timeout.saturating_sub(start.elapsed())));
    }
    BackendReadiness::TimedOut
}

pub fn wait_for_backend(
    url: &str,
    timeout: Duration,
    is_running: impl Fn() -> bool,
) -> BackendReadiness {
    // Desktop loopback must not inherit a corporate/system HTTP proxy or follow
    // a redirect to an unrelated service that happens to own the port.
    let Ok(client) = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return BackendReadiness::TimedOut;
    };
    poll_readiness(timeout, Duration::from_millis(500), is_running, || {
        let Ok(response) = client.get(url).send() else {
            return false;
        };
        let status = response.status().as_u16();
        response
            .text()
            .map(|body| is_backend_health(status, &body))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const HEALTHY: &str = r#"{"status":"ok","mode":"super","version":"2.40.0","projects":3}"#;

    #[test]
    fn accepts_the_public_health_contract_including_empty_registries() {
        assert!(is_backend_health(200, HEALTHY));
        assert!(is_backend_health(200, &HEALTHY.replace('3', "0")));
    }

    #[test]
    fn rejects_auth_errors_server_errors_and_unrelated_responses() {
        for status in [301, 401, 404, 500, 503] {
            assert!(!is_backend_health(status, HEALTHY));
        }
        for body in [
            "<html>server is up</html>",
            "{}",
            r#"{"status":"ok"}"#,
            r#"{"status":"starting","mode":"super","version":"2.40.0","projects":3}"#,
            r#"{"status":"ok","mode":"super","version":"2.40.0","projects":null}"#,
        ] {
            assert!(!is_backend_health(200, body));
        }
    }

    #[test]
    fn transient_startup_failures_are_retried_until_ready() {
        let attempts = Cell::new(0);
        let result = poll_readiness(Duration::from_secs(1), Duration::ZERO, || true, || {
            attempts.set(attempts.get() + 1);
            attempts.get() == 4
        });
        assert_eq!(result, BackendReadiness::Ready);
        assert_eq!(attempts.get(), 4);
    }

    #[test]
    fn stopped_sidecar_is_never_reported_ready_or_probed_again() {
        assert_eq!(
            poll_readiness(Duration::from_secs(1), Duration::ZERO, || false, || panic!("dead sidecar was probed")),
            BackendReadiness::Stopped
        );
        let running = Cell::new(true);
        assert_eq!(
            poll_readiness(Duration::from_secs(1), Duration::ZERO, || running.get(), || {
                running.set(false);
                true
            }),
            BackendReadiness::Stopped
        );
    }

    #[test]
    fn readiness_timeout_is_distinct_from_a_sidecar_exit() {
        assert_eq!(
            poll_readiness(Duration::ZERO, Duration::ZERO, || true, || false),
            BackendReadiness::TimedOut
        );
    }
}
