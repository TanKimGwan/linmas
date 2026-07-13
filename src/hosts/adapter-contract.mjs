const REQUIRED_METHODS = ['detect', 'getInstallRoot', 'getManifestPath', 'validateTarget'];
const DETECTION_FIELDS = ['host', 'status', 'reason', 'rootPath', 'installRoot', 'manifestPath', 'writable'];
const ALLOWED_STATUSES = new Set(['detected', 'probably_detected', 'not_detected']);

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

  return adapter;
}
