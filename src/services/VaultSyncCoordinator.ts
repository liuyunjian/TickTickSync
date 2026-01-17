/**
 * VaultSyncCoordinator - Coordinates syncing between database and vault files
 * Extracts vault sync logic from SyncModule
 */

import { App, Notice, TFile } from 'obsidian';
import type TickTickSync from '@/main';
import type { ITask } from '@/api/types/Task';
import type { LocalTask } from '@/db/schema';
import { db } from "@/db/dexie";
import { getSettings } from '@/settings';
import { TaskDeletionModal } from '@/modals/TaskDeletionModal';
import log from '@/utils/logger';

export class VaultSyncCoordinator {
	private app: App;
	private plugin: TickTickSync;

	constructor(app: App, plugin: TickTickSync) {
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * Sync the vault with the database state
	 * Groups tasks by file and performs additions, updates, and deletions
	 */
	async syncVaultWithDatabase(): Promise<void> {
		const tasks = await db.tasks.toArray();
		let syncTag = getSettings().SyncTag?.toLowerCase();
		if (syncTag && syncTag.includes('/')) {
			syncTag = syncTag.replace(/\//g, '-');
		}
		const syncProject = getSettings().SyncProject;
		const andOr = getSettings().tagAndOr;

		// Group tasks by file
		const fileGroups: Map<string, { toAdd: ITask[], toUpdate: ITask[], toDelete: ITask[] }> = new Map();
		const dbUpdates: { localId: string, changes: Partial<LocalTask> }[] = [];
		const projectIdToFilepathCache: Map<string, string> = new Map();

		// Categorize tasks by their target file and action needed
		for (const lt of tasks) {
			const task = lt.task;
			const matchesFilter = this.matchesFilter(task, syncTag, syncProject, andOr);

			let targetFile = lt.file;
			if (!targetFile && matchesFilter && !lt.deleted) {
				targetFile = await this.determineTargetFile(task, projectIdToFilepathCache);
			}

			if (!targetFile) continue;

			// Normalize targetFile to existing mapping if it only differs by case
			if (lt.file && lt.file.toLowerCase() === targetFile.toLowerCase()) {
				targetFile = lt.file;
			}

			if (!fileGroups.has(targetFile)) {
				fileGroups.set(targetFile, { toAdd: [], toUpdate: [], toDelete: [] });
			}
			const group = fileGroups.get(targetFile)!;

			if (lt.deleted) {
				if (lt.file) {
					group.toDelete.push(task);
				}
			} else if (matchesFilter) {
				const actionNeeded = this.determineActionNeeded(lt, targetFile);
				if (actionNeeded.action === 'add') {
					group.toAdd.push(task);
					dbUpdates.push({ localId: lt.localId, changes: { file: targetFile, lastVaultSync: Date.now() } });
				} else if (actionNeeded.action === 'move') {
					// Task moved to a different file (project change)
					const oldFile = lt.file!;
					if (!fileGroups.has(oldFile)) {
						fileGroups.set(oldFile, { toAdd: [], toUpdate: [], toDelete: [] });
					}
					fileGroups.get(oldFile)!.toDelete.push(task);
					group.toAdd.push(task);
					dbUpdates.push({ localId: lt.localId, changes: { file: targetFile, lastVaultSync: Date.now() } });
				} else if (actionNeeded.action === 'update') {
					group.toUpdate.push(task);
					dbUpdates.push({ localId: lt.localId, changes: { lastVaultSync: Date.now() } });
				}
			} else if (lt.file) {
				// No longer matches filter, remove from vault
				group.toDelete.push(task);
			}
		}

		log.debug("VaultSync: File groups prepared", { fileCount: fileGroups.size });

		// Handle deletions with user confirmation
		const proceedWithDeletions = await this.confirmDeletions(fileGroups);

		// Process each file group
		await this.processFileGroups(fileGroups, proceedWithDeletions, tasks, dbUpdates);

		// Bulk update DB at the end
		if (dbUpdates.length > 0) {
			await db.transaction("rw", db.tasks, async () => {
				for (const update of dbUpdates) {
					await db.tasks.update(update.localId, update.changes);
				}
			});
			log.debug(`VaultSync: Updated ${dbUpdates.length} task records in DB`);
		}
	}

	/**
	 * Determine the target file for a task based on its project
	 */
	private async determineTargetFile(
		task: ITask,
		cache: Map<string, string>
	): Promise<string | undefined> {
		if (cache.has(task.projectId)) {
			return cache.get(task.projectId)!;
		}

		let targetFile = await this.plugin.cacheOperation.getFilepathForProjectId(task.projectId);
		if (!targetFile) {
			targetFile = await this.plugin.cacheOperation.getFilepathForProjectId(getSettings().defaultProjectId);
		}

		if (targetFile) {
			cache.set(task.projectId, targetFile);
		}

		return targetFile;
	}

	/**
	 * Determine what action is needed for a task
	 */
	private determineActionNeeded(
		lt: LocalTask,
		targetFile: string
	): { action: 'add' | 'move' | 'update' | 'none' } {
		const isNew = !lt.file;
		const hasChanged = lt.updatedAt > (lt.lastVaultSync || 0);
		const fileMoved = lt.file && lt.file !== targetFile;

		if (isNew) {
			return { action: 'add' };
		} else if (fileMoved) {
			return { action: 'move' };
		} else if (hasChanged) {
			return { action: 'update' };
		}

		return { action: 'none' };
	}

	/**
	 * Check if a task matches the sync filter (tag/project)
	 */
	private matchesFilter(task: ITask, syncTag?: string, syncProject?: string, andOr?: number): boolean {
		if (!syncTag && !syncProject) return true;

		const hasTag = syncTag ? task.tags?.some(t => t.toLowerCase() === syncTag) : false;
		const hasProject = syncProject ? task.projectId === syncProject : false;

		if (syncTag && syncProject) {
			return andOr === 1 ? (hasTag && hasProject) : (hasTag || hasProject);
		}
		return hasTag || hasProject;
	}

	/**
	 * Confirm deletions with the user
	 */
	private async confirmDeletions(
		fileGroups: Map<string, { toAdd: ITask[], toUpdate: ITask[], toDelete: ITask[] }>
	): Promise<boolean> {
		const tasksToConfirmDeletionIds: string[] = [];
		for (const group of fileGroups.values()) {
			tasksToConfirmDeletionIds.push(...group.toDelete.map(t => (t.id || (t as any).taskId)));
		}

		if (tasksToConfirmDeletionIds.length === 0) {
			return true;
		}

		const items = await this.plugin.cacheOperation.getDeletionItems(tasksToConfirmDeletionIds);
		const modal = new TaskDeletionModal(
			this.app,
			items,
			'tasks deleted from TickTick',
			() => {}
		);
		const confirmed = await modal.showModal();

		if (!confirmed) {
			new Notice('Tasks will not be deleted from vault.', 5000);
		}

		return confirmed;
	}

	/**
	 * Process file groups - handle deletions, updates, and additions
	 */
	private async processFileGroups(
		fileGroups: Map<string, { toAdd: ITask[], toUpdate: ITask[], toDelete: ITask[] }>,
		proceedWithDeletions: boolean,
		allTasks: LocalTask[],
		dbUpdates: { localId: string, changes: Partial<LocalTask> }[]
	): Promise<void> {
		for (const [filePath, group] of fileGroups) {
			const file = this.app.vault.getAbstractFileByPath(filePath);

			// 1. Handle Deletions
			if (proceedWithDeletions && group.toDelete.length > 0) {
				if (file instanceof TFile) {
					await this.plugin.fileOperation?.deleteTasksFromSpecificFile(file, group.toDelete, false);
				}
				for (const task of group.toDelete) {
					const lt = allTasks.find(t => t.taskId === (task.id || (task as any).taskId));
					if (lt) {
						// Clear the file field (tombstone pattern)
						dbUpdates.push({ localId: lt.localId, changes: { file: "" } });
					}
				}
			}

			// 2. Handle Updates
			if (group.toUpdate.length > 0) {
				await this.plugin.fileOperation?.synchronizeToVault(filePath, group.toUpdate, true);
			}

			// 3. Handle Additions
			if (group.toAdd.length > 0) {
				await this.plugin.fileOperation?.synchronizeToVault(filePath, group.toAdd, false);
			}
		}
	}
}
