#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import pkg from "../package.json" with { type: "json" };
import { Relay } from "./relay.js";

const codeRegex = /^[0-9a-zA-Z_-]{22,64}$/;
const STATS_INTERVAL = 10 * 1000;

const help = `cobalt relay v${pkg.version}
routes youtube traffic for your cobalt downloads through this computer's internet connection.

usage:
  cobalt-relay [relay link]   start the relay (the link is remembered for next time)
  cobalt-relay --forget       forget the saved relay link
  cobalt-relay --help         show this help

get your relay link in cobalt: settings > instances > youtube relay.`;

const configDir = () => {
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "cobalt-relay");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "cobalt-relay");
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "cobalt-relay");
}

const configFile = path.join(configDir(), "config.json");

const time = () => new Date().toTimeString().slice(0, 8);
const log = (message) => console.log(`[${time()}] ${message}`);

const formatBytes = (bytes) => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
        bytes /= 1024;
        unit++;
    }
    return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

// exiting while sockets are still closing can crash node on windows, so give them a moment
const exit = (code) => setTimeout(() => process.exit(code), 300);

const ask = async (question) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
}

// when started by double-clicking, the window would close before the error can be read
const exitWithError = async (message) => {
    console.error(`\n${message}`);
    if (process.stdin.isTTY) {
        await ask("\npress enter to close.");
    }
    exit(1);
}

// a relay link looks like https://api.instance.example/relay#<code>
const parseLink = (link) => {
    let url;
    try {
        url = new URL(String(link).trim());
    } catch {
        return;
    }

    const code = url.hash.slice(1);
    if (!["http:", "https:"].includes(url.protocol) || !codeRegex.test(code)) {
        return;
    }

    return { apiOrigin: url.origin, code, link: url.toString() };
}

const loadLink = async () => {
    try {
        const config = JSON.parse(await readFile(configFile, "utf8"));
        return parseLink(config.link);
    } catch {}
}

const saveLink = async (link) => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(configFile, JSON.stringify({ link }, null, 4), { mode: 0o600 });
}

const rejectionMessages = {
    duplicate: "this relay link is already used by another running relay. retrying in case it's an old connection.",
    full: "the instance has too many relays connected right now. retrying.",
    invalid: "the instance didn't accept this relay link. get a new link in cobalt settings > instances > youtube relay.",
    version: "this relay app is not compatible with the instance. download the latest relay app.",
};

const main = async () => {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        return console.log(help);
    }
    if (args.includes("--version")) {
        return console.log(pkg.version);
    }
    if (args.includes("--forget")) {
        await rm(configFile, { force: true });
        return console.log("forgot the saved relay link.");
    }

    console.log(`cobalt relay v${pkg.version}\n`);

    const linkArg = args.find(arg => !arg.startsWith("-"));
    let relayLink = linkArg ? parseLink(linkArg) : await loadLink();

    if (linkArg && !relayLink) {
        return exitWithError("that doesn't look like a relay link. copy it from cobalt settings > instances > youtube relay.");
    }

    while (!relayLink) {
        if (!process.stdin.isTTY) {
            return exitWithError("no relay link saved yet. run: cobalt-relay <relay link>");
        }

        console.log("copy your relay link from cobalt settings > instances > youtube relay.");
        relayLink = parseLink(await ask("paste it here and press enter: "));

        if (!relayLink) {
            console.log("that doesn't look like a relay link, try again.\n");
        }
    }

    await saveLink(relayLink.link).catch(() => {
        log("couldn't save the relay link, you'll have to paste it again next time.");
    });

    const host = new URL(relayLink.apiOrigin).host;
    let connected = false;

    const relay = new Relay({
        apiOrigin: relayLink.apiOrigin,
        code: relayLink.code,
        onEvent: (event) => {
            switch (event.type) {
                case "connecting":
                    if (event.attempt === 0) log(`connecting to ${host}...`);
                    break;
                case "ready":
                    connected = true;
                    log(`connected to ${host}.`);
                    log("youtube downloads that use this relay link now go through this computer.");
                    log("keep this window open while downloading. press ctrl+c to stop.");
                    break;
                case "disconnected":
                    if (connected || event.retryIn >= 30) {
                        log(`not connected to ${host}, retrying in ${event.retryIn}s.`);
                    }
                    connected = false;
                    break;
                case "rejected":
                    log(rejectionMessages[event.reason] || `the instance rejected the relay (${event.reason}).`);
                    if (event.fatal) {
                        exitWithError("relay stopped.");
                    }
                    break;
                case "blocked":
                    log(`blocked a connection to ${event.host}:${event.port}, it's not a youtube address.`);
                    break;
            }
        },
    });

    relay.start();

    let lastReported = 0;
    const statsTimer = setInterval(() => {
        const total = relay.stats.fromYoutube + relay.stats.toYoutube;
        if (total !== lastReported) {
            lastReported = total;
            log(`relayed ${formatBytes(relay.stats.fromYoutube)} from youtube so far, ${relay.activeStreams} active connection(s).`);
        }
    }, STATS_INTERVAL);

    process.on("SIGINT", () => {
        relay.stop();
        clearInterval(statsTimer);
        console.log("\nrelay stopped.");
        exit(0);
    });
}

main().catch(error => exitWithError(`unexpected error: ${error?.message || error}`));
