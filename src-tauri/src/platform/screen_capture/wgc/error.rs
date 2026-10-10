use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: &'static str,
    pub hresult: Option<i32>,
}
impl CaptureError {
    pub fn new(code: &'static str) -> Self {
        Self { code, message: match code {
            "unsupported" => "Windows Graphics Capture requires Windows 10 1903 or later and a supported display.",
            "stopped" => "Screen capture is stopped.",
            "no_frame" => "No current GPU frame is available yet.",
            "busy" => "A capture operation is already pending.",
            "target_closed" => "The capture display was disconnected or closed.",
            "device_lost" => "The graphics device was lost. Stop and restart capture.",
            _ => "Windows capture failed. Stop capture and try again, or select Legacy.",
        }, hresult: None }
    }
    pub fn windows(code: &'static str, error: windows::core::Error) -> Self {
        Self {
            hresult: Some(error.code().0),
            ..Self::new(code)
        }
    }
}
pub type Result<T> = std::result::Result<T, CaptureError>;
pub trait CaptureResult<T> {
    fn capture(self, code: &'static str) -> Result<T>;
}
impl<T> CaptureResult<T> for windows::core::Result<T> {
    fn capture(self, code: &'static str) -> Result<T> {
        self.map_err(|e| CaptureError::windows(code, e))
    }
}
