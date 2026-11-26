/** Player settings remembered in this browser only: a car screen and a phone can differ. */
export const PLAYBACK_STATS_KEY = 'tesplay.playbackStats';
export const HALF_FRAME_RATE_KEY = 'tesplay.halfFrameRate';
export const CAR_MODE_KEY = 'tesplay.carMode';
export type CarModeHeight = 720 | 480;
/** The car mode size chosen on this browser, or null when car mode is off. */
export function readCarMode(): CarModeHeight | null {
  let value: string | null = null;
  try { value = localStorage.getItem(CAR_MODE_KEY); } catch { /* Private browsing: car mode stays off. */ }
  // '1' was stored before 480p existed and means 720p.
  return value === '480' ? 480 : value === '720' || value === '1' ? 720 : null;
}
export function writeCarMode(height: CarModeHeight | null): void {
  try { if (height) localStorage.setItem(CAR_MODE_KEY, String(height)); else localStorage.removeItem(CAR_MODE_KEY); } catch { /* Private browsing: nothing to keep. */ }
}
export function readDevicePreference(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
export function writeDevicePreference(key: string, value: boolean): void {
  try { if (value) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* Private browsing: keep the in-memory value. */ }
}
