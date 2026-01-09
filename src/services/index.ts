import TickTickSync from '@/main';
import { Tick } from '@/api';
import { getSettings, updateSettings } from '@/settings';
import { doWithLock } from '@/utils/locks';
import { SyncMan } from '@/services/syncModule';
import { Editor, type MarkdownFileInfo, type MarkdownView, Notice, TFile } from 'obsidian';
import { CacheOperation } from '@/services/cacheOperation';
import { FileOperation } from '@/fileOperation';
import { FileMap } from '@/services/fileMap';
//Logging
import log from '@/utils/logger';
import { FoundDuplicateTasksModal } from '@/modals/FoundDuplicateTasksModal';
import { getTick } from '@/api/tick_singleton_factory'
import { syncTickTickWithDexie } from '@/sync/sync';
import { db } from "@/db/dexie";
import { getAllProjects } from "@/db/projects";
import { loadTasksFromCache } from "@/db/tasks";
import { getAllFiles, getFile, upsertFile } from "@/db/files";

const LOCK_TASKS = 'LOCK_TASKS';


//TODO: encapsulate all api and cache
export class TickTickService {
	initialized: boolean = false;
	plugin: TickTickSync;
	tickTickSync!: SyncMan;
	api?: Tick;
	cacheOperation!: CacheOperation;
	fileOperation?: FileOperation;

	constructor(plugin: TickTickSync) {
		this.plugin = plugin;
	}

	initialize(): boolean {
		try {
			const token = getSettings().token;
			if (!token) {
				log.debug('Please login from settings.');
				return false;
			}
			if (getSettings().inboxID.length === 0) {
				log.warn('Something is wrong with your inbox ID.');
				//TODO re login or ask user?
			}

			this.api = getTick({
				baseUrl: getSettings().baseURL,
				token: token,
				checkPoint: getSettings().checkPoint
			});
			//initialize data read and write object
			this.cacheOperation = new CacheOperation(this.plugin.app, this.plugin);
			//initialize file operation
			this.fileOperation = new FileOperation(this.plugin.app, this.plugin);
			this.tickTickSync = new SyncMan(this.plugin.app, this.plugin);
			this.initialized = true;
			return true;
		} catch (error) {
			log.error('Error on initialization: ', error);
		}
		return false;
	}

	backup() {
		this.tickTickSync?.backupTickTickAllResources();
	}

	//MB can be static
	async login(baseUrl: string, username: string, password: string):
		Promise<{ inboxId: string; token: string } | null> {
		try {
			const api = getTick({
				username: username,
				password: password,
				baseUrl: baseUrl,
				token: '',
				checkPoint: 0
			});
			//try login
			const result = await api.login();
			let error: { operation: string, statusCode: string, errorMessage: string };
			if (!result) {
				error = api.lastError;
				const errorString = 'Login Failed. ' + JSON.stringify(error.errorMessage, null, 4);
				new Notice(errorString, 5000);
				log.error("Login Fail!: ", errorString);
				throw new Error(error.errorMessage);
			}
			const defaultProjectId = getSettings().defaultProjectId;
			const defaultProjectName = getSettings().defaultProjectName;
			if (!defaultProjectId || defaultProjectId == '' || (defaultProjectName == "Inbox" && (defaultProjectId != result.inboxId))) {
				//no default project id or blank default project id or (default project is inbox, but the ID is different.
				updateSettings({defaultProjectId: result.inboxId});
			}
			//reset the checkpoint so next time they get ALL the tasks.
			updateSettings({checkPoint: 0});
			await this.plugin.saveSettings();
			return result;
		} catch (error) {
			log.error('Error on login: ', error);
		}
		return null;
	}

