import fs from 'node:fs/promises';
import path from 'node:path';
import { EXIT_CODES, ReviewError } from './errors.mjs';

export async function loadReviewInput({ inputPath = null, useStdin = false, stdin, cwd = process.cwd(), maxBytes = 65536 } = {}) {
  if (Boolean(inputPath) === Boolean(useStdin)) {
    throw new ReviewError('provide exactly one of --input or --stdin', 'input', EXIT_CODES.INPUT);
  }

  let buffer;
  let source;
  if (inputPath) {
    const resolved = path.resolve(cwd, inputPath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      throw new ReviewError(`unable to read input: ${error.message}`, 'input', EXIT_CODES.INPUT);
    }
    if (!stat.isFile()) throw new ReviewError('input must be a regular file', 'input', EXIT_CODES.INPUT);
    if (stat.size > maxBytes) throw new ReviewError(`input exceeds ${maxBytes} bytes`, 'input', EXIT_CODES.INPUT);
    try {
      buffer = await fs.readFile(resolved);
    } catch (error) {
      throw new ReviewError(`unable to read input: ${error.message}`, 'input', EXIT_CODES.INPUT);
    }
    source = inputPath;
  } else {
    if (!stdin || typeof stdin[Symbol.asyncIterator] !== 'function') {
      throw new ReviewError('stdin is unavailable', 'input', EXIT_CODES.INPUT);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
      const value = Buffer.from(chunk);
      size += value.length;
      if (size > maxBytes) throw new ReviewError(`input exceeds ${maxBytes} bytes`, 'input', EXIT_CODES.INPUT);
      chunks.push(value);
    }
    buffer = Buffer.concat(chunks);
    source = 'stdin';
  }

  if (buffer.includes(0)) throw new ReviewError('binary input is not supported', 'input', EXIT_CODES.INPUT);
  return { source, content: buffer.toString('utf8'), bytes: buffer.length };
}
