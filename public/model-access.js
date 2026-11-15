// Match the same published model across catalog namespaces, without guessing
// that a different size, version, or variant is interchangeable.
export function canonicalModel(id) {
  return String(id || '').split('/').pop().toLowerCase()
    .replace(/:free$/, '').replace(/-free$/, '');
}

export function findFreeEngine(engines, modelId) {
  const wanted = canonicalModel(modelId);
  if (!wanted) return null;
  return engines.find(engine => engine.available && engine.id.startsWith('opencode-free') &&
    canonicalModel(engine.model || 'opencode/big-pickle') === wanted) || null;
}