	async synchronization(fullSync: boolean = false) {
		try {
			// Populate task cache for fast lookups during sync
			await this.cacheOperation.fillTaskCache();

			await doWithLock(LOCK_TASKS, async () => {
				if (this.plugin.tickTickRestAPI) {
					await this.saveProjectsToCache();
					await syncTickTickWithDexie(this.plugin.tickTickRestAPI, fullSync);
					await this.tickTickSync.syncVaultWithDexie();
				}
			});
			await this.syncFiles(false);
		} catch (error) {
			log.error('Error on synchronization: ', error);
		} finally {
			// Clear cache to free memory
			this.cacheOperation.clearTaskCache();
		}
	}

	async saveProjectsToCache(): Promise<boolean> {
		const projects = await this.api?.getProjects();
		if (!projects) {
			return false;
		}
		// Also get project groups
		const groups = await this.api?.getProjectGroups();
		if (groups) {
			await db.projectGroups.clear();
			await db.projectGroups.bulkPut(groups.map(g => ({ id: g.id, group: g })));
		}
		return this.cacheOperation.saveProjectsToCache(projects);
	}

	async getProjects() {
		return await getAllProjects();
	}

	async getTasks(filter: string) {
		log.debug('getTasks', filter);
		return await loadTasksFromCache();
	}

	async deletedTaskCheck(filePath: string | null) {
		return await doWithLock(LOCK_TASKS, async () => {
			return this.tickTickSync?.deletedTaskCheck(filePath);
		});
	}

	async deletedFileCheck(filePath: string): Promise<boolean> {

		const fileMetadata = await this.cacheOperation?.getFileMetadata(filePath, null);
		if (!fileMetadata || !fileMetadata.TickTickTasks) {
			//log.debug('There is no task in the deleted file')
			return false;
		}
		//TODO
		// if (!(this.checkModuleClass())) {
		// 	return false;
		// }

		await doWithLock(LOCK_TASKS, async () => {
			await this.tickTickSync.deletedTaskCheck(filePath);
			await this.cacheOperation.deleteFilepathFromMetadata(filePath);
		});
		return true;
	}

	async renamedFileCheck(filePath: string, oldPath: string): Promise<boolean> {
		// log.debug(`${oldPath} is renamed`)
		//Read fileMetadata
		//const fileMetadata = await this.fileOperation.getFileMetadata(file)
		const fileMetadata = await this.cacheOperation?.getFileMetadata(oldPath, null);
		if (!fileMetadata || !fileMetadata.TickTickTasks) {
			//log.debug('There is no task in the deleted file')
			return false;
		}
		//TODO
		// if (!(this.checkModuleClass())) {
		// 	return;
		// }

		await doWithLock(LOCK_TASKS, async () => {
			await this.tickTickSync.updateTaskContent(filePath);
			await this.cacheOperation.updateRenamedFilePath(oldPath, filePath);
		});
		return true;
	}

	async fullTextNewTaskCheck(filepath: string) {
		await doWithLock(LOCK_TASKS, async () => {
			await this.tickTickSync?.fullTextNewTaskCheck(filepath);
		});
	}

	async lineNewContentTaskCheck(editor: Editor, info: MarkdownView | MarkdownFileInfo) {
		return await doWithLock(LOCK_TASKS, async () => {
			await this.tickTickSync?.lineNewContentTaskCheck(editor, info);
		});
	}

