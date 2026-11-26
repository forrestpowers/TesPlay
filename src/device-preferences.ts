/** Player settings remembered in this browser only: a car screen and a phone can differ. */
export const PLAYBACK_STATS_KEY = 'tesplay.playbackStats';
export const HALF_FRAME_RATE_KEY = 'tesplay.halfFrameRate';
export const CAR_MODE_KEY = 'tesplay.carMode';
export function readDevicePreference(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
export function writeDevicePreference(key: string, value: boolean): void {
  try { if (value) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* Private browsing: keep the in-memory value. */ }
}
