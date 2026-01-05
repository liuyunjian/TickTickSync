import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pullFromTickTick } from '../sync/pull';
import { db } from '../db/dexie';

// Mock the dependencies
vi.mock('../db/dexie', () => ({
	db: {
		tasks: {
			get: vi.fn(),
			put: vi.fn(),
			update: vi.fn(),
			where: vi.fn(),
		},
		meta: {
			update: vi.fn(),
		},
	},
}));

vi.mock('../sync/journal', () => ({
	logSyncEvent: vi.fn(),
}));

vi.mock('loglevel', () => ({
	default: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock('../sync/conflicts', () => ({
	resolveTaskConflict: vi.fn((local, remote) => remote), // Default to remote for testing
}));

describe('pullFromTickTick field mapping and echo detection', () => {
	const mockApi = {
		getUpdatedTasks: vi.fn(),
		checkpoint: 123456789,
	} as any;

	const mockMeta = {
		deviceId: 'test-device',
		lastFullSync: 0,
		lastDeltaSync: 0,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should correctly map modifiedTime to updatedAt and use "ticktick" as default deviceId', async () => {
		const now = new Date();
		const modifiedTimeString = now.toISOString();
		const expectedTimestamp = now.getTime();

		const remoteTask = {
			id: 'remote-task-id',
			modifiedTime: modifiedTimeString,
			deleted: 0,
		} as any;

		mockApi.getUpdatedTasks.mockResolvedValue({ update: [remoteTask], delete: [] });

		// Mock where("taskId").equals(...).first()
		const mockFirst = vi.fn().mockResolvedValue(undefined);
		const mockEquals = vi.fn().mockReturnValue({ first: mockFirst });
		const mockWhere = vi.fn().mockReturnValue({ equals: mockEquals });
		(db.tasks.where as any) = mockWhere;

		await pullFromTickTick(mockApi, mockMeta, false);

		expect(db.tasks.put).toHaveBeenCalledWith(expect.objectContaining({
			updatedAt: expectedTimestamp,
			lastModifiedByDeviceId: 'ticktick'
		}));
	});

	it('should ignore echoes (when remote task was originally sent by us)', async () => {
		const now = new Date();
		const modifiedTimeString = now.toISOString();
		const timestamp = now.getTime();

		const remoteTask = {
			id: 'remote-task-id',
			modifiedTime: modifiedTimeString,
			deleted: 0,
		} as any;

		mockApi.getUpdatedTasks.mockResolvedValue({ update: [remoteTask], delete: [] });

		// Local task says it was modified by us at the SAME time or newer
		const localTask = {
			localId: 'local-uuid',
			taskId: 'remote-task-id',
			updatedAt: timestamp,
			lastModifiedByDeviceId: 'test-device', // matches mockMeta.deviceId
		};

		const mockFirst = vi.fn().mockResolvedValue(localTask);
		const mockEquals = vi.fn().mockReturnValue({ first: mockFirst });
		const mockWhere = vi.fn().mockReturnValue({ equals: mockEquals });
		(db.tasks.where as any) = mockWhere;

		const applied = await pullFromTickTick(mockApi, mockMeta, false);

		expect(applied).toBe(0);
		expect(db.tasks.put).not.toHaveBeenCalled();
	});
});
