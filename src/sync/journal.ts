import log from '@/utils/logger';

type SyncEvent = {
	timestamp: number;
	deviceId: string;
	action: string;
	details?: any;
};

const MAX_ENTRIES = 500;
const journal: SyncEvent[] = [];

export function logSyncEvent(
	deviceId: string,
	action: string,
	details?: any
) {
	journal.push({
		timestamp: Date.now(),
		deviceId,
		action,
		details
	});

	if (journal.length > MAX_ENTRIES) {
		journal.shift();
	}

	log.debug("[TickTickSync]", action, details ?? "");
}

export function getSyncJournal() {
	return [...journal];
}

export function clearJournal() {
	journal.length = 0;
}
