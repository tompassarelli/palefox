// Firefox observer-service adapter — typed wrappers around Services.obs.
//
// Manifest entry: "Services.obs" (Tier 0, rock-stable).
// Topic-based pubsub used for global lifecycle events (quit-application,
// profile-after-change, etc.).

// `Services.obs` is typed via src/types/chrome.d.ts.

// =============================================================================
// INTERFACE
// =============================================================================

/** Subscribe to a global topic (e.g. "quit-application", "sessionstore-windows-restored").
 *  Returns an `unsubscribe()` disposer. Always unsubscribe in unload paths,
 *  or rely on the chrome window's unload event to fire your teardown. */
export function on(
  topic: string,
  handler: (subject: unknown, data: string) => void,
): () => void {
  const observer = {
    observe(subject: unknown, _topic: string, data: string): void {
      try { handler(subject, data); } catch (e) { console.error(`palefox obs handler ${topic}:`, e); }
    },
  };
  try { Services.obs.addObserver(observer, topic); } catch {}
  return () => {
    try { Services.obs.removeObserver(observer, topic); } catch {}
  };
}

/** Notify all observers of a topic. Used to broadcast palefox-internal
 *  signals via the same primitive Firefox uses internally. */
export function notify(topic: string, subject: unknown = null, data?: string): void {
  try { Services.obs.notifyObservers(subject, topic, data); } catch (e) {
    console.error(`palefox obs notify ${topic}:`, e);
  }
}
