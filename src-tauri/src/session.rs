use crate::change_detection::AnalysisFrame;
use crate::error::AppError;

#[derive(Default)]
pub struct Session {
    pub observer: crate::observer::Observer,
    active: bool,
    generation: u64,
    capturing: bool,
    pending_request: bool,
    previous: Option<AnalysisFrame>,
    ai_visual_access: bool,
    visual_generation: u64,
}

impl Session {
    pub fn request_capture(&mut self, ai: bool) -> Result<(u64, Option<u64>), AppError> {
        if !self.active {
            return Err(AppError::new("session_idle", "Start a visual session."));
        }
        if ai && !self.ai_visual_access {
            return Err(AppError::new(
                "permission_denied",
                "Visual access disabled.",
            ));
        }
        if self.pending_request {
            return Err(AppError::new(
                "capture_busy",
                "A capture request is already pending.",
            ));
        }
        self.pending_request = true;
        Ok((self.generation, ai.then_some(self.visual_generation)))
    }
    pub fn finish_request(&mut self) {
        self.pending_request = false;
    }

    pub fn matches_generation(&self, g: u64) -> bool {
        self.active && self.generation == g
    }

    pub fn start(&mut self) {
        self.revoke_ai_visual();
        self.previous = None;
        self.generation = self.generation.wrapping_add(1);
        self.active = true;
        self.observer.reset(true);
    }

    pub fn stop(&mut self) {
        self.revoke_ai_visual();
        self.previous = None;
        self.active = false;
        self.observer.reset(false);
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn begin_capture(&mut self) -> Result<u64, AppError> {
        if !self.active {
            return Err(AppError::new(
                "session_idle",
                "Start a session before capturing.",
            ));
        }
        if self.capturing {
            return Err(AppError::new(
                "capture_busy",
                "A capture is already in progress.",
            ));
        }
        self.capturing = true;
        Ok(self.generation)
    }

    fn revoke_ai_visual(&mut self) {
        self.ai_visual_access = false;
        self.visual_generation = self.visual_generation.wrapping_add(1);
    }
    pub fn set_ai_visual_access(&mut self, enabled: bool) -> Result<(), AppError> {
        self.revoke_ai_visual();
        if enabled && !self.active {
            return Err(AppError::new(
                "visual_session_inactive",
                "Start the visual session before allowing AI visual requests.",
            ));
        }
        self.ai_visual_access = enabled;
        Ok(())
    }
    pub fn visual_access_valid(&self, generation: u64) -> bool {
        self.active && self.ai_visual_access && generation == self.visual_generation
    }
    pub fn visual_access_generation(&self) -> Result<u64, AppError> {
        if !self.active || !self.ai_visual_access {
            return Err(AppError::new(
                "permission_denied",
                "Screen Awareness is off.",
            ));
        }
        Ok(self.visual_generation)
    }

    pub fn previous_frame(&self) -> Option<AnalysisFrame> {
        self.previous.clone()
    }

    pub fn finish_capture(
        &mut self,
        generation: u64,
        current: Option<AnalysisFrame>,
    ) -> Result<(), AppError> {
        self.capturing = false;
        if !self.active || generation != self.generation {
            return Err(AppError::new(
                "capture_cancelled",
                "The session ended. Screenshot discarded.",
            ));
        }
        if let Some(current) = current {
            self.previous = Some(current);
        }
        Ok(())
    }
}
