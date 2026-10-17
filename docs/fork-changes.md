# Fork changes

This repository is a fork of [imputnet/cobalt](https://github.com/imputnet/cobalt), maintained by [1sythe](https://github.com/1sythe). It follows upstream `main` and adds the changes listed below. Everything not mentioned here behaves exactly like upstream cobalt.

## Summary

| Area | Change | Files |
|:-----|:-------|:------|
| api | Optional yt-dlp backend for YouTube | `api/src/processing/helpers/youtube-ytdlp.js`, `api/src/processing/services/youtube.js`, `api/src/core/env.js`, `docs/api-env-variables.md` |
| web | Fix for serving libav.js files from the dev server on Windows | `web/vite.config.ts` |
| web | "luca's edit" label next to the community instance label | `web/src/components/save/Omnibox.svelte` |
| ci | Deployment workflow for this fork's own instance | `.github/workflows/deploy.yml` |

## 1. Optional yt-dlp backend for YouTube

### Background

YouTube now rejects media requests (HTTP 403) from the innertube clients that cobalt uses unless the request carries a proof of origin token. In that state, cobalt still returns tunnels for YouTube links, but the tunnels deliver empty files. The web app reports this as "file tunnel is empty". All clients available to cobalt were tested, over both IPv4 and IPv6, with the same result.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) is maintained to keep up with these changes, so this fork can use it to resolve YouTube media links.

### What changed

- A new helper, `api/src/processing/helpers/youtube-ytdlp.js`, resolves YouTube media links through yt-dlp and returns them in the same shape as the built-in YouTube service.
- When the `YTDLP_PATH` environment variable is set, `api/src/processing/services/youtube.js` hands the request to this helper. When it is not set, the upstream behavior is unchanged.
- `YTDLP_PATH` is read in `api/src/core/env.js` and documented in `docs/api-env-variables.md`.

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

### Limitations

- The `youtubeHLS` request option is ignored in this mode.
- Each request starts a yt-dlp process, which adds a few seconds before the download begins.
- yt-dlp has to be updated regularly to keep working as YouTube changes.

### Configuration

```
YTDLP_PATH=/usr/local/bin/yt-dlp
```

The value must point to a yt-dlp executable that the cobalt process is allowed to run.

## 2. libav.js dev server fix on Windows

During development, `web/vite.config.ts` serves the libav.js files under `/_libav/` and finds them with `glob`. The search pattern was built with `path.join`, which uses backslashes on Windows. `glob` treats backslashes as escape characters, so no file matched and every request returned 404. On-device processing then failed with "couldn't probe this file, it may be unsupported or corrupted", even though the downloaded files were valid.

The fix passes `windowsPathsNoEscape: true` to `glob`. Production builds were not affected, because they copy the files without `glob`.

## 3. Fork label

In `web/src/components/save/Omnibox.svelte`, the "community instance" label is kept and followed by "luca's edit", which links to this repository.

## 4. Deployment workflow

`.github/workflows/deploy.yml` deploys this fork's instance on every push to `main`. It connects to the server over SSH and runs a fixed deploy command. The SSH key used by the workflow is restricted on the server to that single command.

The workflow only runs in `1sythe/cobalt` and needs these repository secrets:

| Secret | Content |
|:-------|:--------|
| `DEPLOY_SSH_KEY` | Private key of the deploy user |
| `DEPLOY_HOST` | Address of the server |
| `DEPLOY_KNOWN_HOSTS` | Known hosts entry for the server |

## Keeping up with upstream

```sh
git remote add upstream https://github.com/imputnet/cobalt.git
git fetch upstream
git merge upstream/main
```

## License

The upstream licenses apply to this fork: the api is licensed under [AGPL-3.0](/api/LICENSE) and the web app under [CC BY-NC-SA 4.0](/web/LICENSE). The changes in this fork are released under the same licenses.
