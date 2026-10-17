import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { env } from "../../config.js";
import { Yellow } from "../../misc/console-text.js";

const execFileAsync = promisify(execFile);

const videoQualities = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

// codec patterns are regexes, used both in yt-dlp format filters and here
const codecList = {
    h264: {
        videoCodec: "^avc1",
        audioCodec: "^mp4a",
        container: "mp4"
    },
    av1: {
        videoCodec: "^av01",
        audioCodec: "^opus",
        container: "webm"
    },
    vp9: {
        videoCodec: "^vp0?9",
        audioCodec: "^opus",
        container: "webm"
    }
}

// same fallback order as the innertube path: av1 <-> vp9, then h264
const codecFallbacks = {
    h264: ["h264"],
    av1: ["av1", "vp9", "h264"],
    vp9: ["vp9", "av1", "h264"],
}

// cobalt tunnels can only stream plain files, not hls playlists
const httpsOnly = "[protocol=https]";

const isFormatId = id => typeof id === "string" && /^[\w-]+$/.test(id);

const normalizeQuality = (width, height) => {
    const shortestSide = Math.min(width, height);
    return videoQualities.find(qual => qual >= shortestSide);
}

const detectCodec = vcodec => Object.keys(codecList).find(
    codec => new RegExp(codecList[codec].videoCodec).test(vcodec)
);

const buildSelector = (o, codec) => {
    const selectors = [];

    // a tunnel refresh (transplant) passes the formats picked last time
    if (isFormatId(o.itag?.audio)) {
        if (o.isAudioOnly) {
            selectors.push(o.itag.audio);
        } else if (isFormatId(o.itag?.video)) {
            selectors.push(`${o.itag.video}+${o.itag.audio}`);
        }
    }

    for (const fallback of codecFallbacks[codec]) {
        const { videoCodec, audioCodec } = codecList[fallback];
        const audio = `ba${httpsOnly}[acodec~='${audioCodec}']`;

        const audioOptions = o.dubLang
            ? [`${audio}[language^=${o.dubLang}]`, audio]
            : [audio];

        for (const audioOption of audioOptions) {
            selectors.push(
                o.isAudioOnly
                    ? audioOption
                    : `bv${httpsOnly}[vcodec~='${videoCodec}']+${audioOption}`
            );
        }
    }

    return [...new Set(selectors)].join("/");
}

const parseError = (stderr = "") => {
    if (/private video/i.test(stderr)) {
        return "content.video.private";
    }
    if (/confirm your age|age.restricted|inappropriate for some users/i.test(stderr)) {
        return "content.video.age";
    }
    if (/not a bot/i.test(stderr)) {
        return "youtube.login";
    }
    if (/in your country|geo.?restrict/i.test(stderr)) {
        return "content.video.region";
    }
    if (/live event will begin|premieres in/i.test(stderr)) {
        return "content.video.live";
    }
    if (/video (is )?unavailable|video is not available|has been removed|terminated/i.test(stderr)) {
        return "content.video.unavailable";
    }
    return "fetch.fail";
}

const runYtdlp = async (args) => {
    const childEnv = { ...process.env };

    // passed through the environment instead of --proxy,
    // so that proxy credentials don't show up in the process list
    if (env.ytdlpProxy) {
        childEnv.HTTP_PROXY = childEnv.HTTPS_PROXY = env.ytdlpProxy;
        delete childEnv.NO_PROXY;
    }

    const { stdout, stderr } = await execFileAsync(env.ytdlpPath, args, {
        env: childEnv,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60 * 1000,
        windowsHide: true,
    });

    return { info: JSON.parse(stdout), stderr };
}

