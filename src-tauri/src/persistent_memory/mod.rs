//! Opt-in local episodic memory. No dependency on the capture/perception stream.
//! All encoding, asset I/O and SQLite work lives on one bounded worker thread.
mod assets;
pub mod model;
mod repository;
use assets::prepare;
pub use model::*;
use repository::{PersistentMemoryRepository, SqliteMemoryRepository};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const QUEUE_CAPACITY: usize = 4;
const CANDIDATE_CAPACITY: usize = 2;
const CANDIDATE_TTL: Duration = Duration::from_secs(10);
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
struct Gate {
    generation: u64,
    configuration: u64,
    in_flight: usize,
    clearing: bool,
    shutting_down: bool,
    status: MemoryStatus,
}
type Shared = Arc<Mutex<Gate>>;
type Job = Box<dyn FnOnce(&mut Worker) + Send>;

/// Reserve BEFORE acquiring any screen pixels. Reservations cap concurrent
/// capture + queued + encoding candidates together, not just channel entries.
pub struct CandidateTicket {
    shared: Shared,
    generation: u64,
    started: Instant,
    storage_mode: StorageMode,
    automatic: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutomaticGateSnapshot {
    pub generation: u64,
    pub enabled: bool,
}
impl CandidateTicket {
    pub fn storage_mode(&self) -> StorageMode {
        self.storage_mode
    }
}
impl Drop for CandidateTicket {
    fn drop(&mut self) {
        if let Ok(mut gate) = self.shared.lock() {
            gate.in_flight = gate.in_flight.saturating_sub(1);
        }
    }
}

pub struct MemoryPersistencePolicy;
impl MemoryPersistencePolicy {
    fn allow(gate: &Gate) -> Result<()> {
        if gate.shutting_down || gate.clearing {
            return Err(MemoryError::new("MEMORY_CANCELLED"));
        }
        if gate.status.health != "ready" {
            return Err(MemoryError::new("MEMORY_UNAVAILABLE"));
        }
        if gate.status.settings.mode == MemoryMode::Off {
            return Err(MemoryError::new("MEMORY_DISABLED"));
        }
        if gate.status.settings.paused {
            return Err(MemoryError::new("MEMORY_PAUSED"));
        }
        if !gate.status.screen_awareness {
            return Err(MemoryError::new("MEMORY_SCREEN_AWARENESS_OFF"));
        }
        Ok(())
    }
}
pub struct MemoryService {
    sender: SyncSender<Job>,
    shared: Shared,
    completion: Mutex<mpsc::Receiver<()>>,
    stopped: Arc<AtomicBool>,
}
impl MemoryService {
    pub fn new(root: PathBuf) -> Self {
        let shared = Arc::new(Mutex::new(Gate {
            generation: 0,
            configuration: 0,
            in_flight: 0,
            clearing: false,
            shutting_down: false,
            status: MemoryStatus {
                settings: MemorySettings::default(),
                health: "starting".into(),
                error_code: None,
                saved_count: 0,
                storage_bytes: 0,
                queue_depth: 0,
                screen_awareness: false,
                encrypted: false,
                semantic_search: false,
                schema_version: 1,
                writes: 0,
                rejected: 0,
                candidates: 0,
                deduplicated: 0,
                queue_max_depth: 0,
                db_bytes: 0,
                assets_bytes: 0,
                thumbnails_bytes: 0,
                encode_p50_ms: 0.0,
                encode_p95_ms: 0.0,
                write_p50_ms: 0.0,
                write_p95_ms: 0.0,
                transaction_p50_ms: 0.0,
                transaction_p95_ms: 0.0,
            },
        }));
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
        let (finished, completion) = mpsc::channel();
        let state = shared.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let spawn = thread::Builder::new()
            .name("persistent-memory".into())
            .spawn(move || {
                let mut worker = Worker {
                    root,
                    repository: None,
                    shared: state.clone(),
                    semantic: Box::new(NoSemanticIndex),
                    stopped: worker_stopped.clone(),
                    timings: std::collections::VecDeque::with_capacity(128),
                };
                let initial = if worker.root.join("memory.sqlite3").exists() {
                    worker.open().and_then(|repo| repo.settings())
                } else {
                    Ok(MemorySettings::default())
                };
                if let Ok(mut gate) = state.lock() {
                    match initial {
                        Ok(settings) => {
                            gate.status.settings = settings;
                            gate.status.health = "ready".into();
                        }
                        Err(error) => {
                            gate.status.health = "unavailable".into();
                            gate.status.error_code = Some(error.code.into());
                        }
                    }
                }
                worker.refresh();
                let mut maintenance_at = Instant::now() + Duration::from_secs(30);
                loop {
                    if worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    if Instant::now() >= maintenance_at {
                        if worker.repository.is_some() {
                            let settings = state
                                .lock()
                                .map(|g| g.status.settings.clone())
                                .unwrap_or_default();
                            let result = worker
                                .repository
                                .as_mut()
                                .unwrap()
                                .maintenance(now_ms(), &settings);
                            if result.is_ok() {
                                let _ = worker.recover_storage_health();
                            }
                            worker.note(result.as_ref().err());
                            worker.refresh();
                        }
                        maintenance_at = Instant::now() + Duration::from_secs(30);
                    }
                    match receiver
                        .recv_timeout(maintenance_at.saturating_duration_since(Instant::now()))
                    {
                        Ok(job) => {
                            if let Ok(mut gate) = state.lock() {
                                gate.status.queue_depth = gate.status.queue_depth.saturating_sub(1);
                            }
                            job(&mut worker);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                drop(worker);
                let _ = finished.send(());
            });
        if spawn.is_err() {
            if let Ok(mut gate) = shared.lock() {
                gate.status.health = "unavailable".into();
                gate.status.error_code = Some("MEMORY_UNAVAILABLE".into());
            }
        }
        Self {
            sender,
            shared,
            completion: Mutex::new(completion),
            stopped,
        }
    }
    pub fn status(&self) -> MemoryStatus {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .clone()
    }
    fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Worker) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(MemoryError::new("MEMORY_UNAVAILABLE"));
        }
        let (reply, receive) = mpsc::sync_channel(1);
        let job: Job = Box::new(move |worker| {
            let result = operation(worker);
            worker.note(result.as_ref().err());
            worker.refresh();
            let _ = reply.send(result);
        });
        {
            let mut gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            if gate.shutting_down {
                return Err(MemoryError::new("MEMORY_UNAVAILABLE"));
            }
            gate.status.queue_depth += 1;
            gate.status.queue_max_depth = gate
                .status
                .queue_max_depth
                .max(gate.status.queue_depth.min(QUEUE_CAPACITY));
        }
        if let Err(error) = self.sender.try_send(job) {
            // Drop rejected captures before reacquiring their reservation mutex.
            drop(error);
            if let Ok(mut gate) = self.shared.lock() {
                gate.status.queue_depth = gate.status.queue_depth.saturating_sub(1);
                gate.status.rejected += 1;
            }
            return Err(MemoryError::new("MEMORY_QUEUE_FULL"));
        }
        receive
            .recv_timeout(REPLY_TIMEOUT)
            .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
    }
    pub fn configure(&self, settings: MemorySettings) -> Result<MemoryStatus> {
        settings.validate()?;
        let configuration = {
            let mut gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            gate.generation = gate.generation.wrapping_add(1);
            gate.configuration = gate.configuration.wrapping_add(1);
            // Tighten gates immediately, before the storage operation is queued.
            if settings.mode == MemoryMode::Off {
                gate.status.settings.mode = MemoryMode::Off;
            }
            gate.status.settings.paused |= settings.paused;
            if !settings.automatic_memory_enabled {
                gate.status.settings.automatic_memory_enabled = false;
            }
            gate.configuration
        };
        self.call(move |worker| {
            if worker
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
                .configuration
                != configuration
            {
                return Err(MemoryError::new("MEMORY_CANCELLED"));
            }
            worker.open()?.configure(&settings)?;
            let cleanup = worker.open()?.cleanup(now_ms(), &settings, 0);
            cleanup?;
            if let Ok(mut gate) = worker.shared.lock() {
                if gate.configuration == configuration {
                    // Tickets reserved while the durable settings update was
                    // pending still carry the old storage profile. Revoke them
                    // before publishing the new profile (especially visual to
                    // metadata-only), even though configure already fenced
                    // tickets that predated the request.
                    gate.generation = gate.generation.wrapping_add(1);
                    gate.status.settings = settings;
                    gate.status.health = "ready".into();
                    gate.status.error_code = None;
                }
            }
            Ok(())
        })?;
        Ok(self.status())
    }
    pub fn set_screen_awareness(&self, enabled: bool) {
        if let Ok(mut gate) = self.shared.lock() {
            gate.generation = gate.generation.wrapping_add(1);
            gate.status.screen_awareness = enabled;
        }
    }
    pub fn try_begin_candidate(&self) -> Result<CandidateTicket> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(MemoryError::new("MEMORY_UNAVAILABLE"));
        }
        let mut gate = self
            .shared
            .lock()
            .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
        MemoryPersistencePolicy::allow(&gate)?;
        if gate.in_flight >= CANDIDATE_CAPACITY {
            gate.status.rejected += 1;
            return Err(MemoryError::new("MEMORY_QUEUE_FULL"));
        }
        gate.in_flight += 1;
        gate.status.candidates += 1;
        Ok(CandidateTicket {
            shared: self.shared.clone(),
            generation: gate.generation,
            started: Instant::now(),
            storage_mode: gate.status.settings.storage_mode,
            automatic: false,
        })
    }
    /// Called by a low-frequency coordinator, never waits for database commits.
    /// A missing snapshot means contention; it must not be interpreted as consent.
    pub fn automatic_gate(&self) -> Option<AutomaticGateSnapshot> {
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        let gate = self.shared.try_lock().ok()?;
        Some(AutomaticGateSnapshot {
            generation: gate.generation,
            enabled: gate.status.settings.automatic_memory_enabled
                && MemoryPersistencePolicy::allow(&gate).is_ok(),
        })
    }
    /// The coordinator supplies the generation whose observation cutoff it
    /// validated. One automatic reservation leaves a second slot for manual save.
    pub fn try_begin_automatic(&self, expected_generation: u64) -> Result<CandidateTicket> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(MemoryError::new("MEMORY_UNAVAILABLE"));
        }
        let mut gate = self
            .shared
            .try_lock()
            .map_err(|_| MemoryError::new("MEMORY_BUSY"))?;
        MemoryPersistencePolicy::allow(&gate)?;
        if gate.generation != expected_generation {
            return Err(MemoryError::new("MEMORY_CANCELLED"));
        }
        if !gate.status.settings.automatic_memory_enabled {
            return Err(MemoryError::new("MEMORY_AUTOMATIC_DISABLED"));
        }
        if gate.in_flight >= 1 {
            gate.status.rejected += 1;
            return Err(MemoryError::new("MEMORY_QUEUE_FULL"));
        }
        gate.in_flight += 1;
        gate.status.candidates += 1;
        Ok(CandidateTicket {
            shared: self.shared.clone(),
            generation: gate.generation,
            started: Instant::now(),
            storage_mode: gate.status.settings.storage_mode,
            automatic: true,
        })
    }
    pub fn save(
        &self,
        ticket: CandidateTicket,
        candidate: MemoryCandidate,
    ) -> Result<MemoryRecord> {
        if !Arc::ptr_eq(&ticket.shared, &self.shared) {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        if ticket.automatic != (candidate.origin != CandidateOrigin::Explicit) {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        if candidate.label.len() > 2000
            || candidate.session_id.len() > 128
            || candidate.session_id.is_empty()
            || candidate.observed_at <= 0
            || candidate.observed_at > now_ms() + 60_000
        {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        if candidate
            .image
            .as_ref()
            .is_some_and(|i| u64::from(i.width()) * u64::from(i.height()) > assets::MAX_PIXELS)
        {
            return Err(MemoryError::new("MEMORY_IMAGE_TOO_LARGE"));
        }
        self.call(move |worker| worker.save(ticket, candidate))
    }
    pub fn search(&self, query: MemoryQuery) -> Result<MemoryPage> {
        query.validate()?;
        self.call(move |worker| worker.open()?.search(&query))
    }
    pub fn get(&self, id: String) -> Result<MemoryRecord> {
        validate_id(&id)?;
        self.call(move |w| w.open()?.get(&id))
    }
    pub fn bookmark(&self, id: String, bookmarked: bool) -> Result<MemoryRecord> {
        validate_id(&id)?;
        self.call(move |w| w.open()?.bookmark(&id, bookmarked))
    }
    pub fn asset(&self, id: String, thumbnail: bool) -> Result<Vec<u8>> {
        validate_id(&id)?;
        self.call(move |w| w.open()?.asset(&id, thumbnail))
    }
    fn invalidate(&self) {
        if let Ok(mut gate) = self.shared.lock() {
            gate.generation = gate.generation.wrapping_add(1);
        }
    }
    pub fn delete(&self, id: String) -> Result<()> {
        validate_id(&id)?;
        self.invalidate();
        self.call(move |w| {
            w.open()?.delete(&id)?;
            w.semantic.remove(&id)?;
            w.recover_storage_health()
        })
    }
    pub fn delete_range(&self, from: i64, to: i64) -> Result<u64> {
        if from > to {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        self.invalidate();
        self.call(move |w| {
            let count = w.open()?.delete_range(from, to)?;
            w.recover_storage_health()?;
            Ok(count)
        })
    }
    pub fn clear(&self, confirmed: bool) -> Result<()> {
        if !confirmed {
            return Err(MemoryError::new("MEMORY_CONFIRMATION_REQUIRED"));
        }
        {
            let mut gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            gate.generation = gate.generation.wrapping_add(1);
            gate.clearing = true;
        }
        let result = self.call(move |w| {
            w.open()?.clear()?;
            w.semantic.clear()?;
            w.recover_storage_health()
        });
        if let Ok(mut gate) = self.shared.lock() {
            gate.clearing = false;
        }
        result
    }
    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut gate) = self.shared.try_lock() {
            gate.generation = gate.generation.wrapping_add(1);
            gate.shutting_down = true;
        }
        let _ = self.sender.try_send(Box::new(|_| {}));
        if let Ok(receiver) = self.completion.lock() {
            let _ = receiver.recv_timeout(Duration::from_millis(500));
        }
    }
}
impl Drop for MemoryService {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Worker {
    root: PathBuf,
    repository: Option<SqliteMemoryRepository>,
    shared: Shared,
    semantic: Box<dyn MemorySemanticIndex>,
    stopped: Arc<AtomicBool>,
    timings: std::collections::VecDeque<[f64; 3]>,
}
impl Worker {
    fn recover_storage_health(&mut self) -> Result<()> {
        let (recoverable, budget) = {
            let gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            (
                matches!(
                    gate.status.error_code.as_deref(),
                    Some("MEMORY_STORAGE_FULL" | "MEMORY_DISK_FULL")
                ),
                u64::from(gate.status.settings.storage_limit_mb) * 1024 * 1024,
            )
        };
        if recoverable && self.open()?.storage_bytes()? <= budget {
            let mut gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            // Recover availability only; user mode, pause and Screen Awareness
            // remain authoritative and are never enabled as a repair side effect.
            gate.status.health = "ready".into();
            gate.status.error_code = None;
        }
        Ok(())
    }
    fn open(&mut self) -> Result<&mut SqliteMemoryRepository> {
        if self.repository.is_none() {
            self.repository = Some(SqliteMemoryRepository::open(&self.root)?);
        }
        self.repository
            .as_mut()
            .ok_or_else(|| MemoryError::new("MEMORY_UNAVAILABLE"))
    }
    fn note(&mut self, error: Option<&MemoryError>) {
        if let Some(error) = error {
            if let Ok(mut gate) = self.shared.lock() {
                gate.status.error_code = Some(error.code.into());
                if matches!(
                    error.code,
                    "MEMORY_DATABASE_UNAVAILABLE"
                        | "MEMORY_DISK_FULL"
                        | "MEMORY_PERMISSION_DENIED"
                        | "MEMORY_MIGRATION_FAILED"
                        | "MEMORY_SCHEMA_TOO_NEW"
                        | "MEMORY_STORAGE_FULL"
                        | "MEMORY_WRITE_FAILED"
                ) {
                    gate.status.health = "unavailable".into();
                    gate.generation = gate.generation.wrapping_add(1);
                }
            }
        }
    }
    fn refresh(&self) {
        if let Some(repo) = self.repository.as_ref() {
            let count = repo.count();
            let bytes = repo.storage_bytes();
            let breakdown = repo.storage_breakdown();
            if let Ok(mut gate) = self.shared.lock() {
                if let Ok(count) = count {
                    gate.status.saved_count = count;
                }
                if let Ok(bytes) = bytes {
                    gate.status.storage_bytes = bytes;
                }
                if let Ok((db, assets, thumbnails)) = breakdown {
                    gate.status.db_bytes = db;
                    gate.status.assets_bytes = assets;
                    gate.status.thumbnails_bytes = thumbnails;
                }
                gate.status.semantic_search = self.semantic.available();
            }
        }
    }
    fn save(
        &mut self,
        ticket: CandidateTicket,
        candidate: MemoryCandidate,
    ) -> Result<MemoryRecord> {
        {
            let gate = self
                .shared
                .lock()
                .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
            MemoryPersistencePolicy::allow(&gate)?;
            if ticket.generation != gate.generation || ticket.started.elapsed() > CANDIDATE_TTL {
                return Err(MemoryError::new("MEMORY_CANCELLED"));
            }
        }
        // Source pixels are consumed here, then released before filesystem work.
        let encoding = Instant::now();
        let prepared = prepare(candidate.image, ticket.storage_mode)?;
        let encode_ms = encoding.elapsed().as_secs_f64() * 1000.0;
        self.open()?;
        let state = self.shared.clone();
        let mut gate = state
            .lock()
            .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(MemoryError::new("MEMORY_CANCELLED"));
        }
        MemoryPersistencePolicy::allow(&gate)?;
        if ticket.generation != gate.generation || ticket.started.elapsed() > CANDIDATE_TTL {
            return Err(MemoryError::new("MEMORY_CANCELLED"));
        }
        let settings = gate.status.settings.clone();
        let record = MemoryRecord {
            id: uuid::Uuid::new_v4().to_string(),
            observed_at: candidate.observed_at,
            persisted_at: now_ms(),
            session_id: candidate.session_id,
            event_kind: candidate.origin.event_kind().into(),
            summary: candidate.label,
            summary_source: candidate.origin.summary_source().into(),
            source_application: None,
            window_title: None,
            save_reason: candidate.origin.save_reason().into(),
            bookmarked: false,
            has_visual: prepared.visual.is_some(),
            has_thumbnail: prepared.thumbnail.is_some(),
            width: prepared.width,
            height: prepared.height,
            expires_at: Some(
                candidate
                    .observed_at
                    .saturating_add(i64::from(settings.retention_days) * 86_400_000),
            ),
        };
        let extra = [prepared.visual.as_ref(), prepared.thumbnail.as_ref()]
            .into_iter()
            .flatten()
            .map(|a| a.bytes.len() as u64)
            .sum::<u64>()
            + 128 * 1024;
        let repo = self.repository.as_mut().unwrap();
        if let Some(duplicate) = repo.duplicate(
            &record,
            prepared.visual.as_ref(),
            prepared.thumbnail.as_ref(),
        )? {
            gate.status.deduplicated += 1;
            drop(gate);
            return Ok(duplicate);
        }
        repo.cleanup(now_ms(), &settings, extra)?;
        let writing = Instant::now();
        let selected: Vec<_> = [prepared.visual.as_ref(), prepared.thumbnail.as_ref()]
            .into_iter()
            .flatten()
            .collect();
        for asset in &selected {
            if let Err(error) = repo.assets.write(asset) {
                let _ = repo.discard_unreferenced(&selected);
                return Err(error);
            }
        }
        let write_ms = writing.elapsed().as_secs_f64() * 1000.0;
        if self.stopped.load(Ordering::Acquire) {
            let _ = repo.discard_unreferenced(&selected);
            return Err(MemoryError::new("MEMORY_CANCELLED"));
        }
        let transaction = Instant::now();
        let insertion = repo.insert(
            &record,
            prepared.visual.as_ref(),
            prepared.thumbnail.as_ref(),
        );
        if insertion.is_err() {
            let _ = repo.discard_unreferenced(&selected);
        }
        insertion?;
        let transaction_ms = transaction.elapsed().as_secs_f64() * 1000.0;
        if self.timings.len() == 128 {
            self.timings.pop_front();
        }
        self.timings
            .push_back([encode_ms, write_ms, transaction_ms]);
        let percentile = |column: usize, fraction: f64| {
            let mut samples: Vec<_> = self.timings.iter().map(|r| r[column]).collect();
            samples.sort_by(f64::total_cmp);
            samples[((samples.len() - 1) as f64 * fraction).round() as usize]
        };
        gate.status.encode_p50_ms = percentile(0, 0.5);
        gate.status.encode_p95_ms = percentile(0, 0.95);
        gate.status.write_p50_ms = percentile(1, 0.5);
        gate.status.write_p95_ms = percentile(1, 0.95);
        gate.status.transaction_p50_ms = percentile(2, 0.5);
        gate.status.transaction_p95_ms = percentile(2, 0.95);
        gate.status.writes += 1;
        gate.status.error_code = None;
        // Explicit unlock before CandidateTicket::drop reacquires reservation gate.
        drop(gate);
        Ok(record)
    }
}
