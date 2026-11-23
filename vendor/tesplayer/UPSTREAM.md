TesPlayer engine and contracts vendored from https://github.com/rdvnit/TesPlayer
Revision: dfd05ae757652353aa38ec186569477419c5e15a.
Only the engine and contracts are included; reference frontend/API and tests are excluded.
UPSTREAM.json records SHA-256 digests for every imported file.
Run npm run check:player to verify the bundle, and npm run build:player to rebuild dist.
Update using npm run sync:player -- --source /path/to/TesPlayer --revision <full-commit-sha>.
The upstream package metadata is preserved unmodified. The owner-authored copy bundled here is distributed under TesPlay's root LICENSE and NOTICE; third-party terms still apply.
Dependency notices: packages/player/LICENSES.md and public/licenses/.

## Local patches

- `packages/player/src/engine.ts`: `chooseAudioTrack` prefers the first pairable audio track whose decoder this browser supports when the demuxed primary track (for example AC-3 in IPTV MPEG-TS) is unsupported and no exact file-track selector pins a track. The `UPSTREAM.json` digest for this file covers the patched content; reapply the patch after `sync:player`.
- `packages/player/src/capabilities.ts`: `probeTrackDecoderCapability` re-probes audio flagged `mp4a.40.1` (AAC Main) as `mp4a.40.2`, because browsers reject the Main codec string while decoding the frames as AAC-LC; TesPlay registers a Mediabunny custom decoder (`src/aac-main-decoder.ts`) that performs the same relabel at decode time.
