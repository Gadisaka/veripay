import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApiKey, User } from '@prisma/client';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { hashKey } from '../services/apiKeys';
import { getSettings } from '../config/settings';
import { checkRateLimit } from './rateLimit';
import { clientIp, consumeQuota, getQuotaUsed, nextPeriodStart, recordUsage } from '../services/usage';

/**
 * Authenticates verification requests against keys issued from the dashboard.
 *
 * The key travels in `x-veripay-key` rather than `x-api-key`, because the CBE
 * Birr routes already use `x-api-key` for a different purpose: that value is
 * forwarded upstream as the caller's CBE Birr bearer token.
 *
 * VERIPAY_API_KEYS still works as a set of system keys for internal calls.
 * Those bypass quota accounting since they belong to no account.
 */
export const API_KEY_HEADER = 'x-veripay-key';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            apiKeyRecord?: ApiKey & { user: User };
            isSystemKey?: boolean;
        }
    }
}

let systemDigests: Buffer[] | null = null;

function getSystemKeyDigests(): Buffer[] {
    if (systemDigests) return systemDigests;

    systemDigests = (process.env.VERIPAY_API_KEYS || '')
        .split(',')
        .map(key => key.trim())
        .filter(Boolean)
        .map(key => crypto.createHash('sha256').update(key).digest());

    return systemDigests;
}

function isSystemKey(candidate: string): boolean {
    const digest = crypto.createHash('sha256').update(candidate).digest();
    return getSystemKeyDigests().some(known => crypto.timingSafeEqual(digest, known));
}

function extractKey(req: Request): string | null {
    const header = req.header(API_KEY_HEADER)?.trim();
    if (header) return header;

    const bearer = req.header('authorization')?.trim();
    if (bearer?.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();

    return null;
}

/**
 * Logs the request once the response is sent and charges the caller's monthly
 * quota. Server-side failures are logged but not charged.
 */
function attachAccounting(req: Request, res: Response, startedAt: number): void {
    res.on('finish', () => {
        const record = req.apiKeyRecord;

        recordUsage({
            apiKeyId: record?.id ?? null,
            userId: record?.userId ?? null,
            endpoint: req.baseUrl + (req.route?.path === '/' ? '' : req.path),
            method: req.method,
            statusCode: res.statusCode,
            responseTime: Date.now() - startedAt,
            ip: clientIp(req as never),
            source: 'API'
        });

        if (!record || res.statusCode >= 500 || res.statusCode === 429) return;

        void consumeQuota(record.userId).catch(err => logger.error('Failed to record quota usage:', err));

        void prisma.apiKey
            .update({
                where: { id: record.id },
                data: { lastUsedAt: new Date(), usageCount: { increment: 1 } }
            })
            .catch(err => logger.error('Failed to update key usage:', err));
    });
}

export const apiKeyAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startedAt = Date.now();
    const provided = extractKey(req);

    if (!provided) {
        res.status(401).json({
            success: false,
            error: `Missing API key. Send it in the ${API_KEY_HEADER} header. Create one at /dashboard/keys.`
        });
        return;
    }

    if (isSystemKey(provided)) {
        req.isSystemKey = true;
        attachAccounting(req, res, startedAt);
        next();
        return;
    }

    let record;
    try {
        record = await prisma.apiKey.findUnique({
            where: { keyHash: hashKey(provided) },
            include: { user: true }
        });
    } catch (err) {
        logger.error('Failed to look up API key:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
        return;
    }

    if (!record || !record.isActive) {
        logger.warn(`Rejected request with unknown API key from ${clientIp(req as never)}`);
        res.status(403).json({ success: false, error: 'Invalid or revoked API key.' });
        return;
    }

    if (record.user.status === 'SUSPENDED') {
        res.status(403).json({ success: false, error: 'This account has been suspended.' });
        return;
    }

    const settings = await getSettings();

    const perMinute = record.user.rateLimitPerMinute ?? settings.defaultRateLimitPerMinute;
    const rate = checkRateLimit(`key:${record.id}`, perMinute);

    res.setHeader('X-RateLimit-Limit', String(perMinute));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rate.remaining)));

    if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        res.status(429).json({
            success: false,
            error: `Rate limit of ${perMinute} requests per minute exceeded. Retry in ${rate.retryAfterSeconds}s.`
        });
        return;
    }

    const quota = record.user.monthlyQuota ?? settings.defaultMonthlyQuota;

    if (quota > 0) {
        const used = await getQuotaUsed(record.userId);

        res.setHeader('X-Quota-Limit', String(quota));
        res.setHeader('X-Quota-Remaining', String(Math.max(0, quota - used)));

        if (used >= quota) {
            const resetsAt = nextPeriodStart().toISOString();
            res.status(429).json({
                success: false,
                error: `Monthly quota of ${quota} verifications reached. It resets on ${resetsAt.slice(0, 10)}.`,
                quota: { limit: quota, used, resetsAt }
            });
            return;
        }
    }

    req.apiKeyRecord = record;
    attachAccounting(req, res, startedAt);
    next();
};

/**
 * Receipt-image verification is restricted to API keys owned by ADMIN accounts.
 * System keys (VERIPAY_API_KEYS) are not enough — they are not tied to an admin user.
 */
export const requireAdminApiKey = (req: Request, res: Response, next: NextFunction): void => {
    if (req.isSystemKey) {
        res.status(403).json({
            success: false,
            error: 'Image verification requires an API key issued to an administrator account.'
        });
        return;
    }

    if (!req.apiKeyRecord || req.apiKeyRecord.user.role !== 'ADMIN') {
        res.status(403).json({
            success: false,
            error: 'Image verification is restricted to administrator API keys.'
        });
        return;
    }

    next();
};
