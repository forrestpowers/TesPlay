/** Player settings remembered in this browser only: a car screen and a phone can differ. */
export const PLAYBACK_STATS_KEY = 'tesplay.playbackStats';
export const HALF_FRAME_RATE_KEY = 'tesplay.halfFrameRate';
export const CAR_MODE_KEY = 'tesplay.carMode';
export type CarModeHeight = 720 | 480;
// Car mode lasts for the channel it was chosen on: another channel, or the
// same one opened again later, starts without transcoding. It is kept in
// memory only; an earlier version remembered it in the browser, so clear that.
let carMode: { channel: string; height: CarModeHeight } | null = null;
try { localStorage.removeItem(CAR_MODE_KEY); } catch { /* Nothing stored. */ }
/** The car mode size chosen for this channel, or null when car mode is off. */
export function readCarMode(channel: string): CarModeHeight | null {
  return carMode?.channel === channel ? carMode.height : null;
}
export function writeCarMode(channel: string, height: CarModeHeight | null): void {
  carMode = height ? { channel, height } : null;
}
export function clearCarMode(): void { carMode = null; }
/** The identity car mode is tied to: one channel of one connection. */
export function carModeChannel(item: { connectionId?: string; type: string; id: string }): string {
  return `${item.connectionId || ''}:${item.type}:${item.id}`;
}
export function readDevicePreference(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
export function writeDevicePreference(key: string, value: boolean): void {
  try { if (value) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* Private browsing: keep the in-memory value. */ }
}
