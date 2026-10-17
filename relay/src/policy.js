import net from "node:net";

// the relay only ever connects to youtube, so a cobalt instance can't use it
// to reach anything else on the internet or on the local network
const allowedDomains = [
    "youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
    "googlevideo.com",
    "ytimg.com",
    "ggpht.com",
];

const allowedHosts = new Set([
    "youtubei.googleapis.com",
    "jnn-pa.googleapis.com",
]);

export const isAllowedTarget = (host, port) => {
    if (port !== 443 || typeof host !== "string") {
        return false;
    }

    host = host.toLowerCase();

    // raw ip addresses could point anywhere, only hostnames are accepted
    if (net.isIP(host)) {
        return false;
    }

    return allowedHosts.has(host)
        || allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

// private, loopback, link-local, shared, multicast and reserved ranges
const blockedIPv4 = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

const ipv4ToNumber = ip => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);

const isPublicIPv4 = (ip) => {
    const value = ipv4ToNumber(ip);

    return !blockedIPv4.some(([base, bits]) => {
        const size = 2 ** (32 - bits);
        return Math.floor(value / size) === Math.floor(ipv4ToNumber(base) / size);
    });
}

const expandIPv6 = (ip) => {
    const parse = part => part ? part.split(":").map(group => parseInt(group, 16)) : [];
    const [head, tail] = ip.split("::");

    if (tail === undefined) {
        return parse(head);
    }

    const start = parse(head), end = parse(tail);
    return [...start, ...Array(8 - start.length - end.length).fill(0), ...end];
}

const isPublicIPv6 = (ip) => {
    // ipv4-mapped and other embedded ipv4 forms are not needed for youtube
    if (ip.includes(".")) {
        return false;
    }

    const groups = expandIPv6(ip.toLowerCase().split("%")[0]);
    if (groups.length !== 8 || groups.some(group => Number.isNaN(group))) {
        return false;
    }

    const [first] = groups;
    const isUnspecified = groups.every(group => group === 0);
    const isLoopback = groups.slice(0, 7).every(group => group === 0) && groups[7] === 1;

    return !isUnspecified
        && !isLoopback
        && (first & 0xfe00) !== 0xfc00  // unique local, fc00::/7
        && (first & 0xffc0) !== 0xfe80  // link local, fe80::/10
        && (first & 0xff00) !== 0xff00; // multicast, ff00::/8
}

export const isPublicAddress = (address) => {
    switch (net.isIP(address)) {
        case 4:
            return isPublicIPv4(address);
        case 6:
            return isPublicIPv6(address);
        default:
            return false;
    }
}
