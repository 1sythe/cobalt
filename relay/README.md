# cobalt relay

YouTube often blocks the servers that cobalt instances run on. The cobalt relay is a small app that lets your YouTube downloads on such an instance go through your own internet connection instead, for example a computer at home.

You only need the relay if your instance shows YouTube errors like "youtube asked the processing instance to prove that it's not a bot". Instances that run on a home connection don't need it.

## How it works

```
browser ── cobalt instance ──websocket──► cobalt relay (your computer) ──► YouTube
                 ▲                                      │
                 └──────────────── video ◄──────────────┘
```

1. The relay connects to your cobalt instance. The connection goes out from your computer, so no router or firewall changes are needed.
2. When you download a YouTube video with your relay link enabled, the instance asks your relay to connect to YouTube. YouTube sees your connection instead of the server.
3. The video travels from YouTube through your relay to the instance, which processes it and sends it to your browser as usual.

Only your own YouTube downloads use your relay. Other people on the same instance, and all other services, are not affected.

## Setup

1. On your cobalt instance, open **settings > instances > youtube relay** and turn on **route youtube through my relay**. This creates your relay link. The section only appears on instances that support relays.
2. Download the relay app for your system from the [releases page](https://github.com/1sythe/cobalt/releases?q=relay&expanded=true):

    | System | File |
    |:-------|:-----|
    | Windows | `cobalt-relay-windows-x64.exe` |
    | macOS (Apple silicon) | `cobalt-relay-macos-arm64` |
    | macOS (Intel) | `cobalt-relay-macos-x64` |
    | Linux (x64) | `cobalt-relay-linux-x64` |
    | Linux (ARM64, for example a Raspberry Pi) | `cobalt-relay-linux-arm64` |

3. Start the app, copy your relay link with the copy button in settings, and paste it into the app. The link is saved, so next time you only need to start the app.

The settings page shows **relay connected** while the app is running. Keep the app open while you download.

### Platform notes

- **Windows:** the app is not signed with a paid certificate, so Windows SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** make the file executable and remove the download quarantine before the first start:

    ```sh
    chmod +x cobalt-relay-macos-arm64
    xattr -d com.apple.quarantine cobalt-relay-macos-arm64
    ./cobalt-relay-macos-arm64
    ```

- **Linux:**

    ```sh
    chmod +x cobalt-relay-linux-x64
    ./cobalt-relay-linux-x64
    ```

- **Running from source:** with Node.js 22.4 or newer, run `node relay/src/index.js` from a copy of this repository.

The `SHA256SUMS` file on the releases page lists the checksum of every download.

## Commands

| Command | Effect |
|:--------|:-------|
| `cobalt-relay` | Start the relay with the saved link, or ask for one |
| `cobalt-relay <relay link>` | Start the relay with this link and save it |
| `cobalt-relay --forget` | Delete the saved link |
| `cobalt-relay --help` | Show the help |

The link is saved in `%APPDATA%\cobalt-relay\config.json` on Windows, `~/Library/Application Support/cobalt-relay/config.json` on macOS, and `~/.config/cobalt-relay/config.json` on Linux.

If you create a new link in settings, start the app with the new link, or run `cobalt-relay --forget` and start it again.

## Security

- **The relay only connects to YouTube.** It accepts connections to YouTube and Google video hosts on port 443 and nothing else. Requests for any other host, raw IP addresses, and hosts that resolve to private or local network addresses are refused. The instance can't use your relay to reach other websites or devices on your network.
- **Your downloads stay encrypted.** The connection between the instance and YouTube is encrypted end to end. The relay only passes the encrypted data along.
- **Your relay link works like a password.** Anyone who has it and can use the instance could route their YouTube downloads through your connection. Don't share it. If it leaks, create a new link in settings.
- **The relay link is never sent in a URL.** The app sends it inside the encrypted connection after connecting, so it doesn't end up in server logs.

## Limits

- **Upload speed:** videos go through your connection's upload, which is often much slower than its download. A 1080p video or music is quick. Large 4K videos can take a while.
- **The app must stay running** for the whole download. If it closes, the download fails, and the web app reports that your relay isn't connected.
- **Your connection must be able to reach YouTube.** If YouTube also blocks your connection, the relay can't help.

## For instance owners

Relays are disabled by default. To allow them, set these environment variables on the cobalt api:

```
YTDLP_PATH=/path/to/yt-dlp
YTDLP_RELAY=1
```

Relays connect with a WebSocket to `/relay` on the api, so a reverse proxy in front of cobalt has to forward WebSocket upgrades. With Apache, add `upgrade=websocket` to the `ProxyPass` line. With nginx, forward the `Upgrade` and `Connection` headers and use `proxy_http_version 1.1`.

More details are in [docs/api-env-variables.md](/docs/api-env-variables.md#ytdlp_relay) and [docs/fork-changes.md](/docs/fork-changes.md).
