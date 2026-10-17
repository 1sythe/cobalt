import http from "node:http";
import { ProxyAgent } from "undici";
import { WebSocketServer } from "ws";

import { env } from "../config.js";

// keep in sync with relay/src/relay.js
const PROTOCOL_VERSION = 1;

// payload bytes that may be in flight per stream and direction
const WINDOW = 1024 * 1024;

const MAX_RELAYS = 64;
const MAX_STREAMS_PER_RELAY = 32;

const HELLO_TIMEOUT = 10 * 1000;
const OPEN_TIMEOUT = 15 * 1000;
const PING_INTERVAL = 30 * 1000;

const codeRegex = /^[0-9a-zA-Z_-]{22,64}$/;

// relay code -> session
const relays = new Map();

// relay code -> undici dispatcher for youtube media
const dispatchers = new Map();

let proxyPort;

const dataFrame = (id, chunk) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(id);
    return Buffer.concat([header, chunk]);
}

// one connected relay app. the api asks it to open tcp connections
// (only to youtube hosts, enforced by the relay) and multiplexes them
// over the websocket with per-stream flow control.
class RelaySession {
    #ws;
    #code;
    #streams = new Map();
    #nextId = 1;
    #alive = true;
    #pingTimer;

    constructor(ws, code) {
        this.#ws = ws;
        this.#code = code;

        ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
        ws.on("pong", () => this.#alive = true);
        ws.on("close", () => this.#shutdown());
        ws.on("error", () => ws.terminate());

        this.#pingTimer = setInterval(() => {
            if (!this.#alive) {
                return ws.terminate();
            }
            this.#alive = false;
            ws.ping();
        }, PING_INTERVAL);
    }

