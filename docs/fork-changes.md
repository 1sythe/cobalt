# Fork changes

This repository is a fork of [imputnet/cobalt](https://github.com/imputnet/cobalt), maintained by [1sythe](https://github.com/1sythe). It follows upstream `main` and adds the changes listed below. Everything not mentioned here behaves exactly like upstream cobalt.

## Summary

| Area | Change | Files |
|:-----|:-------|:------|
| api | Optional yt-dlp backend for YouTube, with cookie and proxy options for server hosting | `api/src/processing/helpers/youtube-ytdlp.js`, `api/src/processing/services/youtube.js`, `api/src/stream/manage.js`, `api/src/core/env.js`, `docs/api-env-variables.md` |
| relay | YouTube relay: users can route their own YouTube downloads through their own connection | `relay/`, `api/src/relay/hub.js`, `api/src/core/api.js`, `api/src/processing/schema.js`, `api/src/processing/match.js`, `web/src/components/settings/YoutubeRelay.svelte`, `.github/workflows/relay-release.yml` |
| web | Fix for serving libav.js files from the dev server on Windows | `web/vite.config.ts` |
| web | Fix for an import cycle that broke pages loading server info first | `web/src/lib/state/server-info.ts` |

## 1. Optional yt-dlp backend for YouTube

### Background

YouTube now rejects media requests (HTTP 403) from the innertube clients that cobalt uses unless the request carries a proof of origin token. In that state, cobalt still returns tunnels for YouTube links, but the tunnels deliver empty files. The web app reports this as "file tunnel is empty". All clients available to cobalt were tested, over both IPv4 and IPv6, with the same result.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) is maintained to keep up with these changes, so this fork can use it to resolve YouTube media links.

### What changed

- A new helper, `api/src/processing/helpers/youtube-ytdlp.js`, resolves YouTube media links through yt-dlp and returns them in the same shape as the built-in YouTube service.
- When the `YTDLP_PATH` environment variable is set, `api/src/processing/services/youtube.js` hands the request to this helper. When it is not set, the upstream behavior is unchanged.
- `api/src/stream/manage.js` routes YouTube media downloads through `YTDLP_PROXY` when it is set (see below).
- The new variables are read and validated in `api/src/core/env.js` and documented in `docs/api-env-variables.md`.

### Behavior

- Only the step that finds media links moves to yt-dlp. Tunnels, chunked streaming, server side muxing and on-device processing are unchanged.
- Request options are translated into yt-dlp format selection:
  - **Codec:** h264, av1 or vp9, with the same fallback order as upstream (av1 and vp9 fall back to each other, then to h264).
  - **Quality:** compared against the smallest dimension of the video, like upstream. The closest quality at or below the requested one is used.
  - **Audio only, dubbed audio language and subtitles** are supported.
- Only direct https formats are selected, because tunnels cannot stream HLS playlists.
- When a tunnel needs fresh links, the previously selected format IDs are reused, so the refreshed stream matches the original one.
- yt-dlp is started without a shell and with `--ignore-config`, so a local yt-dlp configuration cannot change cobalt's behavior. The Node.js runtime that runs cobalt is passed to yt-dlp for solving YouTube's JavaScript challenges.
- yt-dlp errors are mapped to existing cobalt error codes: private, age restricted, region locked, unavailable, live, and bot check.

### Configuration

```
YTDLP_PATH=/usr/local/bin/yt-dlp
```

The value must point to a yt-dlp executable that the cobalt process is allowed to run. This is all that is needed when cobalt runs on a home connection.

### Hosting on a server

YouTube often blocks the IP addresses of VPS and datacenter providers with a bot check ("Sign in to confirm you're not a bot"), regardless of the client used. When that happens, two optional settings can help. Neither is needed for instances running on a home connection.

| Variable | Purpose |
|:---------|:--------|
| `YTDLP_COOKIES` | Path to a Netscape-format cookies file passed to yt-dlp. Use cookies from a separate account, because YouTube may flag accounts used this way. yt-dlp updates the file after each request, so it must be writable by cobalt. |
| `YTDLP_PROXY` | HTTP or HTTPS proxy for YouTube, for example a residential proxy. Both yt-dlp and cobalt's YouTube media downloads use it, because YouTube media links only work from the IP address that requested them. Other services are not affected. Credentials in the URL are passed to yt-dlp through its environment, so they do not appear in the process list. SOCKS proxies are not supported. |

