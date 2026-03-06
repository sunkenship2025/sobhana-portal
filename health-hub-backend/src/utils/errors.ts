/**
 * Custom Error Classes
 *
 * All HTTP error responses in this app flow through these subclasses of Error.
 * Route handlers catch these and map them to HTTP status codes:
 *
 * @example
 *   try {
 *     const patient = await patientService.getById(id);
 *   } catch (err) {
 *     if (err instanceof NotFoundError) return res.status(err.statusCode).json({ error: err.error, message: err.message });
 *     throw err; // re-throw unexpected errors
 *   }
 *
 * In `index.ts`, a global error handler catches any `AppError` instance
 * and sends the correct HTTP response automatically.
 */

/**
 * Base class for all application errors.
 * Carries an HTTP status code and a machine-readable error code.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Input validation failed (HTTP 400) */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

/** Authentication required or JWT invalid (HTTP 401) */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

/** Authenticated but not permitted for this resource/action (HTTP 403) */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

/** Resource does not exist (HTTP 404) */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

/** Resource already exists or optimistic concurrency conflict (HTTP 409) */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

/** Unexpected server-side error (HTTP 500) */
export class InternalError extends AppError {
  constructor(message: string = 'Internal server error') {
    super(500, 'INTERNAL_ERROR', message);
  }
}
