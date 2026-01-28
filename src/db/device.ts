import { Platform } from 'obsidian';
import type { DeviceInfo } from '@/settings';

let currentDeviceInfo: DeviceInfo | null = null;

export function generateDeviceId(): string {
	return crypto.randomUUID();
}

/**
 * Get current device info from memory (loaded from DB)
 */
export function getCurrentDeviceInfo(): DeviceInfo | null {
	return currentDeviceInfo;
}

/**
 * Set current device info in memory (should be called when loading from DB)
 */
export function setCurrentDeviceInfo(info: DeviceInfo): void {
	currentDeviceInfo = info;
}

export async function detectDeviceLabel(): Promise<string> {
	if (currentDeviceInfo?.deviceLabel && currentDeviceInfo.deviceLabel.length > 0) {
		return currentDeviceInfo.deviceLabel;
	}

	if (Platform.isDesktopApp) {
		return (
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			require("os").hostname() ||
			(Platform.isMacOS
				? "Mac"
				: Platform.isWin
					? "Windows"
					: Platform.isLinux
						? "Linux"
						: "Desktop")
		);
	} else {
		try {
			// Use the global Capacitor object if available in the Obsidian mobile environment
			const devicePlugin = (window as any).Capacitor?.Plugins?.Device;
			if (devicePlugin) {
				const info = await devicePlugin.getInfo();
				return info?.name || 'Mobile Device';
			}
		} catch (e) {
			console.error("Failed to get device info via Capacitor", e);
		}

		return "Mobile Device";
	}

}
