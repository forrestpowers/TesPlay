/** Every provider TesPlay can name, including ones no longer offered for new connections. */
export const allServices = [
  {
    id: "xtream",
    name: "IPTV",
    subtitle: "Live TV, films & series",
    color: "#9c88ff",
    letters: "TV",
    description: "Connect your Xtream Codes provider or an M3U playlist.",
  },
  {
    id: "plex",
    name: "Plex",
    subtitle: "Your personal collection",
    color: "#e8b341",
    letters: "plex",
    description:
      "Sign in with Plex, choose your server, then choose your Plex Home profile.",
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
  {
    id: "drive",
    name: "Google Drive",
    subtitle: "Your cloud, on the big screen",
    color: "#5fba89",
    letters: "△",
    description: "Connect your Google account to browse your video files.",
  },
  {
    id: "stremio",
    name: "Stremio",
    subtitle: "Your addons, on the big screen",
    color: "#a88bfa",
    letters: "S",
    description:
      "Connect your Stremio account, choose your addons and watch here with TesPlayer.",
  },
];

/** Providers offered for new connections. Plex, Stremio and Google Drive are not offered for now; existing connections keep working. */
export const services = allServices.filter((service) => !["plex", "stremio", "drive"].includes(service.id));
