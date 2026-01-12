import { App, type ListItemCache, Notice, TAbstractFile, TFile, TFolder } from 'obsidian';
import TickTickSync from '@/main';
import type { ITask } from '@/api/types/Task';
import type { IProject } from '@/api/types//Project';
import { FoundDuplicateListsModal } from '@/modals/FoundDuplicateListsModal';
import { getSettings, updateSettings, getDefaultFolder } from '@/settings';
//Logging
import log from '@/utils/logger';
import { FileMap } from '@/services/fileMap';
import { db } from "@/db/dexie";
import { upsertLocalTask } from "@/db/tasks";
import { getAllProjects, getProjectById } from "@/db/projects";
import { getAllFiles, getFile, upsertFile, deleteFile, updateFilePath as updateDbFilePath } from "@/db/files";
import type { DeletionItem } from '@/modals/TaskDeletionModal';


export interface FileMetadata {
	[fileName: string]: FileDetail;
}

export interface FileDetail {
	TickTickTasks: TaskDetail[];
	TickTickCount: number;
	defaultProjectId?: string;
}

export interface TaskDetail {
	taskId: string;
	taskItems: string[];
}

const FILE_EXT = '.md';

export class CacheOperation {
	app: App;
	plugin: TickTickSync;
	private taskCache: Map<string, ITask> | null = null;

	constructor(app: App, plugin: TickTickSync) {
		//super(app,settings);
		this.app = app;
		this.plugin = plugin;
	}

	async fillTaskCache() {
		try {
			const tasks = await db.tasks.toArray();
			this.taskCache = new Map(tasks.filter(lt => !!lt.taskId).map(lt => [lt.taskId, lt.task]));
		} catch (error) {
			log.error(`Error filling task cache: ${error}`);
		}
	}

	clearTaskCache() {
		this.taskCache = null;
	}

	async addTaskToMetadata(filepath: string, task: ITask) {
		// With Dexie-only processing, task file relationship is maintained in db.tasks.
		// upsertLocalTask already handles setting the file.
		// We still ensure the file exists in the files table.
		const file = await getFile(filepath);
		if (!file) {
			await upsertFile(filepath, task.projectId);
		}
	}

	async addTaskItemToMetadata(filepath: string, taskId: string, itemid: string, projectId: string) {
		// Task items are tracked via the iTask structure.
		// This method is now mostly a no-op as the task itself will be updated in Dexie.
	}

	//This removes an Item from the metadata, and from the task
	//assumes file metadata has been looked up.
	async removeTaskItem(fileMetaData: FileDetail, taskId: string, taskItemIds: string[], filepath?: string) {
		if (!fileMetaData) {
			return undefined;
		}
		const task = await this.loadTaskFromCacheID(taskId);
		if (!task || !task.items) {
			return undefined;
		}
		let taskItems = task.items;
		taskItemIds.forEach(taskItemId => {
			//delete from Task
			taskItems = taskItems.filter(item => item.id !== taskItemId);
		});
		task.items = taskItems;
		return await this.updateTaskToCache(task, filepath, Date.now());
	}


	async getFileMetadata(filepath: string, projectId?: string): Promise<FileDetail | undefined> {
		const file = await getFile(filepath);
		if (file) {
			const tasksInFile = await db.tasks.where("file").equals(filepath).toArray();
			return {
				TickTickTasks: tasksInFile.map(lt => ({
					taskId: lt.taskId,
					taskItems: lt.task.items?.map(i => i.id) || []
				})),
				TickTickCount: tasksInFile.length,
				defaultProjectId: file.defaultProjectId
			};
		}
		return await this.newEmptyFileMetadata(filepath, projectId);
	}

	async getFileMetadatas(): Promise<FileMetadata> {
		const files = await getAllFiles();
		const allTasks = await db.tasks.toArray();
		const tasksByFile = new Map<string, LocalTask[]>();
		for (const lt of allTasks) {
			if (lt.file) {
				if (!tasksByFile.has(lt.file)) tasksByFile.set(lt.file, []);
				tasksByFile.get(lt.file)!.push(lt);
			}
		}

		const metadata: FileMetadata = {};
		for (const file of files) {
			const tasksInFile = tasksByFile.get(file.path) || [];
			metadata[file.path] = {
				TickTickTasks: tasksInFile.map(lt => ({
					taskId: lt.taskId,
					taskItems: lt.task.items?.map(i => i.id) || []
				})),
				TickTickCount: tasksInFile.length,
				defaultProjectId: file.defaultProjectId
			};
		}
		return metadata;
	}

