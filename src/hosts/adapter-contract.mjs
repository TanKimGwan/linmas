const REQUIRED_METHODS = ['detect', 'getInstallRoot', 'getManifestPath', 'validateTarget'];

export function assertHostAdapter(hostId, adapter) {
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`host adapter ${hostId} must implement ${method}`);
    }
  }
  return adapter;
}
