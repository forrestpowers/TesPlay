export type YouTubeAuthMode = 'apiKey' | 'oauth' | 'innertube';

const fields: Record<
  string,
  {
    key: string;
    label: string;
    placeholder: string;
    secret?: boolean;
    optional?: boolean;
  }[]
> = {
  xtream: [
    {
      key: "url",
      label: "Provider URL",
      placeholder: "https://provider.example:8080",
    },
    { key: "username", label: "Username", placeholder: "Your IPTV username" },
    {
      key: "password",
      label: "Password",
      placeholder: "Your IPTV password",
      secret: true,
    },
  ],
  m3u: [
    {
      key: "url",
      label: "Playlist URL",
      placeholder: "https://provider.example/playlist.m3u",
      optional: true,
    },
  ],
  // The legacy YouTube Data API connection signed in with the server owner's Google OAuth client.
  googleClient: [
    {
      key: "clientId",
      label: "Google OAuth client ID",
      placeholder: "Your Google Cloud web client ID",
    },
    {
      key: "clientSecret",
      label: "Google OAuth client secret",
      placeholder: "Your client secret",
      secret: true,
    },
  ],
  youtube: [
    {
      key: "apiKey",
      label: "YouTube Data API key",
      placeholder: "A key with YouTube Data API v3 enabled",
      secret: true,
    },
  ],
};
export function connectionFields(type: string, mode: YouTubeAuthMode) {
  // Phone sign-in needs nothing typed but the connection name.
  if (type === 'youtube' && mode === 'innertube') return [];
  return type === 'youtube' && mode === 'oauth'
    ? fields.googleClient
    : fields[type] || [];
}

export function youtubeAuthMode(config: Record<string, string>, configuredFields: string[]): YouTubeAuthMode {
  if (config.authMode === 'innertube') return 'innertube';
  return config.authMode === 'oauth' || (!config.authMode && (configuredFields.includes('refreshToken') || configuredFields.includes('accessToken')))
    ? 'oauth' : 'apiKey';
}