export async function getYtdlpMedia(o) {
    const codec = o.codec || "h264";
    const quality = o.quality === "max" ? 9000 : Number(o.quality);

    const args = [
        "--ignore-config",
        "--no-playlist",
        // with this, the reason for missing formats is printed as a warning
        "--ignore-no-formats-error",
        "--js-runtimes", `node:${process.execPath}`,
        "--dump-single-json",
        "--format", buildSelector(o, codec),
        "--format-sort", `res:${quality}`,
    ];

    if (env.ytdlpCookies) {
        args.push("--cookies", env.ytdlpCookies);
    }

    args.push("--", `https://www.youtube.com/watch?v=${o.id}`);

    let info, stderr;
    try {
        ({ info, stderr } = await runYtdlp(args));
    } catch (e) {
        if (e?.code === "ENOENT") {
            console.error(`${Yellow('[!]')} yt-dlp wasn't found at YTDLP_PATH (${env.ytdlpPath})`);
        }
        return { error: parseError(e?.stderr) };
    }

    if (info?.id !== o.id) {
        return {
            error: "fetch.fail",
            critical: true
        }
    }

    if (["is_live", "is_upcoming"].includes(info.live_status)) {
        return { error: "content.video.live" };
    }

    if (info.duration > env.durationLimit) {
        return { error: "content.too_long" };
    }

    // a single selected format is merged into the top level of the info
    const [video, audio] = o.isAudioOnly
        ? [undefined, info.url ? info : undefined]
        : info.requested_formats ?? [];

    if (!audio || (!o.isAudioOnly && !video)) {
        // finished streams have no plain file formats until youtube processes them
        if (info.live_status === "post_live") {
            return { error: "content.video.live" };
        }

        const error = parseError(stderr);
        return { error: error === "fetch.fail" ? "youtube.no_matching_format" : error };
    }

    if (video?.has_drm || audio.has_drm) {
        return { error: "youtube.drm" };
    }

    const author = (info.channel || info.uploader || "").replace("- Topic", "").trim();

    const fileMetadata = {
        title: info.title.trim(),
        artist: author,
    }

    if (info.album) {
        fileMetadata.album = info.album;
    }

    if (/^\d{8}$/.test(info.release_date)) {
        const date = info.release_date;
        fileMetadata.date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    }

    let subtitles;
    if (o.subtitleLang && !o.isAudioOnly) {
        const language = Object.keys(info.subtitles || {}).find(
            lang => lang.startsWith(o.subtitleLang)
        );
        const track = info.subtitles?.[language]?.find(s => s.ext === "vtt");

        // locked down captions can't be accessed without a potoken
        if (track?.url && !track.url.includes("exp=xpe")) {
            subtitles = { url: track.url, language };
            fileMetadata.sublanguage = language;
        }
    }

    const isDubbed = o.dubLang
        && audio.language?.startsWith(o.dubLang)
        && !/original/i.test(audio.format_note || "");

    const filenameAttributes = {
        service: "youtube",
        id: o.id,
        title: fileMetadata.title,
        author,
        youtubeDubName: isDubbed ? audio.language : false,
    }

    const originalRequest = {
        ...o,
        dispatcher: undefined,
        itag: {
            video: video?.format_id,
            audio: audio.format_id,
        }
    };

    if (o.isAudioOnly) {
        let bestAudio = audio.ext;
        if (audio.acodec?.startsWith("mp4a")) bestAudio = "m4a";
        else if (audio.acodec === "opus") bestAudio = "opus";

        let cover = `https://i.ytimg.com/vi/${o.id}/maxresdefault.jpg`;
        const testMaxCover = await fetch(cover)
            .then(r => r.status === 200)
            .catch(() => {});

        if (!testMaxCover) {
            cover = info.thumbnail;
        }

        return {
            type: "audio",
            isAudioOnly: true,
            urls: audio.url,
            filenameAttributes,
            fileMetadata,
            bestAudio,
            isHLS: false,
            originalRequest,

            cover,
            cropCover: (info.channel || "").endsWith("- Topic"),
        }
    }

    const videoCodec = detectCodec(video.vcodec) || codec;

    filenameAttributes.resolution = `${video.width}x${video.height}`;
    filenameAttributes.extension = o.container === "auto" ? codecList[videoCodec].container : o.container;
    filenameAttributes.qualityLabel = `${normalizeQuality(video.width, video.height)}p`;
    filenameAttributes.youtubeFormat = videoCodec;

    return {
        type: "merge",
        urls: [
            video.url,
            audio.url,
        ],
        subtitles: subtitles?.url,
        filenameAttributes,
        fileMetadata,
        isHLS: false,
        originalRequest
    }
}
