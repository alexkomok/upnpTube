# upnpTube

Cast from YouTube / YouTube Music mobile apps to DLNA/UPnP renderers (speakers, amps, TVs) on your local network.

This repository currently targets the `alexkomok/upnpTube` flow and includes a set of stability fixes for YouTube Music playback, next-track transitions, volume updates, and seek behavior on iEAST AudioCast-class renderers.

Source/original repository: https://github.com/mas94uk/upnpTube

## What works

- Device discovery via SSDP
- Cast receiver exposure in YouTube / YouTube Music
- Play / pause / resume / stop
- Next track handling for sender-driven playlist changes
- Auto-next handling with renderer-side end detection
- Volume control with stale-read mitigation
- Seek with transient socket-reset retry and UI position stabilization

## Requirements

- Node.js `>=18`
- npm
- `yt-dlp` installed on the host

This code currently expects `yt-dlp` at:

- `/home/pi/.local/bin/yt-dlp`

## Important local configuration

Before running, adjust hardcoded network values in `renderer.js` for your host:

- DIAL bind address (`bindToAddresses`) is currently `192.168.0.154`
- Local media URL host is currently `http://192.168.0.154:9002/...`

If your machine IP is different, update both values.

## Installation

```bash
git clone https://github.com/alexkomok/upnpTube.git
cd upnpTube
npm ci
```

`npm ci` runs `patch-package` via `postinstall`, applying local fixes to `yt-cast-receiver` from `patches/`.

## Run

```bash
node index.js
```

You should see logs like:

- `Local file server listening on port 9002`
- `DIAL server listening on port 3005`
- renderer discovery / sender connection logs

## How it works

1. SSDP discovers `MediaRenderer:1` devices.
2. A `yt-cast-receiver` instance is started per renderer.
3. On play, audio is downloaded with `yt-dlp` to `/tmp/upnptube-<index>-<videoId>.m4a`.
4. The local Express server (port `9002`) serves `/tmp`.
5. The renderer is instructed to load/play the local `audio/m4a` URL (DLNA profile `AAC_ISO`).

## Debugging

Useful command for UPnP call tracing:

```bash
DEBUG=upnp-device-client node index.js
```

Common focused grep while reproducing:

```bash
DEBUG=upnp-device-client node index.js 2>&1 | grep --line-buffered -Ei \
'setPlaylist|Player\.(play|stop|next|seek)|SetAVTransportURI|GetPositionInfo|GetMediaInfo|GetVolume|LOCAL URL|socket hang up|ECONNRESET'
```

## Notes and limitations

- Behavior can vary across DLNA renderers; this repo includes renderer-specific mitigations for transient UPnP socket resets.
- If you update `yt-cast-receiver`, revalidate `patches/yt-cast-receiver+2.1.0.patch`.
