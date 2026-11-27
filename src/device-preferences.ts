/** Player settings remembered in this browser only: a car screen and a phone can differ. */
export const PLAYBACK_STATS_KEY = 'tesplay.playbackStats';
export const HALF_FRAME_RATE_KEY = 'tesplay.halfFrameRate';
export const CAR_MODE_KEY = 'tesplay.carMode';
export type CarModeHeight = 720 | 480;
export type CarModeChoice = CarModeHeight | 'off';
/** The account's car mode default, as stored in its preferences. */
export type CarModeDefault = 'off' | '720' | '480';
// A choice made in the player lasts for that channel only: another channel, or
// the same one opened again later, starts from the account's default. It is
// kept in memory; an earlier version remembered it in the browser, so clear that.
let carModeOverride: { channel: string; choice: CarModeChoice } | null = null;
try { localStorage.removeItem(CAR_MODE_KEY); } catch { /* Nothing stored. */ }
/** The car mode chosen in the player for this channel, or undefined to use the default. */
export function readCarModeOverride(channel: string): CarModeChoice | undefined {
  return carModeOverride?.channel === channel ? carModeOverride.choice : undefined;
}
export function writeCarModeOverride(channel: string, choice: CarModeChoice): void {
  carModeOverride = { channel, choice };
}
export function clearCarMode(): void { carModeOverride = null; }
/** The size to request for this channel: its own choice first, then the account default. */
export function effectiveCarMode(channel: string, accountDefault?: CarModeDefault): CarModeHeight | null {
  const choice = readCarModeOverride(channel) ?? (accountDefault === '720' ? 720 : accountDefault === '480' ? 480 : 'off');
  return choice === 'off' ? null : choice;
}
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
