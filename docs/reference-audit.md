# Feature scope and limits

TesPlay brings media from accounts and sources you configure into its own browser interface. It does not supply a media catalog, provider subscription or streaming credentials. The [README integration table](../README.md#made-for-your-collection) describes supported sources.

## Supported scope

- Authorized Xtream Codes/M3U sources, source/category browsing and Xtream short EPG.
- YouTube browsing and playback, with an optional resolver as fallback.
- Household accounts, profiles, saved lists, progress and a paired phone remote.
- Temporary phone-video upload and supported FFmpeg conversion.

## Current limits

Native Crunchyroll playback, Jellyfin/Emby adapters, raw torrent playback, DRM circumvention, general screen mirroring, games and widgets are not implemented. M3U XMLTV import, and YouTube account watch-history import are not implemented.

Browser decoding, service authorization, upstream restrictions and provider stream allowances still determine what can play. FFmpeg conversion for temporary phone media is separate from a general-purpose live transcoding service.

TesPlay has no access to the vehicle's gear state and does not claim a safety interlock. Use it only while safely parked in Park. See [tested vehicles](compatibility.md) and [player details](tesplayer.md).
