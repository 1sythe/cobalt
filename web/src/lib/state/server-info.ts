import { writable } from "svelte/store";
import type { CobaltServerInfoCache } from "$lib/api/server-info";

export default writable<CobaltServerInfoCache | undefined>();
