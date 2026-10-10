use super::*;
use std::collections::VecDeque;

pub struct VisualEventTimeline {
    entries: VecDeque<VisualEvent>,
    capacity: usize,
    retention: Duration,
}
impl VisualEventTimeline {
    pub fn new(capacity: usize, retention: Duration) -> Self {
        let capacity = capacity.clamp(1, 64);
        Self {
            entries: VecDeque::with_capacity(capacity),
            capacity,
            retention,
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
    pub fn prune(&mut self, now: Instant) {
        self.entries.retain(|e| {
            now.saturating_duration_since(e.end.unwrap_or(e.peak).timestamp) <= self.retention
        });
    }
    pub fn insert(&mut self, event: VisualEvent, now: Instant) {
        self.prune(now);
        if let Some(existing) = self.entries.iter_mut().find(|e| e.id == event.id) {
            *existing = event;
            return;
        }
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        let at = self
            .entries
            .iter()
            .position(|e| e.start.timestamp > event.start.timestamp)
            .unwrap_or(self.entries.len());
        self.entries.insert(at, event);
    }
    pub fn events_between(&self, start: Instant, end: Instant, now: Instant) -> Vec<VisualEvent> {
        self.entries
            .iter()
            .filter(|e| {
                let time = e.end.unwrap_or(e.peak).timestamp;
                time <= now
                    && now.duration_since(time) <= self.retention
                    && e.start.timestamp <= end
                    && time >= start
            })
            .copied()
            .collect()
    }
    pub fn recent_events(&self, duration: Duration, now: Instant) -> Vec<VisualEvent> {
        self.events_between(
            now.checked_sub(duration.min(self.retention)).unwrap_or(now),
            now,
            now,
        )
    }
    pub fn reconcile_keyframes(&mut self, available: impl Fn(KeyframeId) -> bool) {
        for e in &mut self.entries {
            if e.keyframe.is_some_and(|id| !available(id)) {
                e.keyframe = None;
            }
        }
    }
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}
