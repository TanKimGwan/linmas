export const EXIT_CODES = Object.freeze({ OK: 0, INPUT: 2, PROVIDER: 3, CONTRACT: 4 });

export class ReviewError extends Error {
  constructor(message, category, exitCode, metadata = {}) {
    super(message);
    this.name = 'ReviewError';
    this.category = category;
    this.failureClass = category;
    this.exitCode = exitCode;
    this.stage = metadata.stage ?? null;
    this.reasonCode = metadata.reasonCode ?? null;
    this.retryable = metadata.retryable ?? null;
    this.provider = metadata.provider ?? null;
    this.transmissionState = metadata.transmissionState ?? null;
  }
}
