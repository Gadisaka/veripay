import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../auth/session';
import { createApiKey, listApiKeys, revokeApiKey, MAX_KEYS_PER_USER } from '../services/apiKeys';
import { getSettings } from '../config/settings';
import {
    clientIp,
    consumeQuota,
    getDailyUsage,
    getQuotaUsed,
    getUsageSummary,
    nextPeriodStart,
    recordUsage
} from '../services/usage';
import { runSmartVerify } from '../services/verifyUniversal';
import { checkRateLimit } from '../middleware/rateLimit';
import logger from '../utils/logger';

const router = Router();

router.use(requireAuth);

async function quotaView(userId: string, override: number | null) {
    const settings = await getSettings();
    const limit = override ?? settings.defaultMonthlyQuota;
    const used = await getQuotaUsed(userId);

    return {
        limit,
        used,
        remaining: limit > 0 ? Math.max(0, limit - used) : null,
        percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        resetsAt: nextPeriodStart()
    };
}

router.get('/', async (req: Request, res: Response) => {
    const user = req.currentUser!;
    const settings = await getSettings();

    const [quota, summary, daily, keys, recent] = await Promise.all([
        quotaView(user.id, user.monthlyQuota),
        getUsageSummary(user.id, 30),
        getDailyUsage(user.id, 30),
        listApiKeys(user.id),
        prisma.usageLog.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 10
        })
    ]);

    res.render('dashboard/index', {
        title: 'Dashboard — Veripay',
        active: 'dashboard',
        section: 'overview',
        quota,
        summary,
        daily,
        keys: keys.filter(key => key.isActive),
        recent,
        rateLimit: user.rateLimitPerMinute ?? settings.defaultRateLimitPerMinute
    });
});

router.get('/keys', async (req: Request, res: Response) => {
    const user = req.currentUser!;

    res.render('dashboard/keys', {
        title: 'API keys — Veripay',
        active: 'dashboard',
        section: 'keys',
        keys: await listApiKeys(user.id),
        newKey: null,
        error: null,
        maxKeys: MAX_KEYS_PER_USER
    });
});

router.post('/keys', async (req: Request, res: Response) => {
    const user = req.currentUser!;
    const name = typeof req.body.name === 'string' ? req.body.name : '';

    let newKey: string | null = null;
    let error: string | null = null;

    try {
        const created = await createApiKey(user.id, name);
        newKey = created.rawKey;
        logger.info(`API key created for ${user.email}`);
    } catch (err) {
        error = err instanceof Error ? err.message : 'Could not create the key.';
    }

    // Rendered rather than redirected so the raw key never appears in a URL.
    res.render('dashboard/keys', {
        title: 'API keys — Veripay',
        active: 'dashboard',
        section: 'keys',
        keys: await listApiKeys(user.id),
        newKey,
        error,
        maxKeys: MAX_KEYS_PER_USER
    });
});

router.post('/keys/:id/revoke', async (req: Request, res: Response) => {
    const user = req.currentUser!;
    const keyId = String(req.params.id ?? '');
    const revoked = await revokeApiKey(user.id, keyId);

    if (revoked) logger.info(`API key revoked by ${user.email}`);
    res.redirect('/dashboard/keys');
});

router.get('/playground', async (req: Request, res: Response) => {
    res.render('dashboard/playground', {
        title: 'Playground — Veripay',
        active: 'dashboard',
        section: 'playground'
    });
});

/**
 * Runs a verification on behalf of the signed-in user without requiring them to
 * paste a key into the browser. Counts against their quota like any other call.
 */
router.post('/playground/verify', async (req: Request, res: Response) => {
    const user = req.currentUser!;
    const settings = await getSettings();
    const startedAt = Date.now();

    const rate = checkRateLimit(`playground:${user.id}`, user.rateLimitPerMinute ?? settings.defaultRateLimitPerMinute);
    if (!rate.allowed) {
        res.status(429).json({
            success: false,
            error: `Rate limit reached. Retry in ${rate.retryAfterSeconds}s.`
        });
        return;
    }

    const quotaLimit = user.monthlyQuota ?? settings.defaultMonthlyQuota;
    if (quotaLimit > 0 && (await getQuotaUsed(user.id)) >= quotaLimit) {
        res.status(429).json({ success: false, error: 'Monthly quota reached.' });
        return;
    }

    const { reference, suffix, phoneNumber } = req.body ?? {};

    if (typeof reference !== 'string' || reference.trim().length === 0) {
        res.status(400).json({ success: false, error: 'A reference is required.' });
        return;
    }

    try {
        const result = await runSmartVerify({
            reference: reference.trim(),
            suffix: typeof suffix === 'string' && suffix.trim() ? suffix.trim() : undefined,
            phoneNumber: typeof phoneNumber === 'string' && phoneNumber.trim() ? phoneNumber.trim() : undefined
        });

        recordUsage({
            userId: user.id,
            endpoint: '/dashboard/playground',
            method: 'POST',
            statusCode: result.success ? 200 : 422,
            responseTime: Date.now() - startedAt,
            provider: result.provider,
            ip: clientIp(req as never),
            source: 'DASHBOARD'
        });

        await consumeQuota(user.id);

        res.status(result.success ? 200 : (result.httpStatus ?? 422)).json(result);
    } catch (err) {
        logger.error('Playground verification failed:', err);
        res.status(500).json({ success: false, error: 'Verification failed unexpectedly.' });
    }
});

router.get('/settings', async (req: Request, res: Response) => {
    const user = req.currentUser!;
    const settings = await getSettings();

    res.render('dashboard/settings', {
        title: 'Account — Veripay',
        active: 'dashboard',
        section: 'settings',
        quota: await quotaView(user.id, user.monthlyQuota),
        rateLimit: user.rateLimitPerMinute ?? settings.defaultRateLimitPerMinute
    });
});

router.post('/settings/delete', async (req: Request, res: Response) => {
    const user = req.currentUser!;

    await prisma.user.delete({ where: { id: user.id } });
    logger.warn(`Account deleted: ${user.email}`);

    res.clearCookie('veripay_session', { path: '/' });
    res.redirect('/');
});

export default router;
