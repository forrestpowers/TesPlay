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
};
export function connectionFields(type: string) {
  // YouTube signs in with the phone: nothing to type but the connection name.
  return fields[type] || [];
}