	async lineModifiedTaskCheck(filepath: string, lastLineText: string, lastLine: number): Promise<boolean> {
		return await doWithLock(LOCK_TASKS, async () => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filepath) as TFile;
			const fileMap = new FileMap(this.plugin.app, this.plugin, file);
			await fileMap.init();
			return this.tickTickSync?.lineModifiedTaskCheck(filepath, lastLineText, lastLine, fileMap);
		});
	}


	/*
	 * called only from settings tab
	 */

	async checkDataBase() {
		const vault = this.plugin.app.vault;
		const markdownFiles = vault.getMarkdownFiles();
		const allProjects = await this.getProjects();
		const dbFiles = await getAllFiles();

		log.debug(`Checking database for ${markdownFiles.length} markdown files and ${dbFiles.length} DB entries.`);

		await doWithLock(LOCK_TASKS, async () => {
			// 1. Ensure all vault files are in DB and match with projects if possible
			for (const file of markdownFiles) {
				const dbFile = await getFile(file.path);
				if (!dbFile) {
					// Look up file name in projects cache
					const fileName = file.basename;
					const matchingProject = allProjects.find(p => p.name === fileName);
					if (matchingProject) {
						log.debug(`Matching project found for new DB entry: ${file.path} -> ${matchingProject.name}`);
						await upsertFile(file.path, matchingProject.id);
					} else {
						log.debug(`Adding new DB entry for file: ${file.path}`);
						await upsertFile(file.path);
					}
				}
			}

			// 2. Remove DB entries for files that no longer exist in vault, or update if renamed
			for (const dbFile of dbFiles) {
				const vaultFile = vault.getAbstractFileByPath(dbFile.path);
				if (!vaultFile || !(vaultFile instanceof TFile)) {
					const metadata = await this.cacheOperation.getFileMetadata(dbFile.path);
					if (metadata && metadata.TickTickTasks && metadata.TickTickTasks.length > 0) {
						const task1 = metadata.TickTickTasks[0];
						const searchResult = await this.fileOperation?.searchFilepathsByTaskidInVault(task1.taskId);
						if (searchResult) {
							log.debug(`File ${dbFile.path} moved to ${searchResult}. Updating DB.`);
							await this.cacheOperation.updateRenamedFilePath(dbFile.path, searchResult);
							continue;
						}
					}
					log.debug(`Removing DB entry for missing file: ${dbFile.path}`);
					await this.cacheOperation.deleteFilepathFromMetadata(dbFile.path);
				}
			}

			// 3. Consistency check for tasks and missed tasks
			const metadatas = await this.cacheOperation?.getFileMetadatas();
			for (const filepath in metadatas) {
				const value = metadatas[filepath];
				const obsidianURL = this.plugin.taskParser.getObsidianUrlFromFilepath(filepath);

				for (const taskDetails of value.TickTickTasks) {
					const localTask = await this.cacheOperation?.loadLocalTaskFromCacheID(taskDetails.taskId);
					let taskObject = localTask?.task;

					if (localTask && (!localTask.lastVaultSync || localTask.lastVaultSync < localTask.updatedAt)) {
						log.debug(`Cleaning up sync timestamps for task ${taskDetails.taskId} in ${filepath}`);
						await this.cacheOperation.updateTaskToCache(localTask.task, filepath, Date.now());
					}

					if (!taskObject) {
						// Try to get from TickTick
						try {
							taskObject = await this.plugin.tickTickRestAPI?.getTaskById(taskDetails.taskId);
							if (taskObject) {
								if (taskObject.deleted === 1) {
									await this.cacheOperation?.deleteTaskIdFromMetadata(filepath, taskDetails.taskId);
									continue;
								}
								// If found, update cache and mark as synced to vault
								await this.cacheOperation.updateTaskToCache(taskObject, filepath, Date.now());
							}
						} catch (error) {
							if (error.message?.includes('404')) {
								await this.cacheOperation?.deleteTaskIdFromMetadata(filepath, taskDetails.taskId);
								continue;
							}
							log.error(`Error loading task ${taskDetails.taskId} from API:`, error);
							continue;
						}
					}

					// Verify Obsidian URL in TickTick
					if (taskObject) {
						const title = taskObject.title || '';
						if (!title.includes(obsidianURL)) {
							try {
								await this.tickTickSync?.updateTaskContent(filepath);
							} catch (error) {
								log.warn(`Error updating task content for ${filepath}:`, error);
							}
						}
					}
				}

				// 4. Scan for missed/unsynced tasks in the file
				try {
					log.debug(`Scanning file ${filepath}`);
					if (getSettings().taskLinksInObsidian === "taskLink") {
						await this.plugin.fileOperation?.addTickTickLinkToFile(filepath);
					}

					await this.tickTickSync?.fullTextNewTaskCheck(filepath);
					await this.tickTickSync?.fullTextModifiedTaskCheck(filepath);
					await this.tickTickSync?.deletedTaskCheck(filepath);

				} catch (error) {
					log.error(`Error scanning file ${filepath}:`, error);
				}
			}
		});

		await this.plugin.saveSettings();
		new Notice(`Database check completed.`);
		log.debug('Done checking data.');
	}

	/*

	 */

	async closeTask(taskId: string) {
		await this.tickTickSync.closeTask(taskId);
	}

	async openTask(taskId: string): Promise<void> {
		await this.tickTickSync.reopenTask(taskId);
	}

	private async syncTickTickToObsidian(): Promise<boolean> {
		return this.tickTickSync.syncTickTickToObsidian();
	}

	/**
	 * @param bForceUpdate
	 */
	async syncFiles(bForceUpdate: boolean) {
		const filesToSync = await this.cacheOperation?.getFileMetadatas();
		if (!filesToSync) {
			log.warn('No sync files found.');
			return;
		}
		let newFilesToSync = filesToSync;
		//If one project is to be synced, don't look at it's other files.

		if (getSettings().SyncProject) {
			newFilesToSync = Object.fromEntries(Object.entries(filesToSync).filter(([key, value]) =>
				value.defaultProjectId === getSettings().SyncProject));
		}

		//Check for duplicates before we do anything
		try {
			const result = await this.cacheOperation?.checkForDuplicates(newFilesToSync);
			if (result?.duplicates && (JSON.stringify(result.duplicates) != '{}')) {
				const modal = new FoundDuplicateTasksModal(this.plugin.app, this.plugin, result.duplicates, result.taskIds);
				const resolved = await modal.showModal();
				
				if (!resolved) {
					log.warn('User cancelled duplicate resolution. Sync aborted.');
					new Notice('Sync aborted. Please fix duplicates manually in MetaData to prevent data corruption.', 10000);
					return;
				}
				
				// Re-fetch metadata after deletions if user chose to proceed
				newFilesToSync = await this.cacheOperation?.getFileMetadatas();
			}

		} catch (error) {
			log.error(error);
			new Notice(`Duplicate check failed:  ${Error}`, 5000);
			return;
		}


		//let's see if any files got killed while we weren't watching
		//TODO: Files deleted while we weren't looking is not handled right.
		log.debug('New Files: ', newFilesToSync);
		for (const fileKey in newFilesToSync) {
			const file = this.plugin.app.vault.getAbstractFileByPath(fileKey);
			if (!file) {
				log.debug('File ', fileKey, ' was deleted before last sync.');
				await this.cacheOperation?.deleteFilepathFromMetadata(fileKey);
				delete newFilesToSync[fileKey];
			}
		}

		//Now do the task checking.
		await doWithLock(LOCK_TASKS, async () => {
			for (const fileKey in newFilesToSync) {
				if (getSettings().debugMode) {
					log.debug(fileKey);
				}

				if (bForceUpdate) {
					try {
						await this.tickTickSync?.forceUpdates(fileKey);
					} catch (error) {
						log.error('An error occurred in forceUpdates:', error);
					}
				}

				try {
					await this.tickTickSync?.fullTextNewTaskCheck(fileKey);
				} catch (error) {
					log.error('An error occurred in fullTextNewTaskCheck:', error);
				}

				try {
					await this.tickTickSync?.fullTextModifiedTaskCheck(fileKey);
				} catch (error) {
					log.error('An error occurred in fullTextModifiedTaskCheck:', error);
				}

				try {
					await this.tickTickSync?.deletedTaskCheck(fileKey);
				} catch (error) {
					log.error('An error occurred in deletedTaskCheck:', error);
				}
			}
		});
	}
}
