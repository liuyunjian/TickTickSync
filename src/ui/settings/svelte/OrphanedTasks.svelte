<script lang="ts">
	import type TickTickSync from '@/main';
	import { getSettings, updateSettings } from '@/settings';

	export let plugin: TickTickSync;

	let orphanedTasks = getSettings().orphanedTasks || [];

	function openTaskFile(path: string) {
		plugin.app.workspace.openLinkText(path, '');
	}

	async function clearOrphanedTasks() {
		orphanedTasks = [];
		updateSettings({ orphanedTasks });
		await plugin.saveSettings();
	}

</script>

<div class="orphaned-tasks">
	<h3>Orphaned Tasks</h3>
	<p>These tasks were found in your Obsidian vault but could not be located in your local TickTick cache or on the TickTick server.</p>
	
	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Clear list</div>
			<div class="setting-item-description">Remove all items from this list. This will NOT delete the actual tasks in your notes.</div>
		</div>
		<div class="setting-item-control">
			<button class="mod-warning" on:click={clearOrphanedTasks} disabled={orphanedTasks.length === 0}>
				Clear All
			</button>
		</div>
	</div>

	{#if orphanedTasks.length === 0}
		<div class="empty-state">
			<p>No orphaned tasks found.</p>
		</div>
	{:else}
		<ul class="task-list">
			{#each orphanedTasks as task (task.taskId)}
				<li class="task-item">
					<div class="task-info">
						<strong>{task.title || "Untitled Task"}</strong>
						<div class="task-path">{task.path}</div>
					</div>
					<button class="mod-cta" on:click={() => openTaskFile(task.path)}>
						Go to File
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.orphaned-tasks h3 {
		margin-top: 0;
	}
	.empty-state {
		padding: 2em;
		text-align: center;
		color: var(--text-muted);
		background-color: var(--background-secondary);
		border-radius: 8px;
		margin-top: 1em;
	}
	.task-list {
		list-style: none;
		padding: 0;
		margin: 1em 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		overflow: hidden;
	}
	.task-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.task-item:last-child {
		border-bottom: none;
	}
	.task-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.task-path {
		font-size: 0.8em;
		color: var(--text-muted);
	}
</style>
