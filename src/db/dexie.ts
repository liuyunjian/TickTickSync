import Dexie, { Table } from "dexie";
import type { LocalTask, SyncMeta } from "./schema";
import type { TaskFileMapping } from "./schema";

import { defaultDBData } from "./schema";
import { ensureSyncMeta } from "./meta";
import { migrateDB } from "./migrations";
import { getTasks, getSettings, updateSettings } from '@/settings';

type MetaRow = SyncMeta & { key: "sync" };

class TickTickDB extends Dexie {
	tasks!: Table<LocalTask, string>;
	meta!: Table<MetaRow, "sync">;
	mappings!: Table<TaskFileMapping, string>;

	constructor(vaultName: string) {
		super(vaultName + "TickTickSync");

		this.version(3).stores({
			tasks: "localId, taskId, updatedAt, lastVaultSync, file, deleted",
			meta: "key",
			mappings: "id, taskId, file"
		});
	}
}

export let db: TickTickDB;

export async function initDB() {
	if (!db) {
		db = new TickTickDB(getSettings().vaultName);
	}

	let rawMeta = await db.meta.get("sync");
	const settings = getSettings();

	if (!rawMeta) {
		const meta = await ensureSyncMeta(structuredClone(defaultDBData.meta), {
			deviceId: settings.deviceId,
			deviceLabel: settings.deviceLabel
		});
		await db.meta.put({ ...meta, key: "sync" });
		
		// Update settings if they were empty
		if (!settings.deviceId) {
			updateSettings({
				deviceId: meta.deviceId,
				deviceLabel: meta.deviceLabel
			});
		}
		
		// Initial migration from old settings-based tasks
		const oldTasks = getTasks();
		const fileMetadata = getSettings().fileMetadata;
		
		if (oldTasks && oldTasks.length > 0) {
			const tasksToPut: LocalTask[] = oldTasks.map(t => {
				// Find file mapping
				let filePath = "";
				for (const [path, detail] of Object.entries(fileMetadata)) {
					if (detail.TickTickTasks.some(dt => dt.taskId === t.id)) {
						filePath = path;
						break;
					}
				}

				return {
					localId: `tt:${t.id}`,
					taskId: t.id,
					task: t,
					updatedAt: t.modifiedTime ? new Date(t.modifiedTime).getTime() : Date.now(),
					lastModifiedByDeviceId: meta.deviceId || "unknown",
					deleted: t.deleted === 1,
					file: filePath,
					source: "ticktick"
				};
			});

			await db.tasks.bulkPut(tasksToPut);
		}
		
		rawMeta = await db.meta.get("sync");
	}

	if (!rawMeta) return;

	// Sync settings with DB meta (DB is source of truth for device identity)
	if (settings.deviceId !== rawMeta.deviceId) {
		updateSettings({
			deviceId: rawMeta.deviceId,
			deviceLabel: rawMeta.deviceLabel
		});
	}

	const migrated = migrateDB({
		meta: rawMeta,
		tasks: await db.tasks.toArray()
	});

	await db.transaction("rw", db.tasks, db.meta, async () => {
		await db.tasks.bulkPut(migrated.tasks);
		const finalizedMeta = await ensureSyncMeta(migrated.meta);
		await db.meta.put({ ...finalizedMeta, key: "sync" });

	});
}
