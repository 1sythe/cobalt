<script lang="ts">
    import { browser } from "$app/environment";

    import settings, { updateSetting } from "$lib/state/settings";
    import cachedInfo from "$lib/state/server-info";

    import { t } from "$lib/i18n/translations";
    import { copyURL } from "$lib/download";
    import { hapticConfirm } from "$lib/haptics";
    import { currentApiURL } from "$lib/api/api-url";
    import { getServerInfo } from "$lib/api/server-info";

    import CopyIcon from "$components/misc/CopyIcon.svelte";
    import SettingsToggle from "$components/buttons/SettingsToggle.svelte";
    import SettingsCategory from "$components/settings/SettingsCategory.svelte";

    const releasesURL = "https://github.com/1sythe/cobalt/releases?q=relay&expanded=true";
    const STATUS_INTERVAL = 5000;

    // 24 random bytes as base64url, accepted by the api as a relay code
    const generateCode = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    };

    const supported = $derived(!!$cachedInfo?.info?.cobalt?.youtubeRelay);
    const enabled = $derived($settings.processing.enableYoutubeRelay);
    const code = $derived($settings.processing.youtubeRelayCode);

    const relayLink = $derived(
        code && $settings.processing ? `${currentApiURL()}/relay#${code}` : ""
    );

    // the link works like a password, so it's never shown in full
    const maskedLink = $derived(
        relayLink ? `${relayLink.split("#")[0]}#${"•".repeat(12)}` : ""
    );

    let connected = $state(false);
    let copied = $state(false);

    if (browser) {
        getServerInfo();
    }

    $effect(() => {
        if (enabled && !code) {
            updateSetting({ processing: { youtubeRelayCode: generateCode() } });
        }
    });

    $effect(() => {
        if (!supported || !enabled || !code) {
            connected = false;
            return;
        }

        let active = true;

        const check = async () => {
            const response = await fetch(`${currentApiURL()}/relay/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
                signal: AbortSignal.timeout(STATUS_INTERVAL),
            })
            .then(r => r.json())
            .catch(() => {});

            if (active) {
                connected = !!response?.connected;
            }
        };

        check();
        const interval = setInterval(check, STATUS_INTERVAL);

        return () => {
            active = false;
            clearInterval(interval);
        };
    });

    const copyLink = () => {
        if (copied || !relayLink) return;

        copyURL(relayLink);
        hapticConfirm();
        copied = true;
        setTimeout(() => copied = false, 1500);
    };

    const newLink = () => {
        updateSetting({ processing: { youtubeRelayCode: generateCode() } });
    };
</script>

{#if supported}
    <SettingsCategory
        sectionId="youtube-relay"
        title={$t("settings.processing.youtube_relay")}
    >
        <div class="category-inside-group">
            <SettingsToggle
                settingContext="processing"
                settingId="enableYoutubeRelay"
                title={$t("settings.processing.youtube_relay.title")}
            />

            {#if enabled && code}
                <div class="relay-link-holder">
                    <div
                        class="relay-link"
                        aria-label={$t("settings.processing.youtube_relay.link")}
                    >
                        {maskedLink}
                    </div>
                    <button
                        class="button relay-copy"
                        aria-label={copied ? $t("button.copied") : $t("button.copy")}
                        onclick={copyLink}
                    >
                        <CopyIcon check={copied} regularIcon />
                    </button>
                </div>

                <div class="relay-status" class:connected role="status">
                    <span class="relay-status-dot" aria-hidden="true"></span>
                    {connected
                        ? $t("settings.processing.youtube_relay.connected")
                        : $t("settings.processing.youtube_relay.not_connected")}
                </div>

                <div class="relay-actions">
                    <a
                        class="button"
                        href={releasesURL}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {$t("settings.processing.youtube_relay.download")}
                    </a>
                    <button class="button" onclick={newLink}>
                        {$t("settings.processing.youtube_relay.new_link")}
                    </button>
                </div>
            {/if}
        </div>
        <div class="subtext">
            {$t("settings.processing.youtube_relay.description")}
        </div>
    </SettingsCategory>
{/if}

<style>
    .category-inside-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .subtext {
        margin-top: -3px;
    }

    .relay-link-holder {
        display: flex;
        gap: 6px;
    }

    .relay-link {
        flex: 1;
        min-width: 0;
        padding: 11.5px 16px;
        border-radius: var(--border-radius);
        background-color: var(--button);
        box-shadow: var(--button-box-shadow);
        color: var(--secondary);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .relay-copy {
        width: 40px;
        padding: 0;
    }

    .relay-copy :global(svg) {
        height: 21px;
        width: 21px;
        stroke-width: 1.8px;
    }

    .relay-status {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 4px;
        font-size: 13px;
        font-weight: 500;
        color: var(--gray);
    }

    .relay-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: var(--gray);
    }

    .relay-status.connected {
        color: var(--secondary);
    }

    .relay-status.connected .relay-status-dot {
        background-color: var(--green);
    }

    .relay-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .relay-actions .button {
        font-size: 13px;
        text-decoration: none;
    }
</style>
