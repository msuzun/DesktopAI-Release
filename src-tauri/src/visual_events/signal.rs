use std::sync::{Condvar, Mutex};
use std::time::Instant;

/// A revision prevents lost notifications between observation and waiting.
/// Cancellation uses the same notification as event publication; no polling.
#[derive(Default)]
pub struct StateSignal {
    revision: Mutex<u64>,
    changed: Condvar,
}
impl StateSignal {
    pub fn revision(&self) -> u64 {
        *self.revision.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn notify(&self) {
        let mut revision = self.revision.lock().unwrap_or_else(|e| e.into_inner());
        *revision = revision.wrapping_add(1);
        self.changed.notify_all();
    }
    pub fn wait(&self, revision: u64, deadline: Instant) {
        let mut current = self.revision.lock().unwrap_or_else(|e| e.into_inner());
        while *current == revision {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            current = self
                .changed
                .wait_timeout(current, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}