    #send(message) {
        if (this.#ws.readyState === this.#ws.OPEN) {
            this.#ws.send(JSON.stringify(message));
        }
    }

    // pipes a local CONNECT socket through the relay to host:port
    tunnel(host, port, socket, head) {
        if (this.#streams.size >= MAX_STREAMS_PER_RELAY) {
            return socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        }

        const id = this.#nextId++;
        const stream = {
            socket,
            head,
            credit: WINDOW,
            unacked: 0,
            opened: false,
            timer: setTimeout(() => this.#closeStream(id, true, 504), OPEN_TIMEOUT),
        };
        this.#streams.set(id, stream);

        socket.on("error", () => {});
        socket.on("close", () => this.#closeStream(id, true));

        this.#send({ type: "open", id, host, port });
    }

    #onOpened(id) {
        const stream = this.#streams.get(id);
        if (!stream || stream.opened) return;

        clearTimeout(stream.timer);
        stream.opened = true;

        const { socket } = stream;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        if (stream.head?.length) {
            this.#sendData(id, stream.head);
        }
        delete stream.head;

        socket.on("data", chunk => this.#sendData(id, chunk));
    }

    #sendData(id, chunk) {
        const stream = this.#streams.get(id);
        if (!stream || this.#ws.readyState !== this.#ws.OPEN) return;

        this.#ws.send(dataFrame(id, chunk));

        stream.credit -= chunk.length;
        if (stream.credit <= 0) {
            stream.socket.pause();
        }
    }

    #onData(id, payload) {
        const stream = this.#streams.get(id);
        if (!stream?.opened) return;

        // credit is returned once the data has been handed to the local socket,
        // so a slow consumer slows the relay down instead of filling memory
        stream.socket.write(payload, () => {
            stream.unacked += payload.length;
            if (stream.unacked >= WINDOW / 4 && this.#streams.has(id)) {
                this.#send({ type: "credit", id, bytes: stream.unacked });
                stream.unacked = 0;
            }
        });
    }

    #onCredit(id, bytes) {
        const stream = this.#streams.get(id);
        if (!stream || !Number.isSafeInteger(bytes) || bytes <= 0) return;

        stream.credit += bytes;
        if (stream.credit > 0 && stream.socket.isPaused()) {
            stream.socket.resume();
        }
    }

    #closeStream(id, notifyRelay, failStatus) {
        const stream = this.#streams.get(id);
        if (!stream) return;

        this.#streams.delete(id);
        clearTimeout(stream.timer);

        if (notifyRelay) {
            this.#send({ type: "close", id });
        }

        if (!stream.opened && failStatus) {
            stream.socket.end(`HTTP/1.1 ${failStatus} ${http.STATUS_CODES[failStatus]}\r\n\r\n`);
        } else {
            stream.socket.end();
        }
    }

    #onMessage(data, isBinary) {
        if (isBinary) {
            if (data.length < 4) return;
            return this.#onData(data.readUInt32BE(0), data.subarray(4));
        }

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }

        switch (message?.type) {
            case "opened":
                return this.#onOpened(message.id);
            case "refused":
                return this.#closeStream(message.id, false, 502);
            case "credit":
                return this.#onCredit(message.id, message.bytes);
            case "close":
                return this.#closeStream(message.id, false, 502);
        }
    }

    #shutdown() {
        clearInterval(this.#pingTimer);

        for (const id of [...this.#streams.keys()]) {
            this.#closeStream(id, false, 502);
        }

        if (relays.get(this.#code) === this) {
            relays.delete(this.#code);
        }

        dispatchers.get(this.#code)?.close().catch(() => {});
        dispatchers.delete(this.#code);
    }
}

const reject = (ws, reason) => {
    ws.send(JSON.stringify({ type: "error", reason }));
    ws.close(1008, reason);
}

const acceptRelay = (ws) => {
    const helloTimer = setTimeout(() => ws.terminate(), HELLO_TIMEOUT);
    ws.on("error", () => ws.terminate());

    // the code is sent in the first message instead of the url,
    // so it never ends up in reverse proxy access logs
    ws.once("message", (data, isBinary) => {
        clearTimeout(helloTimer);

        let hello;
        try {
            hello = isBinary ? undefined : JSON.parse(data.toString());
        } catch {}

        if (hello?.type !== "hello") {
            return reject(ws, "invalid");
        }
        if (hello.version !== PROTOCOL_VERSION) {
            return reject(ws, "version");
        }
        if (typeof hello.code !== "string" || !codeRegex.test(hello.code)) {
            return reject(ws, "invalid");
        }
        if (relays.has(hello.code)) {
            return reject(ws, "duplicate");
        }
        if (relays.size >= MAX_RELAYS) {
            return reject(ws, "full");
        }

        relays.set(hello.code, new RelaySession(ws, hello.code));
        ws.send(JSON.stringify({ type: "ready" }));
    });
}

const getProxyCode = (header) => {
    const [scheme, value] = String(header ?? "").split(" ");
    if (scheme !== "Basic" || !value) return;

    return Buffer.from(value, "base64").toString().split(":")[0];
}

// local-only http proxy that yt-dlp and undici use to reach youtube through
// a relay. the relay code is the proxy username.
const startLocalProxy = () => {
    const proxy = http.createServer((_, res) => res.writeHead(405).end());

    proxy.on("connect", (req, socket, head) => {
        socket.on("error", () => {});

        const session = relays.get(getProxyCode(req.headers["proxy-authorization"]));
        const separator = req.url.lastIndexOf(":");
        const host = req.url.slice(0, separator).replace(/^\[|\]$/g, "");
        const port = Number(req.url.slice(separator + 1));

        if (!session || !host || !Number.isInteger(port)) {
            return socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }

        session.tunnel(host, port, socket, head);
    });

    proxy.listen(0, "127.0.0.1", () => {
        proxyPort = proxy.address().port;
    });
}

export const setupRelay = (server) => {
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: WINDOW + 4,
    });

    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => {});

        if (new URL(req.url, "http://relay").pathname !== "/relay") {
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, acceptRelay);
    });

    startLocalProxy();
}

export const isRelayConnected = (code) => relays.has(code);

export const getRelayProxyURL = (code) => {
    if (!proxyPort || !relays.has(code)) return;
    return `http://${code}:relay@127.0.0.1:${proxyPort}`;
}

// used for youtube media streams. it's returned even if the relay is offline,
// so that the stream fails instead of silently using the server's own ip.
export const getRelayDispatcher = (code) => {
    if (!proxyPort || !codeRegex.test(code)) return;

    let dispatcher = dispatchers.get(code);
    if (!dispatcher) {
        dispatcher = new ProxyAgent(`http://${code}:relay@127.0.0.1:${proxyPort}`);
        dispatchers.set(code, dispatcher);
    }

    return dispatcher;
}