	async updateFileMetadata(filepath: string, newMetadata: FileDetail) {
		await upsertFile(filepath, newMetadata.defaultProjectId);
	}

	async deleteTaskIdFromMetadata(filepath: string, taskId: string) {
		// In Dexie-only mode, we just clear the file field of the task
		const lt = await db.tasks.where("taskId").equals(taskId).first();
		if (lt && lt.file === filepath) {
			await db.tasks.update(lt.localId, { file: "" });
		}
	}

	async updateTaskMetadata(task: ITask, filePath: string) {
		const lt = await db.tasks.where("taskId").equals(task.id).first();
		if (lt) {
			await db.tasks.update(lt.localId, { file: filePath });
		}
	}

	async deleteTaskIdFromMetadataByTaskId(taskId: string) {
		const lt = await db.tasks.where("taskId").equals(taskId).first();
		if (lt) {
			await db.tasks.update(lt.localId, { file: "" });
		}
	}

	//delete filepath from filemetadata
	async deleteFilepathFromMetadata(filepath: string): Promise<FileMetadata> {
		await deleteFile(filepath);
		// Also clear file field for all tasks in this file
		const lts = await db.tasks.where("file").equals(filepath).toArray();
		for (const lt of lts) {
			await db.tasks.update(lt.localId, { file: "" });
		}
		return await this.getFileMetadatas();
	}

	//Check for duplicates
	async checkForDuplicates(fileMetadata: FileMetadata) {
		if (!fileMetadata) {
			return;
		}

		const taskIds: Record<string, string> = {};
		let duplicates: Record<string, string[]> = {};

		for (const file in fileMetadata) {
			fileMetadata[file].TickTickTasks?.forEach(task => {
				if (!taskIds.hasOwnProperty(task.taskId)) {
					taskIds[task.taskId] = file;
					return;
				}
				if (!duplicates.hasOwnProperty(task.taskId)) {
					duplicates[task.taskId] = [];
				}
				duplicates[task.taskId].push(file);
			});
		}
		//This may be over-kill, but need it right now.
		await this.checkFilesForDuplicates(taskIds, duplicates);
		//Some day, may want to do something with all the taskIds?
		log.debug("Duplicates: ", duplicates);
		log.debug("TaskIds: ", taskIds);
		return { taskIds, duplicates };
	}


	async getDefaultProjectNameForFilepath(filepath: string) {
		// log.debug("Project Name Request: ", filepath);
		const file = await getFile(filepath);
		if (!file || file.defaultProjectId === undefined) {
			return getSettings().defaultProjectName;
		}

		const defaultProjectId = file.defaultProjectId;
		const projectName = await this.getProjectNameByIdFromCache(defaultProjectId);
		// log.debug("returning: " + projectName);
		return projectName;
	}

	async getDefaultProjectIdForFilepath(filepath: string) {
		const file = await getFile(filepath);
		if (!file || !file.defaultProjectId) {
			let defaultProjectId = getSettings().defaultProjectId;
			if (!defaultProjectId) {
				defaultProjectId = getSettings().inboxID;
			}
			return defaultProjectId;
		} else {
			let defaultProjectId = file.defaultProjectId;
			if (!defaultProjectId) {
				defaultProjectId = getSettings().inboxID;
			}
			return defaultProjectId;
		}
	}

	async filepathHasDefaultProjectID(filepath: string) {
		const file = await getFile(filepath);
		if (!file || file.defaultProjectId) {
			return true;
		} else {
			return false;
		}
	}


