// Firefox files adapter — typed wrappers around IOUtils + PathUtils.
//
// Manifest entry: "IOUtils + PathUtils" (Tier 0, rock-stable).
// All paths are profile-relative by default. Absolute paths are accepted
// but discouraged (palefox shouldn't write outside its own profile).

// `Services.dirsvc`, `Ci.nsIFile`, `IOUtils`, `PathUtils` are typed via
// src/types/chrome.d.ts.

// =============================================================================
// INTERFACE
// =============================================================================

/** Absolute path to the active Firefox profile directory. */
export function profileDir(): string {
  return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
}

/** Build an absolute path inside the profile directory. */
export function profilePath(...parts: string[]): string {
  return PathUtils.join(profileDir(), ...parts);
}

export function join(...parts: string[]): string {
  return PathUtils.join(...parts);
}

export function parent(path: string): string | null {
  return PathUtils.parent(path);
}

export async function readText(path: string): Promise<string> {
  return await IOUtils.readUTF8(path);
}

export async function writeText(path: string, data: string): Promise<void> {
  await IOUtils.writeUTF8(path, data);
}

export async function exists(path: string): Promise<boolean> {
  try { return await IOUtils.exists(path); } catch { return false; }
}

export async function stat(path: string): Promise<{ size: number; lastModified: number } | null> {
  try {
    const s = await IOUtils.stat(path);
    return { size: s.size, lastModified: s.lastModified };
  } catch { return null; }
}

export async function ensureDir(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
}

export async function remove(path: string): Promise<void> {
  try { await IOUtils.remove(path); } catch {}
}
