import { UsageSource } from '@prisma/client';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export function currentPeriodStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextPeriodStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0]!.trim().slice(0, 64);
    }
    return (req.socket?.remoteAddress ?? 'unknown').slice(0, 64);
}

interface RecordUsageInput {
    apiKeyId?: string | null;
    userId?: string | null;
    endpoint: string;
    method: string;
    statusCode: number;
    responseTime: number;
    provider?: string | null;
    ip: string;
    source?: UsageSource;
}

/** Fire-and-forget: usage accounting must never fail a verification. */
export function recordUsage(input: RecordUsageInput): void {
    void prisma.usageLog
        .create({
            data: {
                apiKeyId: input.apiKeyId ?? null,
                userId: input.userId ?? null,
                endpoint: input.endpoint.slice(0, 190),
                method: input.method.slice(0, 10),
                statusCode: input.statusCode,
                responseTime: input.responseTime,
                provider: input.provider?.slice(0, 32) ?? null,
                ip: input.ip,
                source: input.source ?? 'API'
            }
        })
        .catch(err => logger.error('Failed to write usage log:', err));
}

/**
 * Increments the monthly counter and returns the new total. Uses an upsert so
 * the first call of a month creates the row without a race.
 */
export async function consumeQuota(userId: string, amount = 1): Promise<number> {
    const periodStart = currentPeriodStart();

    const counter = await prisma.usageCounter.upsert({
        where: { userId_periodStart: { userId, periodStart } },
        create: { userId, periodStart, count: amount },
        update: { count: { increment: amount } }
    });

    return counter.count;
}

export async function getQuotaUsed(userId: string): Promise<number> {
    const counter = await prisma.usageCounter.findUnique({
        where: { userId_periodStart: { userId, periodStart: currentPeriodStart() } }
    });

    return counter?.count ?? 0;
}

export interface DailyPoint {
    date: string;
    total: number;
    failed: number;
}

/** Per-day request counts for the last `days` days, zero-filled. */
export async function getDailyUsage(userId: string | null, days = 30): Promise<DailyPoint[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const rows = await prisma.usageLog.findMany({
        where: {
            createdAt: { gte: since },
            ...(userId ? { userId } : {})
        },
        select: { createdAt: true, statusCode: true }
    });

    const buckets = new Map<string, DailyPoint>();
    for (let i = 0; i < days; i++) {
        const day = new Date(since);
        day.setUTCDate(since.getUTCDate() + i);
        const key = day.toISOString().slice(0, 10);
        buckets.set(key, { date: key, total: 0, failed: 0 });
    }

    for (const row of rows) {
        const key = row.createdAt.toISOString().slice(0, 10);
        const bucket = buckets.get(key);
        if (!bucket) continue;
        bucket.total += 1;
        if (row.statusCode >= 400) bucket.failed += 1;
    }

    return [...buckets.values()];
}

export interface UsageSummary {
    total: number;
    succeeded: number;
    failed: number;
    avgResponseTime: number;
}

export async function getUsageSummary(userId: string | null, sinceDays = 30): Promise<UsageSummary> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const where = { createdAt: { gte: since }, ...(userId ? { userId } : {}) };

    const [total, failed, aggregate] = await Promise.all([
        prisma.usageLog.count({ where }),
        prisma.usageLog.count({ where: { ...where, statusCode: { gte: 400 } } }),
        prisma.usageLog.aggregate({ where, _avg: { responseTime: true } })
    ]);

    return {
        total,
        succeeded: total - failed,
        failed,
        avgResponseTime: Math.round(aggregate._avg.responseTime ?? 0)
    };
}
