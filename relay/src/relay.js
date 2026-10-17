import net from "node:net";
import { lookup } from "node:dns/promises";

import { isAllowedTarget, isPublicAddress } from "./policy.js";

// keep in sync with api/src/relay/hub.js
const PROTOCOL_VERSION = 1;

// payload bytes that may be in flight per stream and direction
const WINDOW = 1024 * 1024;

const MAX_STREAMS = 64;
const CONNECT_TIMEOUT = 10 * 1000;
const RECONNECT_DELAYS = [1, 2, 5, 10, 20, 30];

// rejections that won't go away by retrying
const fatalReasons = new Set(["invalid", "version"]);

const dataFrame = (id, chunk) => {
    const frame = Buffer.allocUnsafe(4 + chunk.length);
    frame.writeUInt32BE(id);
    chunk.copy(frame, 4);
    return frame;
}

const connectOnce = (address, family, port) => new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, family, port });

    const fail = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
    }
    const timer = setTimeout(() => fail(new Error("connect timeout")), CONNECT_TIMEOUT);

    socket.once("error", fail);
    socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        resolve(socket);
    });
});

// resolves the host, checks every address, and connects to one of the checked
// addresses directly, so the target can't change between the check and the connection
const connectTo = async (host, port, policy) => {
    const addresses = await lookup(host, { all: true });

    if (!addresses.length || !addresses.every(({ address }) => policy.isPublicAddress(address))) {
        throw new Error("address not allowed");
    }

    let lastError;
    for (const { address, family } of addresses) {
        try {
            return await connectOnce(address, family, port);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

export class Relay {
    #url;
    #code;
    #policy;
    #onEvent;

    #ws;
    #streams = new Map();
    #attempt = 0;
    #stopped = true;
    #reconnectTimer;

    stats = {
        fromYoutube: 0,
        toYoutube: 0,
        connections: 0,
    };

    constructor({ apiOrigin, code, onEvent = () => {}, policy = { isAllowedTarget, isPublicAddress } }) {
        const url = new URL("/relay", apiOrigin);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";

        this.#url = url.toString();
        this.#code = code;
        this.#policy = policy;
        this.#onEvent = onEvent;
    }

    get activeStreams() {
        return this.#streams.size;
    }

    start() {
        this.#stopped = false;
        this.#connect();
    }

    stop() {
        this.#stopped = true;
        clearTimeout(this.#reconnectTimer);
        this.#ws?.close();
        this.#closeAll();
    }

    #connect() {
        this.#onEvent({ type: "connecting", attempt: this.#attempt });

        const ws = new WebSocket(this.#url);
        ws.binaryType = "arraybuffer";
        this.#ws = ws;

        ws.addEventListener("open", () => {
            // the code goes in the first message, never in the url
            this.#send({ type: "hello", version: PROTOCOL_VERSION, code: this.#code });
        });

        ws.addEventListener("message", ({ data }) => {
            if (typeof data === "string") {
                this.#onControl(data);
            } else {
                this.#onData(Buffer.from(data));
            }
        });

        ws.addEventListener("close", () => {
            this.#closeAll();
            if (this.#stopped) return;

            const delay = RECONNECT_DELAYS[Math.min(this.#attempt, RECONNECT_DELAYS.length - 1)];
            this.#attempt++;
            this.#onEvent({ type: "disconnected", retryIn: delay });
            this.#reconnectTimer = setTimeout(() => this.#connect(), delay * 1000);
        });

        // a close event always follows, reconnecting is handled there
        ws.addEventListener("error", () => {});
    }

    #send(message) {
        if (this.#ws?.readyState === 1) {
            this.#ws.send(JSON.stringify(message));
        }
    }

    #onControl(text) {
        let message;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        switch (message?.type) {
            case "ready":
                this.#attempt = 0;
                return this.#onEvent({ type: "ready" });
            case "error":
                if (fatalReasons.has(message.reason)) {
                    this.stop();
                }
                return this.#onEvent({
                    type: "rejected",
                    reason: message.reason,
                    fatal: fatalReasons.has(message.reason),
                });
            case "open":
                return this.#open(message.id, message.host, message.port);
            case "credit":
                return this.#onCredit(message.id, message.bytes);
            case "close":
                return this.#closeStream(message.id, false);
        }
    }

    async #open(id, host, port) {
        if (!Number.isSafeInteger(id) || this.#streams.has(id)) {
            return;
        }

        if (this.#streams.size >= MAX_STREAMS || !this.#policy.isAllowedTarget(host, port)) {
            this.#onEvent({ type: "blocked", host: String(host), port });
            return this.#send({ type: "refused", id });
        }

        const stream = { socket: null, credit: WINDOW, unacked: 0 };
        this.#streams.set(id, stream);

        let socket;
        try {
            socket = await connectTo(host, port, this.#policy);
        } catch {
            if (this.#streams.get(id) === stream) {
                this.#streams.delete(id);
                this.#send({ type: "refused", id });
            }
            return;
        }

        // the stream may have been closed while connecting
        if (this.#streams.get(id) !== stream) {
            return socket.destroy();
        }

        stream.socket = socket;
        this.stats.connections++;

        socket.on("data", chunk => this.#sendData(id, stream, chunk));
        socket.on("error", () => {});
        socket.on("close", () => this.#closeStream(id, true));

        this.#send({ type: "opened", id });
    }

    #sendData(id, stream, chunk) {
        if (this.#ws?.readyState !== 1) return;

        this.#ws.send(dataFrame(id, chunk));
        this.stats.fromYoutube += chunk.length;

        stream.credit -= chunk.length;
        if (stream.credit <= 0) {
            stream.socket.pause();
        }
    }

    #onData(frame) {
        if (frame.length < 4) return;

        const id = frame.readUInt32BE(0);
        const payload = frame.subarray(4);
        const stream = this.#streams.get(id);
        if (!stream?.socket) return;

        this.stats.toYoutube += payload.length;

        // credit goes back once youtube's socket has taken the data
        stream.socket.write(payload, () => {
            stream.unacked += payload.length;
            if (stream.unacked >= WINDOW / 4 && this.#streams.get(id) === stream) {
                this.#send({ type: "credit", id, bytes: stream.unacked });
                stream.unacked = 0;
            }
        });
    }

    #onCredit(id, bytes) {
        const stream = this.#streams.get(id);
        if (!stream?.socket || !Number.isSafeInteger(bytes) || bytes <= 0) return;

        stream.credit += bytes;
        if (stream.credit > 0 && stream.socket.isPaused()) {
            stream.socket.resume();
        }
    }

    #closeStream(id, notifyServer) {
        const stream = this.#streams.get(id);
        if (!stream) return;

        this.#streams.delete(id);
        if (notifyServer) {
            this.#send({ type: "close", id });
        }
        stream.socket?.end();
    }

    #closeAll() {
        for (const stream of this.#streams.values()) {
            stream.socket?.destroy();
        }
        this.#streams.clear();
    }
}
