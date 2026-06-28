// Crash-recovery decision logic (pure — no DOM, no IndexedDB).
//
// The app periodically writes a full project draft to IndexedDB (durable, unlike
// the sessionStorage settings-only auto-save). On the next launch we offer to
// restore it. Keeping the "should we offer it / how old is it" logic pure makes
// it testable headless; the IDB and banner wiring stay in main.js / idbStore.js.

/** A draft is offerable when it actually carries project bytes and a timestamp. */
export function shouldOfferRecovery(draft) {
  return !!(draft && draft.bytes && draft.bytes.length > 0 && Number.isFinite(draft.savedAt));
}

/** Age of a draft in whole seconds (clamped ≥ 0). */
export function recoveryAgeSeconds(savedAt, now = Date.now()) {
  return Math.max(0, Math.round((now - savedAt) / 1000));
}

/**
 * Coarse age bucket for the recovery banner, locale-formatted by the caller.
 * @returns {{ unit: 'sec'|'min'|'hour'|'day', value: number }}
 */
export function recoveryAgeParts(savedAt, now = Date.now()) {
  const s = recoveryAgeSeconds(savedAt, now);
  if (s < 60)        return { unit: 'sec',  value: s };
  const m = Math.round(s / 60);
  if (m < 60)        return { unit: 'min',  value: m };
  const h = Math.round(m / 60);
  if (h < 24)        return { unit: 'hour', value: h };
  return { unit: 'day', value: Math.round(h / 24) };
}
