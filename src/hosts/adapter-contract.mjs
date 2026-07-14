import path from 'node:path';

const REQUIRED_METHODS = ['detect', 'getInstallRoot', 'getManifestPath', 'validateTarget'];
const DETECTION_FIELDS = ['host', 'status', 'reason', 'rootPath', 'installRoot', 'manifestPath', 'writable'];
const ALLOWED_STATUSES = new Set(['detected', 'probably_detected', 'not_detected']);
const SECRET_LIKE_KEY = /token|secret|credential|apiKey/i;

export function assertHostAdapter(hostId, adapter) {
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`host adapter ${hostId} must implement ${method}`);
    }
  }

  const detection = adapter.detect({ env: { PATH: '' }, platform: process.platform });
  for (const field of DETECTION_FIELDS) {
    if (!Object.hasOwn(detection ?? {}, field)) {
      throw new TypeError(`host adapter ${hostId} detection must include ${field}`);
    }
  }
  if (detection.host !== hostId) {
    throw new TypeError(`host adapter ${hostId} detection has invalid host`);
  }
  if (!ALLOWED_STATUSES.has(detection.status)) {
    throw new TypeError(`host adapter ${hostId} detection has invalid status`);
  }

  const relative = path.relative(detection.installRoot, detection.manifestPath);
  if (!relative.startsWith('..')) {
    throw new TypeError(`host adapter ${hostId}: manifestPath must be outside installRoot`);
  }

  const secretKeys = Object.keys(detection).filter((key) => SECRET_LIKE_KEY.test(key));
  if (secretKeys.length > 0) {
    throw new TypeError(`host adapter ${hostId}: detection must not include secret-like keys: ${secretKeys.join(', ')}`);
  }

  return adapter;
}
