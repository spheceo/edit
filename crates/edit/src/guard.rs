//! Containing panics. A bug in one request or job must not take the server
//! down or leave the job "working" forever: a panic becomes an ordinary error
//! on the path that already handles failure.

use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;

/// What a panic said, and `catch`: the engine's (its crashes are logged
/// through `diag` like the server's own).
pub use edit_engine::util::{catch, crashed, message};

/// `catch` for a future.
pub async fn catch_async<T>(what: &str, work: impl Future<Output = T>) -> Result<T, String> {
    AssertUnwindSafe(work)
        .catch_unwind()
        .await
        .map_err(|payload| crashed(what, &*payload))
}

/// Answers a request whose handler panicked: a JSON error instead of a dropped connection.
pub fn panic_response(payload: Box<dyn Any + Send>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let error = crashed("this request", &*payload);
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({ "error": error })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panics_become_errors() {
        assert_eq!(catch("sum", || 1 + 1), Ok(2));
        let error = catch("job", || -> u8 { panic!("boom") }).unwrap_err();
        assert!(error.contains("job crashed (boom)"), "{error}");
        let error = catch("job", || -> u8 { panic!("{}", String::from("owned")) }).unwrap_err();
        assert!(error.contains("owned"), "{error}");
    }
}
