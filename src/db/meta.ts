import type { SyncMeta } from "./schema";
import { generateDeviceId, detectDeviceLabel } from "./device";

export async function ensureSyncMeta(meta: SyncMeta, preferred?: Partial<SyncMeta>): Promise<SyncMeta> {
	let changed = false;

	if (!meta.deviceId) {
		meta.deviceId = preferred?.deviceId || generateDeviceId();
		meta.deviceLabel = preferred?.deviceLabel || await detectDeviceLabel();
		changed = true;
	}

	if (!meta.lastFullSync ) {
		meta.lastFullSync = 0;
		changed = true;
	}

	if (!meta.lastDeltaSync) {
		meta.lastDeltaSync = 0;
		changed = true;
	}

	return meta;
}
