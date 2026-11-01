/** Protection of the app's window while a secret is typed. */

import { secureScreenModule } from './util/native';

/**
 * Protects the app's window while a secret is typed. Android: no screenshots, recordings or casts
 * of the window, other apps' windows not drawn over it (Android 12 and later), and touches that
 * passed through another app's window dropped. iOS cannot block screenshots; it covers the window
 * while the screen is recorded or mirrored.
 *
 * Calls nest: each `protect(true)` needs its `protect(false)`, and the window is put back as it
 * was -- a window the app keeps secure itself stays secure -- when the last one ends. Other apps'
 * overlays, which no public call reads, are shown again then. Returns what the window has now; a
 * build without the native module answers nothing, and the entry stays usable.
 */
export class SecureScreen {
  static async protect(on: boolean): Promise<Record<string, unknown>> {
    try {
      const native = secureScreenModule();
      if (native === null) {
        return {};
      }
      const state = (await native.protect(on)) as Record<string, unknown> | null;
      return state ?? {};
    } catch {
      return {};
    }
  }
}
