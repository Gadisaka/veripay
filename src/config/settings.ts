import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

/**
 * Global configuration held in the Setting table so an administrator can change
 * limits from /admin without a redeploy. Defaults apply until a row exists.
 */
export interface AppSettings {
    defaultMonthlyQuota: number;
    defaultRateLimitPerMinute: number;
    publicWidgetPerHour: number;
    batchMaxReferences: number;
    batchConcurrency: number;
    signupsEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
    defaultMonthlyQuota: 5000,
    defaultRateLimitPerMinute: 60,
    publicWidgetPerHour: 5,
    batchMaxReferences: 20,
    batchConcurrency: 5,
    signupsEnabled: true
};

export const SETTING_LABELS: Record<keyof AppSettings, string> = {
    defaultMonthlyQuota: 'Monthly verifications per account',
    defaultRateLimitPerMinute: 'Requests per minute per key',
    publicWidgetPerHour: 'Public widget checks per IP each hour',
    batchMaxReferences: 'Maximum references in one batch',
    batchConcurrency: 'Concurrent verifications inside a batch',
    signupsEnabled: 'Allow new accounts'
};

const CACHE_TTL_MS = 30_000;

let cache: AppSettings | null = null;
let cachedAt = 0;

export async function getSettings(): Promise<AppSettings> {
    if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

    try {
        const rows = await prisma.setting.findMany();
        const merged = { ...DEFAULT_SETTINGS };

        for (const row of rows) {
            if (row.key in merged) {
                (merged as Record<string, unknown>)[row.key] = row.value;
            }
        }

        cache = merged;
        cachedAt = Date.now();
        return merged;
    } catch (err) {
        logger.error('Failed to load settings, falling back to defaults:', err);
        return { ...DEFAULT_SETTINGS };
    }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const entries = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS);

    await prisma.$transaction(
        entries.map(([key, value]) =>
            prisma.setting.upsert({
                where: { key },
                create: { key, value: value as never },
                update: { value: value as never }
            })
        )
    );

    cache = null;
    return getSettings();
}