	async getFilepathForProjectId(projectId: string) {
		if ((projectId) ||  (projectId !== '')) {
			const files = await getAllFiles();

			//If this project is set as a default for a file, return that file.
			for (const file of files) {
				if (file.defaultProjectId === projectId) {
					return file.path;
				}
			}

			//If the project is the inbox, return the inbox or default project file. (It may not have been created)
			if ((projectId === getSettings().inboxID) ||
				(projectId === getSettings().defaultProjectId)) { //highly unlikely, but just in case
				//They don't have a file for the Inbox. If they have a default project, return that.
				if (getSettings().defaultProjectName) {
					return getDefaultFolder() +"/"+ getSettings().defaultProjectName + ".md"
				}
			}

			//otherwise, return the project name as a md file and hope for the best.
			const filePath = await this.getProjectNameByIdFromCache(projectId/*, getSettings().keepProjectFolders*/);
			if (filePath) {
				return getDefaultFolder() +"/"+ filePath + FILE_EXT;
			} else {
				//Not a file that's in fileMetaData, not the inbox no default project set
				const errmsg = `File path not found for ${projectId}, returning ${filePath} instead.`;
				log.warn(errmsg);
				throw new Error(errmsg);
			}
		} else {
			if (getSettings().defaultProjectName) {
				return getDefaultFolder() + "/" + getSettings().defaultProjectName + FILE_EXT;
			} else {
				return getDefaultFolder() + "/" + "Inbox" + FILE_EXT;
			}
		}
	}

	async setDefaultProjectIdForFilepath(filepath: string, defaultProjectId: string) {
		await upsertFile(filepath, defaultProjectId);
	}

	//Read all tasks from Cache
	async loadTasksFromCache() {
		try {
			const lts = await db.tasks.toArray();
			return lts.map(lt => lt.task);
		} catch (error) {
			log.error(`Error loading tasks from Cache: ${error}`);
			return [];
		}
	}

	// Overwrite and save all tasks to cache
	async saveTasksToCache(newTasks: ITask[]) {
		try {
			// This is tricky because we might lose LocalTask metadata.
			// But usually this is called after a full sync.
			const meta = await db.meta.get("sync");
			const deviceId = meta?.deviceId || "unknown";
			
			const tasksToPut = [];
			for (const t of newTasks) {
				tasksToPut.push({
					localId: `tt:${t.id}`,
					taskId: t.id,
					task: t,
					updatedAt: Date.now(),
					lastModifiedByDeviceId: deviceId,
					file: await this.getFilepathForTask(t.id) || "",
					source: "ticktick" as const,
					deleted: t.deleted === 1
				});
			}
			
			await db.tasks.bulkPut(tasksToPut);
		} catch (error) {
			log.error(`Error saving tasks to Cache: ${error}`);
			return false;
		}
	}

	//Append to Cache file
	async appendTaskToCache(task: ITask, filePath: string, lastVaultSync?: number) {
		try {
			if (task === null) {
				return;
			}
			const meta = await db.meta.get("sync");
			task.title = this.plugin.taskParser.stripOBSUrl(task.title);
			
			await upsertLocalTask(task, {
				file: filePath,
				deviceId: meta?.deviceId || "unknown",
				source: "ticktick",
				lastVaultSync: lastVaultSync
			});

		} catch (error) {
			log.error(`Error appending task to Cache: ${error}`);
		}
	}

	//Read the task with the specified id
	async loadTaskFromCacheID(taskId?: string): Promise<ITask | undefined> {
		if (!taskId) return undefined;
		if (this.taskCache) {
			return this.taskCache.get(taskId);
		}
		try {
			const lt = await db.tasks.where("taskId").equals(taskId).first();
			return lt?.task;
		} catch (error) {
			log.error(`Error finding task from Cache:`, error);
		}
		return undefined;
	}

	async loadLocalTaskFromCacheID(taskId?: string): Promise<LocalTask | undefined> {
		if (!taskId) return undefined;
		try {
			return await db.tasks.where("taskId").equals(taskId).first();
		} catch (error) {
			log.error(`Error finding local task from Cache:`, error);
		}
		return undefined;
	}

	//get Task titles
	async getTaskTitles(taskIds: string []): Promise<string []> {
		const lts = await db.tasks.where("taskId").anyOf(taskIds).toArray();
		let titles = lts.map(lt => lt.task.title);
		titles = titles.map((task: string) => {
			return this.plugin.taskParser.stripOBSUrl(task);
		});

		return titles;
	}

	async getDeletionItems(taskIds: string[]): Promise<DeletionItem[]> {
		const lts = await db.tasks.where("taskId").anyOf(taskIds).toArray();
		return lts.map(lt => ({
			title: this.plugin.taskParser.stripOBSUrl(lt.task.title),
			filePath: lt.file
		}));
	}

