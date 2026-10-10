use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: &'static str,
}

impl AppError {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub fn technical(
        code: &'static str,
        message: &'static str,
        detail: impl std::fmt::Display,
    ) -> Self {
        eprintln!("{code}: {detail}");
        Self::new(code, message)
    }
}
