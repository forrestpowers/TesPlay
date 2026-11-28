/** The providers TesPlay connects to. */
export const services = [
  {
    id: "xtream",
    name: "IPTV",
    subtitle: "Live TV, films & series",
    color: "#9c88ff",
    letters: "TV",
    description: "Connect your Xtream Codes provider or an M3U playlist.",
  },
  {
    id: "youtube",
    name: "YouTube",
    subtitle: "Find your next rabbit hole",
    color: "#ff4949",
    letters: "▶",
    description:
      "Sign in with your phone for your Home feed, subscriptions, playlists and history.",
  },
];

/**
 * Connection types TesPlay no longer supports. A saved connection of one of
 * these types still lists in Settings, under its old name, so it can be removed.
 */
export const retiredServices: Record<string, string> = {
  plex: "Plex",
  stremio: "Stremio",
  drive: "Google Drive",
  local: "Server folder",
};
export const isRetiredService = (type: string) => Object.hasOwn(retiredServices, type);
