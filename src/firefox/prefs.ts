// Firefox prefs adapter — typed wrappers around Services.prefs.
//
// Manifest entry: "Services.prefs" (Tier 0, rock-stable).
// Most-touched API in palefox today (~35 calls across get/set/observe).
// All wrappers swallow exceptions and return the default value, since
// pref access can throw if the branch doesn't exist or has wrong type.

// `Services.prefs` is typed via src/types/chrome.d.ts.

// =============================================================================
// INTERFACE
// =============================================================================

export function getBool(name: string, defaultValue = false): boolean {
  try { return Services.prefs.getBoolPref(name, defaultValue); }
  catch { return defaultValue; }
}

export function setBool(name: string, value: boolean): void {
  try { Services.prefs.setBoolPref(name, value); } catch {}
}

export function getInt(name: string, defaultValue = 0): number {
  try { return Services.prefs.getIntPref(name, defaultValue); }
  catch { return defaultValue; }
}

export function setInt(name: string, value: number): void {
  try { Services.prefs.setIntPref(name, value); } catch {}
}

export function getString(name: string, defaultValue = ""): string {
  try { return Services.prefs.getStringPref(name, defaultValue); }
  catch {
    try { return Services.prefs.getCharPref(name, defaultValue); }
    catch { return defaultValue; }
  }
}

export function setString(name: string, value: string): void {
  try { Services.prefs.setStringPref(name, value); } catch {}
}

/** Subscribe to changes on a pref branch. The handler fires whenever any
 *  pref under `name` (exact match for leaf, prefix for branch) changes;
 *  the changed pref's full name is passed as `data` (third argument).
 *  Returns an `unsubscribe()` disposer. Always unsubscribe in unload paths. */
export function observe(name: string, handler: (changedName: string) => void): () => void {
  const observer = {
    observe(_subject: unknown, _topic: string, data: string): void {
      try { handler(data); } catch (e) { console.error(`palefox prefs observer ${name}:`, e); }
    },
  };
  try { Services.prefs.addObserver(name, observer); } catch {}
  return () => {
    try { Services.prefs.removeObserver(name, observer); } catch {}
  };
}
