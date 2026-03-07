<script lang="ts">
	import { getSettings, updateSettings } from '@/settings';
	import { settingsStore } from '@/ui/settings/settingsstore';
	import type TickTickSync from '@/main';
	import { Notice, Setting, TFolder } from 'obsidian';
	import { FolderSuggest } from '@/utils/FolderSuggester';
	import { onMount } from 'svelte';
	import { validateNewFolder } from '@/utils/FolderUtils';

	export let plugin: TickTickSync;

	let folderOptions: Record<string, string> = {};
	let isCheckingDatabase = false;

	async function handleManualSync() {
		if (!getSettings().token) {
			new Notice('Please log in from settings first');
			return;
		}
		try {
			await plugin.scheduledSynchronization();
			new Notice('Sync completed.');
		} catch (error) {
			new Notice(`An error occurred while syncing: ${error}`);
		}
	}

	let debounceTimeout: ReturnType<typeof setTimeout>;

	function searchFolder(element: HTMLElement) {
		const setting = new Setting(element)
			.addSearch((search) => {
				search.setPlaceholder('Select or Create folder')
					.setValue(getSettings().bkupFolder);
				search.setValue(folderOptions[getSettings().bkupFolder]);
				new FolderSuggest(search.inputEl, plugin.app);
				search.onChange((value) => {
					if (debounceTimeout) clearTimeout(debounceTimeout);

					debounceTimeout = setTimeout(async () => {
						const newFolder = await validateNewFolder(value, "Backup");
						if (newFolder) {
							updateSettings({ bkupFolder: newFolder });
							await plugin.saveSettings();
						}
					}, 700);

				});
			});
	}



	function getFolderOptions() {
		const folders = plugin.app.vault.getAllFolders(true);
		const folderOptions: Record<string, string> = {};
		for (const folder of folders) {
			folderOptions[folder.path] = folder.name;
		}
		return folderOptions;
	}

	async function handleCheckDatabase() {
		isCheckingDatabase = true;
		document.body.style.cursor = 'wait';
		try {
			await plugin.service.checkDataBase();
		} finally {
			isCheckingDatabase = false;
			document.body.style.cursor = '';
		}
	}

	onMount(async () => {
		folderOptions = getFolderOptions();
	});

</script>

<div class="manual-operations">
	{#if getSettings().token}
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Manual sync</div>
				<div class="setting-item-description">Manually perform a synchronization task</div>
			</div>
			<div class="setting-item-control">
				<button class="mod-cta" on:click={handleManualSync} disabled={isCheckingDatabase}>
					Sync
				</button>
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Check database</div>
				<div class="setting-item-description">
					Check for possible issues: sync error, file renaming not updated, or missed tasks not synchronized
				</div>
			</div>
			<div class="setting-item-control">
				<button
					class="mod-cta"
					on:click={handleCheckDatabase}
					disabled={isCheckingDatabase}>
					{isCheckingDatabase ? 'Checking...' : 'Check Database'}
				</button>
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Backup TickTick data</div>
				<div class="setting-item-description">
					Click to backup TickTick data. The backed-up files will be stored in the selected directory of the
					Obsidian vault
				</div>
			</div>
			<div class="setting-item-control">
				<button
					class="mod-cta"
					on:click={() => plugin.service.backup()}
					disabled={isCheckingDatabase}>
					Backup
				</button>
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Skip backup</div>
				<div class="setting-item-description">Skip backup on startup</div>
			</div>
			<div class="setting-item-control">
				<label class="checkbox-container" class:is-enabled={$settingsStore.skipBackup}>
					<input
						type="checkbox"
						checked={$settingsStore.skipBackup}
						on:change={async (e) => {
							updateSettings({ skipBackup: e.target.checked });
							await plugin.saveSettings();
						}}
					/>
				</label>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Backup folder</div>
				<div class="setting-item-description">Choose the folder to store the backup files.</div>
			</div>
			<div class="setting-item-control flex-container">
				<div
					class="modal-form remove-padding remove-border fix-suggest"
					use:searchFolder
				>
				</div>
			</div>

		</div>
	{/if}
</div>