```
YTDLP_COOKIES=/path/to/youtube-cookies.txt
YTDLP_PROXY=http://user:password@proxy.example:3128
```

### Limitations

- The `youtubeHLS` request option is ignored in this mode.
- Each request starts a yt-dlp process, which adds a few seconds before the download begins.
- yt-dlp has to be updated regularly to keep working as YouTube changes.

## 2. YouTube relay

### Background

`YTDLP_COOKIES` and `YTDLP_PROXY` are instance-wide settings that the instance owner has to provide. The relay adds an option for users: each user can route their own YouTube downloads through their own internet connection by running a small app, without any setup on the instance besides enabling the feature. The user guide is in [relay/README.md](/relay/README.md).

### Components

- **Relay app (`relay/`):** a dependency-free Node.js app. It connects to the instance over a WebSocket, opens TCP connections to YouTube on the instance's behalf, and passes the data through. It only connects to YouTube and Google video hosts on port 443, refuses raw IP addresses, and refuses hosts that resolve to private, loopback, link-local or other non-public addresses. It connects to the exact address it checked, so DNS changes can't redirect it. The link is saved locally and the app reconnects automatically.
- **Relay hub (`api/src/relay/hub.js`):** accepts relay connections on `/relay` when `YTDLP_RELAY=1`. It runs a local-only HTTP CONNECT proxy, where the relay code is the proxy username. yt-dlp and cobalt's YouTube media streams use this proxy, so both reach YouTube through the user's relay.
- **Web app:** a "youtube relay" section in settings > instances, shown only when the instance supports relays. It creates the relay link, shows whether the relay is connected, and links to the download. When enabled, requests include the relay code as `youtubeRelay`.
- **API:** the request schema accepts `youtubeRelay`, `GET /` reports `youtubeRelay: true` when relays are enabled, and `POST /relay/status` tells the web app whether a relay is connected. New errors: `youtube.relay.offline` and `youtube.relay.disabled`.
- **Release workflow (`.github/workflows/relay-release.yml`):** pushing a `relay-v*` tag builds standalone executables for Windows, macOS and Linux with Bun and publishes them as a GitHub release with checksums. macOS builds get an ad-hoc signature.

### Protocol

Control messages are JSON text frames, and data is sent in binary frames that start with a 4-byte stream ID.

1. The relay connects and sends `hello` with the protocol version and its code. The code is never part of the URL, so it stays out of reverse proxy logs. The hub answers with `ready`, or with an error such as `duplicate` when the code is already connected.
2. For each connection, the hub sends `open` with the host and port. The relay checks it against its policy and answers with `opened` or `refused`.
3. Each side may have up to 1 MiB of unacknowledged data per stream in flight. The receiver returns `credit` once the data has been written to its local socket, so a slow consumer slows the sender down instead of filling memory.
4. Either side ends a stream with `close`.

### Behavior

- Only YouTube requests that carry a relay code use a relay. Other users and other services are not affected.
- If the relay disconnects, requests fail with `youtube.relay.offline` instead of falling back to the server's own IP address.
- The hub limits the number of relays (64) and streams per relay (32), drops relays that stop answering pings, and refuses a second relay with a code that is already connected.

## 3. libav.js dev server fix on Windows

During development, `web/vite.config.ts` serves the libav.js files under `/_libav/` and finds them with `glob`. The search pattern was built with `path.join`, which uses backslashes on Windows. `glob` treats backslashes as escape characters, so no file matched and every request returned 404. On-device processing then failed with "couldn't probe this file, it may be unsupported or corrupted", even though the downloaded files were valid.

The fix passes `windowsPathsNoEscape: true` to `glob`. Production builds were not affected, because they copy the files without `glob`.

## 4. Server info import cycle fix

`web/src/lib/state/server-info.ts` imported `web/src/lib/api/server-info.ts` only for a type, but as a regular import. That module imports `web/src/lib/state/turnstile.ts`, which imports the server info state again. When a page loaded the server info state first, the turnstile state read it before it was initialized and the page failed to render. The import is now type-only, which removes the cycle at runtime.

## Keeping up with upstream

```sh
git remote add upstream https://github.com/imputnet/cobalt.git
git fetch upstream
git merge upstream/main
```

## License

The upstream licenses apply to this fork: the api is licensed under [AGPL-3.0](/api/LICENSE) and the web app under [CC BY-NC-SA 4.0](/web/LICENSE). The changes in this fork are released under the same licenses.
