// How routes answer failures (server.rs ApiError): `{"error": "<why>"}` with
// a status. A route throws ApiError (or returns `apiError(...)`); the server
// turns it into the response. Some refusals were plain text in Rust (the host
// check, axum's own body rejections), and stay plain text.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Answer with the message as plain text instead of `{"error": …}`. */
    readonly plain = false,
  ) {
    super(message);
  }

  response(): Response {
    if (this.plain) return text(this.message, this.status);
    return Response.json({ error: this.message }, { status: this.status });
  }
}

/** 400 with the reason. */
export function bad(message: string): ApiError {
  return new ApiError(400, message);
}

/** 404 with the reason. */
export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

/** JSON (serde's field order is the object's). */
export function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(value, { status, headers });
}

/** Plain text, as axum answers a `&str` / `String`. */
export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** A status with no body (axum's `StatusCode::X.into_response()`). */
export function empty(status: number): Response {
  return new Response(null, { status });
}
