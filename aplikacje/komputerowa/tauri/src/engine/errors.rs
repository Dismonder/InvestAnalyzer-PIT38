use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopError {
    pub error_code: String,
    pub message: String,
    pub recoverable: bool,
}

impl DesktopError {
    pub fn new(
        error_code: impl Into<String>,
        message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            error_code: error_code.into(),
            message: message.into(),
            recoverable,
        }
    }

    pub fn io(error_code: &str, context: &str, error: std::io::Error) -> Self {
        Self::new(error_code, format!("{context}: {error}"), true)
    }
}

impl fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.error_code, self.message)
    }
}

impl std::error::Error for DesktopError {}

pub type DesktopResult<T> = Result<T, DesktopError>;