	//Overwrite the task with the specified id in update
	async updateTaskToCache(task: ITask, movedPath: string | null = null, lastVaultSync?: number) {
		try {
			let filePath: string | null = '';
			if (!movedPath) {
				filePath = await this.getFilepathForTask(task.id);
				if (!filePath) {
					filePath = await this.getFilepathForProjectId(task.projectId);
				}
				if (!filePath) {
					//we're not likely to get here, but just in case
					throw new Error(`File not found for ${task.id} - ${task.title}`);
				}
			} else {
				filePath = movedPath;
			}

			//Assume that dateHolder has been handled before this.
			//Delete the existing task
			await this.deleteTaskFromCache(task.id);
			//Add new task
			await this.appendTaskToCache(task, filePath, lastVaultSync);
			return task;
		} catch (error) {
			log.error(`Error updating task to Cache: ${error}`);
			return [];
		}
	}

	async getFilepathForTask(taskId: string) {
		const lt = await db.tasks.where("taskId").equals(taskId).first();
		return lt?.file || null;
	}



	async getProjectIdForTask(taskId: string) {
		const lt = await db.tasks.where("taskId").equals(taskId).first();
		return lt?.task.projectId;
	}

	//open a task status
	async reopenTaskToCacheByID(taskId: string): Promise<string> {
		try {
			const lt = await db.tasks.where("taskId").equals(taskId).first();
			if (lt) {
				lt.task.status = 0;
				lt.updatedAt = Date.now();
				lt.lastModifiedByDeviceId = getSettings().deviceId;
				await db.tasks.put(lt);
				return lt.task.projectId;
			}
			return "";
		} catch (error) {
			log.error(`Error open task to Cache file: ${error}`);
			throw error; // Throw an error so that the caller can catch and handle it
		}
	}

	//The structure of due {date: "2025-02-25",isRecurring: false,lang: "en",string: "2025-02-25"}


	// modifyTaskToCacheByID(taskId: string, { content, due }: { content?: string, due?: Due }): void {
	// try {
	// const savedTasks = this.plugin.settings.TickTickTasksData.tasks;
	// const taskIndex = savedTasks.findIndex((task) => task.id === taskId);

	// if (taskIndex !== -1) {
	// const updatedTask = { ...savedTasks[taskIndex] };

	// if (content !== undefined) {
	// updatedTask.content = content;
	// }

	// if (due !== undefined) {
	// if (due === null) {
	// updatedTask.due = null;
	// } else {
	// updatedTask.due = due;
	// }
	// }

	// savedTasks[taskIndex] = updatedTask;

	// this.plugin.settings.TickTickTasksData.tasks = savedTasks;
	// } else {
	// throw new Error(`Task with ID ${taskId} not found in cache.`);
	// }
	// } catch (error) {
	// // Handle the error appropriately, eg by logging it or re-throwing it.
	// }
	// }

	//close a task status
	async closeTaskToCacheByID(taskId: string): Promise<string> {
		try {
			const lt = await db.tasks.where("taskId").equals(taskId).first();
			if (lt) {
				lt.task.status = 2;
				lt.updatedAt = Date.now();
				lt.lastModifiedByDeviceId = getSettings().deviceId;
				await db.tasks.put(lt);
				return lt.task.projectId;
			}
			return "";
		} catch (error) {
			log.error(`Error close task to Cache file: ${error}`);
			throw error; // Throw an error so that the caller can catch and handle it
		}
	}

	//Delete task by ID
	async deleteTaskFromCache(taskId: string) {
		try {
			await db.tasks.where("taskId").equals(taskId).delete();
			//Also clean up meta data
			await this.deleteTaskIdFromMetadataByTaskId(taskId);
		} catch (error) {
			log.error(`Error deleting task from Cache file: ${error}`);
		}
	}

	//Delete task through ID array
	async deleteTaskFromCacheByIDs(deletedTaskIds: string[]) {
		try {
			await db.tasks.where("taskId").anyOf(deletedTaskIds).delete();
			//clean up file meta data
			for (const taskId of deletedTaskIds) {
				await this.deleteTaskIdFromMetadataByTaskId(taskId);
			}

		} catch (error) {
			log.error(`Error deleting task from Cache : ${error}`);
		}
	}

