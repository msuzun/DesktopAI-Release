//! Request-driven visual context. Providers never access the memory tiers.
mod commands;
pub mod model;
mod source;
mod turn;
use crate::session::Session;
pub use commands::*;
pub use model::*;
use source::Pixels;
use source::{Asset, Generation, History, Sources};
use std::{
    collections::VecDeque,
    sync::{mpsc, Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};
struct Snapshot {
    decision: Option<turn::Decision>,
    boundary_reserved: bool,
    id: String,
    asset: Arc<dyn Asset>,
    expires: Instant,
    selected: Instant,
    retained_until: Option<Instant>,
    source_generation: Generation,
    sources: Arc<dyn Sources>,
}
impl Snapshot {
    fn valid(&self) -> bool {
        Instant::now() <= self.retained_until.unwrap_or(self.expires)
            && self.asset.available()
            && self.sources.generation() == self.source_generation
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        self.asset.revoke();
    }
}
struct State {
    epoch: u64,
    sequence: u64,
    turn: String,
    conversation: String,
    follow_up: Option<FollowUpVisualReference>,
    reference: Option<Instant>,
    history: Option<TurnHistory>,
    reservation_attempted: bool,
    snapshots: VecDeque<Snapshot>,
    calls: [usize; 3],
    images: usize,
    diagnostics: Diagnostics,
    binding: Option<(Arc<dyn Sources>, Generation, u64)>,
}
// Metadata points into the existing five-entry / 64 MiB snapshot registry.
// There is no image copy, cache slot reservation, or automatic provider upload.
struct FollowUpVisualReference {
    snapshot_id: String,
    origin_turn_id: String,
    origin_conversation: String,
    expires: Instant,
    remaining_turns: u8,
    completed: bool,
}
struct TurnHistory {
    value: History,
    expires: Instant,
    generation: Generation,
    sources: Arc<dyn Sources>,
    access: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            epoch: 1,
            sequence: 0,
            turn: String::new(),
            conversation: String::new(),
            follow_up: None,
            reference: None,
            history: None,
            reservation_attempted: false,
            snapshots: VecDeque::with_capacity(SNAPSHOT_CAPACITY),
            calls: [0; 3],
            images: 0,
            diagnostics: Diagnostics::default(),
            binding: None,
        }
    }
}
impl State {
    fn prune(&mut self) {
        self.snapshots.retain(Snapshot::valid);
        if self.follow_up.as_ref().is_some_and(|r| {
            Instant::now() >= r.expires || !self.snapshots.iter().any(|s| s.id == r.snapshot_id)
        }) {
            self.follow_up = None;
        }
        if self
            .history
            .as_ref()
            .is_some_and(|h| Instant::now() >= h.expires || h.sources.generation() != h.generation)
        {
            self.history = None;
        }
    }
    fn invalidate(&mut self) {
        self.follow_up = None;
        self.conversation.clear();
        self.reset_turn();
    }
    fn accessible(&self, snapshot: &Snapshot) -> bool {
        snapshot.valid()
            && (Instant::now() <= snapshot.expires
                || self.follow_up.as_ref().is_some_and(|r| {
                    r.completed
                        && r.snapshot_id == snapshot.id
                        && r.origin_conversation != self.conversation
                        && r.remaining_turns == 0
                }))
    }
    fn reset_turn(&mut self) {
        if let Some(signal) = self.binding.as_ref().and_then(|(s, _, _)| s.signal()) {
            signal.notify();
        }
        self.epoch += 1;
        self.turn.clear();
        self.snapshots.retain(|s| {
            self.follow_up
                .as_ref()
                .is_some_and(|r| r.snapshot_id == s.id)
        });
        self.calls = [0; 3];
        self.images = 0;
        self.reference = None;
        self.history = None;
        self.reservation_attempted = false;
        if self.snapshots.is_empty() {
            self.binding = None;
        }
    }
}
struct Job {
    request: Request,
    epoch: u64,
    access: u64,
    session: Arc<Mutex<Session>>,
    sources: Arc<dyn Sources>,
    reply: mpsc::SyncSender<Result<Response>>,
    received: Instant,
}
#[derive(Default)]
struct Queue {
    pending: Option<Job>,
    stop: bool,
    recheck_expiration: bool,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    queue: Mutex<Queue>,
    wake: Condvar,
}
pub struct VisualContextService {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}
impl Default for VisualContextService {
    fn default() -> Self {
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        let worker = std::thread::Builder::new()
            .name("visual-context-preparation".into())
            .spawn(move || {
                loop {
                    // Only expiration bookkeeping runs while idle. No visual readback,
                    // encoding, or provider payload is prepared speculatively.
                    let timeout = {
                        let mut state = worker_shared
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        state.prune();
                        state
                            .snapshots
                            .iter()
                            .map(|s| {
                                s.retained_until
                                    .unwrap_or(s.expires)
                                    .saturating_duration_since(Instant::now())
                            })
                            .chain(
                                state
                                    .history
                                    .iter()
                                    .map(|h| h.expires.saturating_duration_since(Instant::now())),
                            )
                            .min()
                            .unwrap_or(Duration::from_secs(60))
                    };
                    let mut queue = worker_shared
                        .queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if queue.stop {
                        break;
                    }
                    if queue.recheck_expiration {
                        queue.recheck_expiration = false;
                        drop(queue);
                        continue;
                    }
                    if let Some(job) = queue.pending.take() {
                        drop(queue);
                        {
                            let mut state = worker_shared
                                .state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            state.diagnostics.active_jobs = 1;
                        }
                        let kind = job.request.kind;
                        let mut timings = Timings::default();
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            prepare(&worker_shared, &job, &mut timings)
                        }))
                        .unwrap_or_else(|_| Err(error("encoding_failed")));
                        timings.total_ms = millis(job.received.elapsed());
                        {
                            let mut state = worker_shared
                                .state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            let d = &mut state.diagnostics;
                            d.active_jobs = 0;
                            d.last_kind = Some(kind);
                            d.last_turn_id = Some(job.request.turn_id.clone());
                            d.last_error = result.as_ref().err().map(|e| e.code);
                            // Keep completed-stage timings on failure too, so an expired Current
                            // reports its preparation cost instead of an earlier success.
                            d.last_timings = timings;
                            if job.request.select_only {
                                match &result {
                                    Ok(_) => d.selection.succeeded += 1,
                                    Err(e)
                                        if matches!(
                                            e.code,
                                            "cancelled"
                                                | "permission_denied"
                                                | "generation_changed"
                                        ) =>
                                    {
                                        d.selection.cancelled += 1
                                    }
                                    Err(_) => d.selection.failed += 1,
                                }
                                d.last_status = Some(if result.is_ok() {
                                    "SnapshotSelected"
                                } else {
                                    "SelectionUnavailable"
                                });
                            } else {
                                match &result {
                                    Ok(response) => {
                                        d.last_status = Some("Prepared");
                                        d.last_timings = response.timings.clone();
                                        let m = d.metric(kind);
                                        m.succeeded += 1;
                                        m.frames += response.frames.len() as u64;
                                        m.events += response.events.len() as u64;
                                        m.encoded_bytes += response
                                            .frames
                                            .iter()
                                            .map(|f| f.encoded_size_bytes as u64)
                                            .sum::<u64>();
                                        m.truncated += u64::from(response.truncated);
                                        m.empty +=
                                            u64::from(response.completeness == Completeness::Empty);
                                        m.total_coverage_ms += response.actual_coverage_ms;
                                        m.total_lookback_ms +=
                                            response.requested_lookback_ms as f64;
                                        add_timings(&mut m.total, &response.timings);
                                        m.maximum_ms = m.maximum_ms.max(response.timings.total_ms);
                                    }
                                    Err(e) => {
                                        d.last_status = Some(e.code);
                                        d.readback_failures +=
                                            u64::from(e.code == "readback_failed");
                                        d.encoding_failures +=
                                            u64::from(e.code == "encoding_failed");
                                        let m = d.metric(kind);
                                        m.failed += 1;
                                        m.cancelled += u64::from(matches!(
                                            e.code,
                                            "cancelled"
                                                | "permission_denied"
                                                | "generation_changed"
                                        ));
                                        m.expired += u64::from(e.code == "snapshot_expired");
                                        m.unavailable += u64::from(matches!(
                                            e.code,
                                            "current_unavailable" | "history_unavailable"
                                        ));
                                    }
                                }
                            }
                        }
                        let _ = job.reply.send(result);
                    } else {
                        drop(
                            worker_shared
                                .wake
                                .wait_timeout(queue, timeout)
                                .unwrap_or_else(|e| e.into_inner()),
                        );
                    }
                }
            })
            .ok();
        Self { shared, worker }
    }
}
fn add_timings(a: &mut Timings, b: &Timings) {
    a.permission_ms += b.permission_ms;
    a.selection_ms += b.selection_ms;
    a.wait_ms += b.wait_ms;
    a.capture_ms += b.capture_ms;
    a.readback_ms += b.readback_ms;
    a.crop_ms += b.crop_ms;
    a.encoding_ms += b.encoding_ms;
    a.assembly_ms += b.assembly_ms;
    a.total_ms += b.total_ms;
}
impl VisualContextService {
    // Reserve existing slots only: no GPU allocation/copy, CPU readback, encoding
    // or provider submission. This preserves the meaning of the turn's window
    // while its provider decides whether to request Recent.
    pub fn reserve_history(&self, sources: Arc<dyn Sources>, session: &Mutex<Session>) {
        let access = match session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()
        {
            Ok(access) => access,
            Err(_) => return,
        };
        let (reference, epoch) = {
            let state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(reference) = state.reference else {
                return;
            };
            if state.history.is_some() {
                return;
            }
            (reference, state.epoch)
        };
        let expires = reference + LIFETIME;
        if expires <= Instant::now() {
            return;
        }
        let generation = sources.generation();
        let Ok(mut history) = sources.history(reference - LIFETIME, reference) else {
            return;
        };
        history.events.sort_by(|a, b| {
            (a.rank, a.asset.is_none())
                .cmp(&(b.rank, b.asset.is_none()))
                .then_with(|| b.start.cmp(&a.start))
        });
        history.events.truncate(MAX_EVENTS);
        let mut retained = Vec::new();
        for event in &mut history.events {
            event.asset = event.asset.as_ref().and_then(|asset| {
                let info = asset.info();
                if info.timestamp > reference || info.timestamp < reference - LIFETIME {
                    return None;
                }
                if let Some((_, held)) = retained.iter().find(|(id, _)| *id == info.cursor) {
                    return Some(Arc::clone(held));
                }
                if retained.len() >= MAX_IMAGES {
                    return None;
                }
                let held = asset.reserve(expires)?;
                retained.push((info.cursor, held.clone()));
                Some(held)
            });
        }
        if session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()
            .ok()
            != Some(access)
        {
            return;
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.epoch == epoch
            && state.reference == Some(reference)
            && sources.generation() == generation
        {
            state.history = Some(TurnHistory {
                value: history,
                expires,
                generation,
                sources,
                access,
            });
        }
        drop(state);
        self.shared
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recheck_expiration = true;
        self.shared.wake.notify_one();
    }
    // Keep the same state -> queue lock order as request admission. Pending
    // selections never reach the worker's completion accounting.
    fn cancel_pending(&self, state: &mut State) {
        let pending = self
            .shared
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .take();
        if let Some(job) = pending {
            state.diagnostics.selection.cancelled += u64::from(job.request.select_only);
            let _ = job.reply.send(Err(error("cancelled")));
        }
    }
    pub fn invalidate(&self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.invalidate();
        self.cancel_pending(&mut state);
        drop(state);
        self.shared.wake.notify_all();
    }
    pub fn begin_conversation_turn(
        &self,
        turn: &str,
        reference_age_ms: Option<f64>,
        conversation: &str,
    ) -> Result<()> {
        if turn.is_empty()
            || turn.len() > 100
            || conversation.is_empty()
            || conversation.len() > 100
            || reference_age_ms.is_some_and(|v| !v.is_finite() || !(0. ..=60_000.).contains(&v))
        {
            return Err(error("invalid_arguments"));
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.turn != turn {
            state.prune();
            if state.conversation != conversation {
                if let Some(reference) = &mut state.follow_up {
                    if reference.completed && reference.remaining_turns > 0 {
                        reference.remaining_turns -= 1;
                    } else {
                        state.follow_up = None;
                    }
                }
            }
            state.reset_turn();
            state.conversation = conversation.to_owned();
            state.turn = turn.to_owned();
            self.cancel_pending(&mut state);
        }
        if state.reference.is_none() {
            state.reference = reference_age_ms
                .and_then(|age| Instant::now().checked_sub(Duration::from_secs_f64(age / 1000.)));
        }
        drop(state);
        self.shared.wake.notify_all();
        Ok(())
    }
    pub fn cancel_turn(&self, preserve_completed: bool) {
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.prune();
            if !preserve_completed || !state.follow_up.as_ref().is_some_and(|r| r.completed) {
                state.follow_up = None;
            }
            state.reset_turn();
            self.cancel_pending(&mut state);
        }
        self.shared.wake.notify_all();
    }
    pub fn note_delivery(
        &self,
        session: &Mutex<Session>,
        turn: &str,
        ids: &[String],
    ) -> Result<()> {
        if ids.len() > MAX_IMAGES {
            return Err(error("invalid_arguments"));
        }
        let access = session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()?;
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        if state.turn != turn {
            return Err(error("cancelled"));
        }
        if state
            .binding
            .as_ref()
            .is_none_or(|(s, g, a)| s.generation() != *g || *a != access)
        {
            return Err(error("generation_changed"));
        }
        // Prefer the newest delivered historical moment. Current never replaces it.
        let candidate = state
            .snapshots
            .iter()
            .filter(|s| {
                ids.contains(&s.id) && s.asset.info().role != Role::Current && state.accessible(s)
            })
            .max_by_key(|s| s.asset.info().timestamp)
            .map(|s| (s.id.clone(), s.selected));
        if let Some((id, selected)) = candidate {
            if state
                .follow_up
                .as_ref()
                .is_some_and(|r| r.snapshot_id == id)
            {
                return Ok(());
            }
            if let Some(old) = state.follow_up.take() {
                if let Some(s) = state.snapshots.iter_mut().find(|s| s.id == old.snapshot_id) {
                    s.retained_until = None;
                }
            }
            let expires = selected + FOLLOW_UP_LIFETIME;
            state
                .snapshots
                .iter_mut()
                .find(|s| s.id == id)
                .unwrap()
                .retained_until = Some(expires);
            state.follow_up = Some(FollowUpVisualReference {
                snapshot_id: id,
                origin_turn_id: turn.to_owned(),
                origin_conversation: state.conversation.clone(),
                expires,
                remaining_turns: 1,
                completed: false,
            });
        }
        drop(state);
        self.shared
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recheck_expiration = true;
        self.shared.wake.notify_all();
        Ok(())
    }
    pub fn follow_up(
        &self,
        session: &Mutex<Session>,
        turn: &str,
    ) -> Result<Option<FollowUpContext>> {
        let access = session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()?;
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        if state.turn != turn {
            return Err(error("cancelled"));
        }
        if state
            .binding
            .as_ref()
            .is_some_and(|(s, g, a)| s.generation() != *g || *a != access)
        {
            return Err(error("generation_changed"));
        }
        Ok(state.follow_up.as_ref().and_then(|r| {
            let snapshot = state
                .snapshots
                .iter()
                .find(|s| s.id == r.snapshot_id && state.accessible(s))?;
            Some(FollowUpContext {
                snapshot_id: r.snapshot_id.clone(),
                origin_turn_id: r.origin_turn_id.clone(),
                origin: snapshot.asset.info().role,
                expires_at_unix_ms: unix(r.expires),
            })
        }))
    }
    pub fn complete_turn(&self, turn: &str) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.turn != turn {
            return;
        }
        state.prune();
        state.epoch += 1;
        if let Some(reference) = &mut state.follow_up {
            reference.completed = true;
        }
        let retained = state.follow_up.as_ref().map(|r| r.snapshot_id.clone());
        state.snapshots.retain(|s| retained.as_ref() == Some(&s.id));
        state.history = None;
        self.cancel_pending(&mut state);
        drop(state);
        self.shared.wake.notify_all();
    }
    pub fn request(
        &self,
        request: Request,
        sources: Arc<dyn Sources>,
        session: Arc<Mutex<Session>>,
    ) -> Result<mpsc::Receiver<Result<Response>>> {
        request.validate()?;
        if self.worker.is_none() {
            return Err(error("visual_busy"));
        }
        let access = session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()?;
        let (tx, rx) = mpsc::sync_channel(1);
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.turn != request.turn_id {
            return Err(error("cancelled"));
        }
        let generation = sources.generation();
        if state
            .binding
            .as_ref()
            .is_some_and(|(s, g, a)| s.generation() != *g || *g != generation || *a != access)
        {
            return Err(error("generation_changed"));
        }
        state.binding = Some((sources.clone(), generation, access));
        let index = match request.kind {
            Kind::Current => 0,
            Kind::Detail => 1,
            Kind::Recent => 2,
        };
        if state.calls[index] >= [2, 3, 2][index] {
            return Err(error("visual_limit_reached"));
        }
        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
        // One worker and one waiting request. A new turn invalidates old work;
        // no amount of tool traffic can build a preparation backlog.
        if queue.pending.is_some() {
            state.diagnostics.rejected_busy += 1;
            return Err(error("visual_busy"));
        }
        state.calls[index] += usize::from(!request.select_only);
        if request.select_only {
            state.reservation_attempted = true;
            state.diagnostics.selection.requests += 1;
        } else {
            state.diagnostics.metric(request.kind).requests += 1;
        }
        queue.pending = Some(Job {
            request,
            epoch: state.epoch,
            access,
            session,
            sources,
            reply: tx,
            received: Instant::now(),
        });
        drop(queue);
        drop(state);
        self.shared.wake.notify_one();
        Ok(rx)
    }
    pub fn validate(
        &self,
        session: &Mutex<Session>,
        epoch: u64,
        turn: &str,
        ids: &[String],
    ) -> Result<()> {
        if ids.len() > MAX_IMAGES {
            return Err(error("invalid_arguments"));
        }
        let access = session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .visual_access_generation()?;
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        if state.epoch != epoch || state.turn != turn {
            return Err(error("cancelled"));
        }
        if state
            .binding
            .as_ref()
            .is_none_or(|(s, g, a)| s.generation() != *g || *a != access)
        {
            return Err(error("generation_changed"));
        }
        if ids.iter().any(|id| {
            !state
                .snapshots
                .iter()
                .any(|s| s.id == *id && state.accessible(s))
        }) {
            return Err(error("snapshot_expired"));
        }
        Ok(())
    }
    pub fn current_submission_age(&self, ids: &[String]) -> Result<f64> {
        if ids.len() != 1 {
            return Err(error("invalid_arguments"));
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        let snapshot = state
            .snapshots
            .iter()
            .find(|s| s.id == ids[0])
            .ok_or_else(|| error("snapshot_expired"))?;
        let info = snapshot.asset.info();
        if info.role != Role::Current
            || info.timestamp.elapsed()
                > if snapshot.boundary_reserved {
                    TURN_DELIVERY_AGE
                } else {
                    HARD_AGE
                }
        {
            return Err(error("current_unavailable"));
        }
        Ok(millis(info.timestamp.elapsed()))
    }
    pub fn diagnostics(&self) -> Diagnostics {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        let mut d = state.diagnostics.clone();
        d.snapshots = state.snapshots.len();
        d.snapshot_capacity = SNAPSHOT_CAPACITY;
        d.snapshot_gpu_bytes = state.snapshots.iter().map(|s| s.asset.owned_bytes()).sum();
        d.follow_up_capacity = 1;
        d.follow_up = state.follow_up.as_ref().map(|r| FollowUpDiagnostic {
            snapshot_id: r.snapshot_id.clone(),
            origin_turn_id: r.origin_turn_id.clone(),
            remaining_turns: r.remaining_turns,
            completed: r.completed,
            expires_in_ms: millis(r.expires.saturating_duration_since(Instant::now())),
        });
        d.reserved_history_events = state.history.as_ref().map_or(0, |h| h.value.events.len());
        d.reserved_history_keyframes = state.history.as_ref().map_or(0, |h| {
            h.value.events.iter().filter(|e| e.asset.is_some()).count()
        });
        d.queued_jobs = usize::from(
            self.shared
                .queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pending
                .is_some(),
        );
        d
    }
}
impl Drop for VisualContextService {
    fn drop(&mut self) {
        self.invalidate();
        self.shared
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stop = true;
        self.shared.wake.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn check(shared: &Shared, job: &Job, generation: Option<Generation>) -> Result<()> {
    if !job
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .visual_access_valid(job.access)
    {
        return Err(error("permission_denied"));
    }
    let state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if state.epoch != job.epoch || state.turn != job.request.turn_id {
        return Err(error("cancelled"));
    }
    if state
        .binding
        .as_ref()
        .is_none_or(|(s, g, a)| s.generation() != *g || *a != job.access)
    {
        return Err(error("generation_changed"));
    }
    if generation.is_some_and(|g| job.sources.generation() != g) {
        return Err(error("generation_changed"));
    }
    Ok(())
}
// Account before allocation, across Current AND selected historical snapshots.
// Never evict a snapshot selected earlier in the same response.
fn snapshot_room(shared: &Shared, bytes: u64, protected: &[String]) -> bool {
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    state.prune();
    while state.snapshots.len() >= SNAPSHOT_CAPACITY
        || state
            .snapshots
            .iter()
            .map(|s| s.asset.owned_bytes())
            .sum::<u64>()
            .saturating_add(bytes)
            > SNAPSHOT_GPU_BUDGET
    {
        let follow_up = state
            .follow_up
            .as_ref()
            .filter(|r| r.origin_conversation != state.conversation)
            .map(|r| r.snapshot_id.as_str());
        let Some(index) = state
            .snapshots
            .iter()
            .position(|s| Some(s.id.as_str()) == follow_up && !protected.contains(&s.id))
            .or_else(|| {
                state.snapshots.iter().position(|s| {
                    s.asset.info().role != Role::Current && !protected.contains(&s.id)
                })
            })
        else {
            return false;
        };
        state.snapshots.remove(index);
    }
    true
}
fn register(
    shared: &Shared,
    job: &Job,
    asset: Arc<dyn Asset>,
    generation: Generation,
) -> Result<String> {
    check(shared, job, Some(generation))?;
    let info = asset.info();
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    state.prune();
    if state.epoch != job.epoch {
        return Err(error("cancelled"));
    }
    if let Some(s) = state.snapshots.iter().find(|s| {
        s.asset.info().role == info.role
            && s.asset.info().cursor == info.cursor
            && s.asset.info().lineage == info.lineage
    }) {
        return Ok(s.id.clone());
    }
    if state.snapshots.len() == SNAPSHOT_CAPACITY {
        // Keep the active Current alongside bounded historical references.
        // A second Recent query must not silently evict implicit Current Detail.
        let oldest_history = state
            .snapshots
            .iter()
            .position(|snapshot| snapshot.asset.info().role != Role::Current)
            .unwrap_or(0);
        state.snapshots.remove(oldest_history);
    }
    state.sequence += 1;
    let id = format!("snapshot_{}_{}", state.epoch, state.sequence);
    // Tool-flow lifetime is distinct from the source's five-second query horizon.
    // It is never refreshed by Detail, and cancellation revokes the owned source.
    let selected = Instant::now();
    let expires = selected + LIFETIME;
    state.snapshots.push_back(Snapshot {
        decision: None,
        boundary_reserved: false,
        id: id.clone(),
        asset,
        expires,
        selected,
        retained_until: None,
        source_generation: generation,
        sources: job.sources.clone(),
    });
    Ok(id)
}
fn resolve(shared: &Shared, job: &Job, id: &str) -> Result<Arc<dyn Asset>> {
    check(shared, job, None)?;
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    state.prune();
    state
        .snapshots
        .iter()
        .find(|s| s.id == id && state.accessible(s))
        .map(|s| s.asset.clone())
        .ok_or_else(|| error("snapshot_expired"))
}
fn prepare(shared: &Shared, job: &Job, timings: &mut Timings) -> Result<Response> {
    let started = Instant::now();
    check(shared, job, None)?;
    timings.permission_ms = millis(started.elapsed());
    let reference = {
        shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reference
            .unwrap_or(job.received)
    };
    let request = &job.request;
    let mut response = Response {
        follow_up_reference: None,
        current_max_age_ms: None,
        temporal_role: None,
        request_id: String::new(),
        turn_id: request.turn_id.clone(),
        epoch: job.epoch,
        kind: request.kind,
        generated_at_unix_ms: 0.,
        reference_time_unix_ms: unix(reference),
        freshness: Freshness::Unavailable,
        completeness: Completeness::Complete,
        requested_lookback_ms: if request.kind == Kind::Recent {
            request.lookback_ms
        } else {
            0
        },
        actual_coverage_ms: 0.,
        truncated: false,
        warnings: Vec::new(),
        events: Vec::new(),
        frames: Vec::new(),
        timings: Timings::default(),
    };
    let selection_start = Instant::now();
    let mut selections: Vec<(String, Arc<dyn Asset>)> = Vec::new();
    let mut recent_diagnostic = None;
    let generation;
    match request.kind {
        Kind::Current => {
            let reserved = {
                let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.prune();
                state
                    .snapshots
                    .iter()
                    .find(|s| s.boundary_reserved && s.asset.info().role == Role::Current)
                    .map(|s| (s.id.clone(), s.asset.clone(), s.decision.clone()))
            };
            if let Some((id, asset, decision)) = reserved {
                generation = job.sources.generation();
                if asset.info().timestamp.elapsed() > TURN_DELIVERY_AGE {
                    return Err(error("current_unavailable"));
                }
                response.current_max_age_ms = Some(millis(TURN_DELIVERY_AGE));
                response.temporal_role = Some(turn_role(decision.as_ref()));
                selections.push((id, asset));
            } else {
                // Compatibility capture is intentionally not speculative.
                if request.select_only && job.sources.compatibility() {
                    return Ok(response);
                }
                if !request.select_only
                    && !job.sources.compatibility()
                    && reference.elapsed() > turn::ALIGNMENT
                    && shared
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .reservation_attempted
                {
                    return Err(error("current_unavailable"));
                }
                let mut selected = turn::resolve(shared, job, reference, timings)?;
                if request.select_only
                    && selected.decision.turn_offset_ms.abs() > millis(turn::ALIGNMENT)
                {
                    timings.selection_ms =
                        (millis(selection_start.elapsed()) - timings.wait_ms).max(0.);
                    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.diagnostics.turn_sync.unavailable += 1;
                    let selection = &mut state.diagnostics.selection;
                    selection.alignment_rejected += 1;
                    selection.last_rejection = Some(AlignmentRejection {
                        turn_id: request.turn_id.clone(),
                        source: selected.decision.source,
                        offset_ms: selected.decision.turn_offset_ms,
                        limit_ms: millis(turn::ALIGNMENT),
                    });
                    return Err(error("current_unavailable"));
                }
                let source = selected.source;
                let immediate = timings.wait_ms == 0.;
                let age = source.info().timestamp.elapsed();
                if age > HARD_AGE {
                    return Err(error("current_unavailable"));
                }
                generation = job.sources.generation();
                if !source.available() {
                    return Err(error("generation_changed"));
                }
                response.freshness = if age <= PREFERRED_AGE {
                    Freshness::Fresh
                } else {
                    Freshness::Stale
                };
                {
                    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    // Revoke the previous current source before allocating another.
                    state
                        .snapshots
                        .retain(|s| s.asset.info().role != Role::Current);
                    let m = state.diagnostics.metric(Kind::Current);
                    m.immediate += u64::from(immediate);
                    m.after_wait += u64::from(!immediate && age <= PREFERRED_AGE);
                    m.stale += u64::from(age > PREFERRED_AGE);
                    m.total_age_ms += millis(age);
                    m.maximum_age_ms = m.maximum_age_ms.max(millis(age));
                }
                let info = source.info();
                if !snapshot_room(shared, info.width as u64 * info.height as u64 * 4, &[]) {
                    return Err(error("current_unavailable"));
                }
                let asset = source.current_snapshot()?;
                drop(source);
                let id = register(shared, job, asset.clone(), generation)?;
                selected.decision.selected_at_unix_ms = unix(Instant::now());
                selected.decision.turn_to_selected_ms = millis(reference.elapsed());
                selected.decision.resolver_ms = millis(selection_start.elapsed());
                response.current_max_age_ms = Some(millis(if request.select_only {
                    TURN_DELIVERY_AGE
                } else {
                    HARD_AGE
                }));
                response.temporal_role = Some(turn_role(Some(&selected.decision)));
                {
                    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(snapshot) = state.snapshots.iter_mut().find(|s| s.id == id) {
                        snapshot.decision = Some(selected.decision.clone());
                        snapshot.boundary_reserved = request.select_only;
                    }
                    state.diagnostics.turn_sync.record(selected.decision);
                }
                selections.push((id, asset));
                if response.freshness == Freshness::Stale {
                    response
                        .warnings
                        .push("Current source is older than the preferred freshness threshold.");
                }
                if job.sources.compatibility() {
                    response.warnings.push("Explicit Legacy backend: compatibility capture used; recent history is unavailable.");
                }
            }
        }
        Kind::Detail => {
            generation = job.sources.generation();
            let id = request
                .snapshot_id
                .clone()
                .or_else(|| {
                    shared
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .snapshots
                        .iter()
                        .find(|s| s.asset.info().role == Role::Current)
                        .map(|s| s.id.clone())
                })
                .ok_or_else(|| error("snapshot_required"))?;
            let asset = resolve(shared, job, &id)?;
            response.freshness = if asset.info().role == Role::Current {
                Freshness::Stale
            } else {
                Freshness::Historical
            };
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let m = state.diagnostics.metric(Kind::Detail);
            m.roi += u64::from(request.region.is_some());
            m.full_frame += u64::from(request.region.is_none());
            selections.push((id, asset));
        }
        Kind::Recent => {
            generation = job.sources.generation();
            let start = reference
                .checked_sub(Duration::from_millis(request.lookback_ms))
                .unwrap_or(reference);
            let reserved = {
                let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.prune();
                state
                    .history
                    .as_ref()
                    .filter(|h| h.generation == generation && h.access == job.access)
                    .map(|h| h.value.clone())
            };
            let used_turn_reservation = reserved.is_some();
            let mut history = job.sources.history(start, reference)?;
            if let Some(reserved) = reserved {
                history.coverage_ms = history.coverage_ms.max(reserved.coverage_ms);
                for retained in reserved.events {
                    if retained.start > reference || retained.end.unwrap_or(retained.peak) < start {
                        continue;
                    }
                    if let Some(live) = history
                        .events
                        .iter_mut()
                        .find(|e| e.identity == retained.identity)
                    {
                        if retained.asset.as_ref().is_some_and(|a| a.available()) {
                            live.asset = retained.asset;
                        }
                    } else {
                        history.events.push(retained);
                    }
                }
            }
            response.actual_coverage_ms = history.coverage_ms.min(request.lookback_ms as f64);
            response.freshness = Freshness::Historical;
            if response.actual_coverage_ms + 100. < request.lookback_ms as f64 {
                response.completeness = Completeness::Partial;
                response
                    .warnings
                    .push("Available history covers less than the requested window.");
            }
            let considered = history.events.len();
            let keyframes = history.events.iter().filter(|e| e.asset.is_some()).count();
            recent_diagnostic = Some(RecentDiagnostic {
                turn_id: request.turn_id.clone(),
                reference_unix_ms: unix(reference),
                requested_unix_ms: unix(job.received),
                reference_age_ms: millis(job.received.saturating_duration_since(reference)),
                lookback_ms: request.lookback_ms,
                coverage_ms: response.actual_coverage_ms,
                source_generation: generation,
                used_turn_reservation,
                events_considered: considered,
                keyframes_considered: keyframes,
                ..Default::default()
            });
            // Priority is generic visual evidence, never an application/semantic label.
            history.events.sort_by(|a, b| {
                (a.rank, a.asset.is_none())
                    .cmp(&(b.rank, b.asset.is_none()))
                    .then_with(|| b.start.cmp(&a.start))
            });
            response.truncated = considered > request.max_events;
            history.events.truncate(request.max_events);
            let image_limit = request.max_keyframes.min(request.image_limit);
            let mut seen = Vec::new();
            let mut scenes = Vec::new();
            let mut selected = Vec::new();
            for e in &history.events {
                let Some(asset) = &e.asset else {
                    response.completeness = Completeness::Partial;
                    continue;
                };
                let info = asset.info();
                if !asset.available() || info.timestamp > reference || info.timestamp < start {
                    response.completeness = Completeness::Partial;
                    continue;
                }
                let identity = (info.role, info.cursor);
                if seen.contains(&identity)
                    || (info.role == Role::RecentStable && scenes.contains(&e.scene))
                {
                    continue;
                }
                if selected.len() >= image_limit {
                    response.truncated = true;
                    continue;
                }
                seen.push(identity);
                if info.role == Role::RecentStable {
                    scenes.push(e.scene);
                }
                let protected = selections
                    .iter()
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                if !snapshot_room(
                    shared,
                    info.width as u64 * info.height as u64 * 4,
                    &protected,
                ) {
                    response.completeness = Completeness::Partial;
                    response
                        .warnings
                        .push("A historical image exceeds the remaining snapshot budget.");
                    continue;
                }
                let snapshot = asset.snapshot()?;
                let id = register(shared, job, snapshot.clone(), generation)?;
                selected.push((e.identity, id.clone()));
                selections.push((id, snapshot));
            }
            history.events.sort_by_key(|e| e.start);
            for e in history.events {
                // The timeline can advance while a provider decides to query.
                // Describe each event as of turn completion, not that later query.
                let end = e.end.filter(|time| *time <= reference);
                response.events.push(Event {
                    description: e.description,
                    start_offset_ms: offset(e.start, reference),
                    peak_offset_ms: offset(e.peak.min(reference), reference),
                    end_offset_ms: end.map(|t| offset(t, reference)),
                    duration_ms: millis(
                        end.unwrap_or(reference).saturating_duration_since(e.start),
                    ),
                    confidence: e.confidence,
                    region: e.region,
                    active: end.is_none(),
                    snapshot_id: selected
                        .iter()
                        .find(|(identity, _)| *identity == e.identity)
                        .map(|(_, id)| id.clone()),
                });
            }
            selections.sort_by_key(|(_, a)| a.info().timestamp);
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let m = state.diagnostics.metric(Kind::Recent);
            m.events_considered += considered as u64;
            m.keyframes_considered += keyframes as u64;
        }
    }
    timings.selection_ms = (millis(selection_start.elapsed()) - timings.wait_ms).max(0.);
    if request.select_only {
        check(shared, job, Some(generation))?;
        response.timings = timings.clone();
        // Own the selected source only; no encoding or provider bytes. A quiet
        // desktop may require the one-shot native capture instead of a GPU copy.
        return Ok(response);
    }
    {
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.images + selections.len() > MAX_TURN_IMAGES {
            return Err(error("visual_limit_reached"));
        }
        state.images += selections.len();
        state.sequence += 1;
        response.request_id = format!("context_{}_{}", state.epoch, state.sequence);
    }
    for (id, asset) in selections {
        check(shared, job, Some(generation))?;
        match encode(shared, job, &id, asset, reference, timings) {
            Ok(frame) => response.frames.push(frame),
            Err(e)
                if request.kind == Kind::Recent
                    && matches!(
                        e.code,
                        "snapshot_expired"
                            | "readback_failed"
                            | "encoding_failed"
                            | "image_too_large"
                    ) =>
            {
                response.completeness = Completeness::Partial;
                response.warnings.push(
                    "A selected historical image is unavailable; event metadata remains valid.",
                );
                for event in &mut response.events {
                    if event.snapshot_id.as_deref() == Some(&id) {
                        event.snapshot_id = None;
                    }
                }
                let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.diagnostics.readback_failures += u64::from(e.code == "readback_failed");
                state.diagnostics.encoding_failures += u64::from(e.code == "encoding_failed");
            }
            Err(e) => return Err(e),
        }
    }
    check(shared, job, Some(generation))?;
    for frame in &response.frames {
        resolve(shared, job, &frame.snapshot_id)?;
    }
    if request.kind == Kind::Current {
        let age = response.frames.first().map_or(f64::INFINITY, |f| f.age_ms);
        if age > response.current_max_age_ms.unwrap_or(millis(HARD_AGE)) {
            return Err(error("current_unavailable"));
        }
        response.freshness = if age <= millis(PREFERRED_AGE) {
            Freshness::Fresh
        } else {
            Freshness::Stale
        };
    }
    let assembly = Instant::now();
    if response.truncated {
        response.completeness = Completeness::Partial;
    }
    if request.kind == Kind::Recent && response.frames.is_empty() {
        response
            .warnings
            .push("No high-quality historical image is available.");
        response.completeness = if response.events.is_empty() {
            Completeness::Empty
        } else {
            Completeness::Partial
        };
    }
    response.generated_at_unix_ms = unix(Instant::now());
    {
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prune();
        response.follow_up_reference = state.follow_up.as_ref().and_then(|r| {
            if !r.completed || r.origin_conversation == state.conversation || r.remaining_turns != 0
            {
                return None;
            }
            let snapshot = state
                .snapshots
                .iter()
                .find(|s| s.id == r.snapshot_id && state.accessible(s))?;
            Some(FollowUpContext {
                snapshot_id: r.snapshot_id.clone(),
                origin_turn_id: r.origin_turn_id.clone(),
                origin: snapshot.asset.info().role,
                expires_at_unix_ms: unix(r.expires),
            })
        });
    }
    if let Some(mut trace) = recent_diagnostic {
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        trace.events_selected = response.events.len();
        trace.encoded_images = response.frames.len();
        trace.encoded_bytes = response.frames.iter().map(|f| f.encoded_size_bytes).sum();
        trace.status = format!("{:?}", response.completeness);
        trace.snapshots = response
            .frames
            .iter()
            .filter_map(|f| {
                let snapshot = state.snapshots.iter().find(|s| s.id == f.snapshot_id)?;
                Some(HistoricalDiagnostic {
                    snapshot_id: f.snapshot_id.clone(),
                    role: f.role,
                    source_unix_ms: f.timestamp_unix_ms,
                    offset_ms: f.offset_ms,
                    source_width: f.original_width,
                    source_height: f.original_height,
                    width: f.width,
                    height: f.height,
                    created_unix_ms: unix(snapshot.expires - LIFETIME),
                    expires_unix_ms: unix(snapshot.expires),
                })
            })
            .collect();
        state.diagnostics.last_recent = Some(trace);
    }
    timings.assembly_ms = millis(assembly.elapsed());
    timings.total_ms = millis(job.received.elapsed());
    response.timings = timings.clone();
    Ok(response)
}
fn turn_role(decision: Option<&turn::Decision>) -> &'static str {
    match decision.map(|d| d.reason) {
        Some("TurnAlignedTransient") => "Temporary visual state present around the user's turn.",
        Some("TransitionWaitedForStable") => "Turn context after the visual transition settled.",
        Some("TurnAlignedPreTransition" | "StableLatestImmediate" | "StableCurrent") => {
            "Visual state aligned with the user's turn boundary."
        }
        _ => "Newest acceptable visual state; use the stated observation time and turn offset.",
    }
}
fn encode(
    shared: &Shared,
    job: &Job,
    id: &str,
    asset: Arc<dyn Asset>,
    reference: Instant,
    timings: &mut Timings,
) -> Result<Frame> {
    resolve(shared, job, id)?;
    let info = asset.info();
    let read_start = Instant::now();
    let pixels = asset.read()?;
    timings.readback_ms += millis(read_start.elapsed());
    check(shared, job, None)?;
    let crop_start = Instant::now();
    let region = if job.request.kind == Kind::Detail {
        job.request.region
    } else {
        None
    };
    let bounds = region
        .map(|r| r.pixels(info.width, info.height))
        .transpose()?;
    let rgba = match bounds {
        Some(r) if r.x != 0 || r.y != 0 || r.width != info.width || r.height != info.height => {
            Pixels(image::imageops::crop_imm(&pixels.0, r.x, r.y, r.width, r.height).to_image())
        }
        _ => pixels,
    };
    timings.crop_ms += millis(crop_start.elapsed());
    let encoding_start = Instant::now();
    use image::ImageEncoder;
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    let (width, height, mime) = if job.request.kind == Kind::Detail {
        let (w, h) = rgba.0.dimensions();
        image::codecs::png::PngEncoder::new(&mut *bytes)
            .write_image(rgba.0.as_raw(), w, h, image::ColorType::Rgba8)
            .map_err(|_| error("encoding_failed"))?;
        (w, h, "image/png")
    } else {
        let rgb = image::RgbImage::from_fn(rgba.0.width(), rgba.0.height(), |x, y| {
            let p = rgba.0.get_pixel(x, y);
            image::Rgb([p[0], p[1], p[2]])
        });
        let encoded =
            crate::visual_preparation::encode_overview(rgb, job.request.max_encoded_bytes, || {
                check(shared, job, None)
            })?;
        bytes = encoded.bytes;
        (encoded.width, encoded.height, "image/jpeg")
    };
    crate::visual_preparation::validate_size(bytes.len(), job.request.max_encoded_bytes)?;
    check(shared, job, None)?;
    resolve(shared, job, id)?;
    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&*bytes);
    timings.encoding_ms += millis(encoding_start.elapsed());
    Ok(Frame {
        snapshot_id: id.to_owned(),
        role: if job.request.kind == Kind::Detail {
            Role::Detail
        } else {
            info.role
        },
        origin: info.role,
        timestamp_unix_ms: unix(info.timestamp),
        age_ms: millis(info.timestamp.elapsed()),
        offset_ms: offset(info.timestamp, reference),
        original_width: info.width,
        original_height: info.height,
        width,
        height,
        source_region: region,
        correlation: info.correlation,
        correlation_delta_ms: info.delta_ms,
        mime_type: mime,
        encoded_size_bytes: bytes.len(),
        base64,
    })
}
