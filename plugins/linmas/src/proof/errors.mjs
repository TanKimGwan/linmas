import { EXIT_CODES, ReviewError } from '../review/errors.mjs';

export class ProofError extends ReviewError {
  constructor(message, category = 'proof', exitCode = EXIT_CODES.CONTRACT) {
    super(message, category, exitCode);
    this.name = 'ProofError';
  }
}