	//Find project id by name
	async getProjectIdByNameFromCache(projectName: string) {
		try {
			const savedProjects = await getAllProjects();
			const targetProject = savedProjects.find((obj: IProject) => obj.name.toLowerCase() === projectName.toLowerCase());
			const projectId = targetProject ? targetProject.id : null;
			return (projectId);
		} catch (error) {
			log.error(`Error finding project ${projectName} from Cache file: ${error}`);
			return (false);
		}
	}

	async getProjectNameByIdFromCache(projectId: string /*, addFolder: boolean = false*/): Promise<string | undefined> {
		try {
			if (!projectId) {
				return getSettings().defaultProjectName;
			}
			const targetProject = await getProjectById(projectId);
			if (!targetProject) return undefined;
			// if (addFolder) {
			// 	const groupName = getProjectGroups().find(g => g.id == targetProject.groupId)?.name;
			// 	if (groupName) return groupName + '/' + targetProject.name;
			// }
			return targetProject.name;
		} catch (error) {
			log.error(`Error finding project ${projectId} from Cache file: ${error}`);
		}
		return undefined;
	}

	//save projects data to json file
	async saveProjectsToCache(projects: IProject[]) {
		try {
			const inboxProject = {
				id: getSettings().inboxID,
				name: getSettings().inboxName
			} as IProject;
			projects.push(inboxProject);

			//TODO: this really need?
			const duplicates = projects.reduce((acc, obj, index, arr) => {
				const duplicateIndex = arr.findIndex(item => item.name === obj.name && item.id !== obj.id);
				if (duplicateIndex !== -1 && !acc.includes(obj)) {
					acc.push(obj);
				}
				return acc;
			}, [] as IProject[]);
			const sortedDuplicates = duplicates.sort((a, b) => a.name.localeCompare(b.name));
			if (sortedDuplicates.length > 0) {
				const dupList = sortedDuplicates.map(thing => `${thing.id} ${thing.name}`);
				log.debug('Found duplicate lists: ', dupList);
				await this.showFoundDuplicatesModal(this.app, this.plugin, sortedDuplicates);
				return false;
			}

			//Check for List renames.
			for (const project of projects) {
				await this.checkProjectRename(project.id, project.name)
			}
			
			//save to Dexie
			const localProjects = projects.map(p => ({ id: p.id, project: p }));
			await db.projects.bulkPut(localProjects);
			
			return true;

		} catch (error) {
			log.error('Error on save projects: ', error);
			new Notice(`error on save projects: ${error}`);
		}
		return false;
	}

	async updateRenamedFilePath(oldpath: string, newpath: string) {
		try {
			// update path in db.tasks
			const lts = await db.tasks.where("file").equals(oldpath).toArray();
			for (const lt of lts) {
				await db.tasks.update(lt.localId, { file: newpath });
			}

			// update path in db.files
			await updateDbFilePath(oldpath, newpath);

		} catch (error) {
			log.error(`Error updating renamed file path to cache: ${error}`);
		}
	}

	// // TODO: why did I think I needed this?
	// findTaskInMetada(taskId: string, filePath: string) {
	// 	const fileMetadata = getSettings().fileMetadata;
	// 	for (const file in fileMetadata) {
	// 		log.debug('in file: :', file);
	// 		if (file == filePath) {
	// 			log.debug('breaking');
	// 			continue;
	// 		}
	// 		const tasks = fileMetadata[file].TickTickTasks;
	// 		for (const task of tasks) {
	// 			if (task.taskId === taskId) {
	// 				log.debug('found');
	// 				return true;
	// 			}
	// 		}
	// 	}
	// 	log.debug('not found');
	// 	return false;
	// }

	protected async newEmptyFileMetadata(filepath: string, projectId?: string): Promise<FileDetail | undefined> {
		//There's a case where we are making an entry for an undefined file. Not sure where it's coming from
		// this should give us a clue.

		if (filepath instanceof TAbstractFile) {
			if (filepath instanceof TFile) {
				filepath = filepath.name;
			}
		}

		if (!filepath) {
			log.error('Attempt to create undefined FileMetaData Entry: ', filepath);
			return undefined;
		}
		const file = this.app.vault.getAbstractFileByPath(filepath);
		if (file instanceof TFolder) {
			log.error('Not adding ', filepath, ' to Metadata because it\'s a folder.');
			return undefined;
		}
		
		await upsertFile(filepath, projectId);
		return await this.getFileMetadata(filepath, projectId);
	}

