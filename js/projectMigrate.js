// Forward migration for the project payload (.bforge/.bumpmesh settings.json).
//
// The payload carries a `version`. As the format evolves, add one transform per
// version bump below so old files keep loading. Pure (no DOM) → testable headless.
// Today v1 is the first version, so there is nothing to transform yet; this exists
// so the NEXT format change has an obvious, tested home instead of ad-hoc patches.

/**
 * @param data            parsed settings.json object (may be legacy/unversioned)
 * @param currentVersion  the version this build writes/understands
 * @returns migrated object (a shallow copy; input is not mutated)
 */
export function migrateProjectPayload(data, currentVersion = 1) {
  if (!data || typeof data !== 'object') return data;

  const from = Number.isFinite(data.version) ? data.version : 0; // unversioned legacy → 0
  const out = { ...data };

  // Per-version transforms go here, smallest first. Example for the future:
  //   if (out.version < 2) { out.newField = deriveFrom(out); out.version = 2; }

  if (from > currentVersion) {
    // File written by a newer build: load best-effort, keep its fields untouched
    // and record the gap so the caller can warn the user.
    out.__futureVersion = from;
  } else {
    out.version = currentVersion;
  }

  return out;
}
