/**
 * Domain errors of the feature contract.
 *
 * The OpenClaw feature transport only turns its own schema-validation failures
 * into structured results (`{ ok: false, code: "INVALID_INPUT" | "INVALID_OUTPUT" }`);
 * any error thrown by a handler reaches the caller as a generic failure carrying
 * only the message. To keep domain errors machine-readable anyway, every message
 * produced here starts with a stable prefix: `[lazy-loading:<CODE>] <text>`.
 * Clients recover the code with `parseErrorCode(message)`.
 */

export const ERROR_CODES = [
  /** The operation is declared in the contract but its backend is not built yet. */
  "NOT_IMPLEMENTED",
  /** The persisted plugin config does not pass validation; fix it before changing it. */
  "CONFIG_INVALID",
  /** Writing the plugin config through the host failed. */
  "CONFIG_WRITE_FAILED",
  /** Input is well-formed but does not make sense (unknown tool, conflicting arguments). */
  "INVALID_ARGUMENT",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const PREFIX = "lazy-loading";
const PATTERN = /^\[lazy-loading:([A-Z_]+)\]\s*/u;

export class LazyLoadingError extends Error {
  readonly code: ErrorCode;
  /** Planned task id (PLAN.md) for `NOT_IMPLEMENTED`, for example `F-09`. */
  readonly task?: string;

  constructor(code: ErrorCode, message: string, options?: { task?: string; cause?: unknown }) {
    super(`[${PREFIX}:${code}] ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LazyLoadingError";
    this.code = code;
    if (options?.task) this.task = options.task;
  }
}

/** Standard error for contract operations whose implementation is scheduled for a later task. */
export function notImplemented(operation: string, task: string): LazyLoadingError {
  return new LazyLoadingError("NOT_IMPLEMENTED", `${operation} is not implemented yet (planned: ${task})`, { task });
}

/** Extract the error code from a message produced by `LazyLoadingError`, if any. */
export function parseErrorCode(message: string): ErrorCode | undefined {
  const match = PATTERN.exec(message);
  const code = match?.[1];
  return (ERROR_CODES as readonly string[]).includes(code ?? "") ? (code as ErrorCode) : undefined;
}