	private async findInFile(file: TFile, listItemsCache: ListItemCache[]) {
		const fileCachedContent: string = await this.app.vault.cachedRead(file);
		const lines: string[] = fileCachedContent.split('\n');

		const tasks: (string | null | undefined)[] = listItemsCache
			// Get the position of each list item
			.map((listItemCache: ListItemCache) => listItemCache.position.start.line)
			// Get the line
			.map((idx) => lines[idx])
			// Create a Task from the line
			.map((line: string) => this.plugin.taskParser.getTickTickId(line))
			// Filter out the nulls
			.filter((taskId: string | null) => taskId !== null)
		;

		return tasks;
	}

	private async showFoundDuplicatesModal(app, plugin, projects: IProject[]) {
		const myModal = new FoundDuplicateListsModal(app, plugin, projects, (result) => {
			const ret = result;
		});
		return await myModal.showModal();
	}

	/**
	 * Ensure files associated with the given project have correct filenames and metadata keys.
	 * If a file is found for the project but the key does not match the current project name,
	 * rename both the file on disk and the metadata key.
	 * @param ttProjectId The current project's ID.
	 * @param ttProjectName The current project's name.
	 */
	async checkProjectRename(ttProjectId: string, ttProjectName: string): Promise<void> {
		const fileMetadata = await this.getFileMetadatas();
		if (!fileMetadata) return;
		const projects = await getAllProjects();
		if (!projects || Object.keys(projects).length == 0) return;

		const project = projects.find(p => p.id === ttProjectId);
		if (!project) return; //it's a new project, move on.
		if (project?.name !== ttProjectName) {
			log.debug(`Project Name Changed from ${project?.name} to ${ttProjectName}`)
			const currentProjectPath = await this.getFilepathForProjectId(ttProjectId);

			const correctFileName = `${getDefaultFolder()}/${ttProjectName}.md`;
			log.debug(`Checking project rename for ${ttProjectName}, which could be ${correctFileName}`);

			if (currentProjectPath !== correctFileName) {
				log.debug(`Current project path is ${currentProjectPath}, which is not ${correctFileName}`);
				const vaultFile = this.app.vault.getAbstractFileByPath(currentProjectPath);
				if (vaultFile && vaultFile instanceof TFile) {
					log.debug(`Renaming ${currentProjectPath} to ${correctFileName}`);
					await this.app.vault.rename(vaultFile, correctFileName);
					log.debug(`Updating metadata key for ${currentProjectPath} to ${correctFileName}  === \n ${fileMetadata[currentProjectPath]}`);
					await this.updateFileMetadata(correctFileName, fileMetadata[currentProjectPath]);
					log.debug(`Deleting ${currentProjectPath} from metadata`);
					await this.deleteFilepathFromMetadata(currentProjectPath);
				}
			}
		}
	}

	private async checkFilesForDuplicates(taskIds: Record<string, string>, duplicates: Record<string, string[]>) {
		const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
		const settings = getSettings();
		const otherduplicates: Record<string, string[]> = {};
		for (const file of markdownFiles) {
			try {
				const fileMap = new FileMap(this.plugin.app, this.plugin, file);
				await fileMap.init();

				if (fileMap.hasTasks(settings.enableFullVaultSync)) {
					const foundTaskIds = fileMap.getTasks();
					foundTaskIds.forEach(taskId => {
						if (!otherduplicates.hasOwnProperty(taskId)) {
							otherduplicates[taskId] = [];
						}
						otherduplicates[taskId].push(file.path);
					});
				}
			} catch (e) {
				log.error(`Failed to process file ${file.path}`, e);
			}
		}

		for (const taskId in otherduplicates) {
			const paths = otherduplicates[taskId];
			if (paths.length > 1) {
				if (!taskIds.hasOwnProperty(taskId)) {
					taskIds[taskId] = paths[0];
					duplicates[taskId] = paths.slice(1);
				} else {
					if (!duplicates.hasOwnProperty(taskId)) {
						duplicates[taskId] = [];
					}
					paths.forEach(path => {
						if (path !== taskIds[taskId] && !duplicates[taskId].includes(path)) {
							duplicates[taskId].push(path);
						}
					});
				}
			}
		}

		log.debug("Other Duplicates: ", otherduplicates);
		return duplicates;
	}
}
