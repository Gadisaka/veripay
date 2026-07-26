import fs from 'fs';
import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { requireAdmin } from '../auth/session';
import { AppSettings, DEFAULT_SETTINGS, SETTING_LABELS, getSettings, updateSettings } from '../config/settings';
import { clientIp, currentPeriodStart, getDailyUsage, getUsageSummary, recordUsage } from '../services/usage';
import { imageUpload, isMistralConfigured, processReceiptImage } from '../services/verifyImage';
import logger from '../utils/logger';

const router = Router();

router.use(requireAdmin);

const PAGE_SIZE = 50;

function pageNumber(raw: unknown): number {
    const value = Number.parseInt(String(raw ?? '1'), 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Empty string means "clear the override and fall back to the global default". */
function optionalInt(raw: unknown): number | null {
    const text = String(raw ?? '').trim();
    if (text === '') return null;

    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

// ── Overview ─────────────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [users, suspended, activeKeys, requestsToday, summary, daily, topUsers] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: 'SUSPENDED' } }),
        prisma.apiKey.count({ where: { isActive: true } }),
        prisma.usageLog.count({ where: { createdAt: { gte: dayAgo } } }),
        getUsageSummary(null, 30),
        getDailyUsage(null, 30),
        prisma.usageCounter.findMany({
            where: { periodStart: currentPeriodStart() },
            orderBy: { count: 'desc' },
            take: 8,
            include: { user: { select: { email: true, name: true } } }
        })
    ]);

    res.render('admin/index', {
        title: 'Admin — Veripay',
        active: '',
        section: 'admin-overview',
        stats: { users, suspended, activeKeys, requestsToday },
        summary,
        daily,
        topUsers
    });
});

// ── Users ────────────────────────────────────────────────────────────────────

router.get('/users', async (req: Request, res: Response) => {
    const page = pageNumber(req.query.page);
    const search = String(req.query.q ?? '').trim();

    const where: Prisma.UserWhereInput = search
        ? { OR: [{ email: { contains: search } }, { name: { contains: search } }] }
        : {};

    const [users, total, settings] = await Promise.all([
        prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            include: {
                _count: { select: { apiKeys: true } },
                counters: { where: { periodStart: currentPeriodStart() }, take: 1 }
            }
        }),
        prisma.user.count({ where }),
        getSettings()
    ]);

    res.render('admin/users', {
        title: 'Users — Admin',
        active: '',
        section: 'admin-users',
        users,
        total,
        page,
        pageSize: PAGE_SIZE,
        search,
        defaults: settings,
        notice: typeof req.query.notice === 'string' ? req.query.notice : null
    });
});

router.post('/users/:id', async (req: Request, res: Response) => {
    const targetId = String(req.params.id ?? '');
    const actor = req.currentUser!;
    const action = String(req.body.action ?? '');

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
        res.redirect('/admin/users?notice=User+not+found');
        return;
    }

    // Guard against an administrator locking themselves out.
    if (target.id === actor.id && (action === 'suspend' || action === 'demote')) {
        res.redirect('/admin/users?notice=You+cannot+change+your+own+access');
        return;
    }

    switch (action) {
        case 'suspend':
            await prisma.user.update({ where: { id: targetId }, data: { status: 'SUSPENDED' } });
            break;

        case 'activate':
            await prisma.user.update({ where: { id: targetId }, data: { status: 'ACTIVE' } });
            break;

        case 'promote':
            await prisma.user.update({ where: { id: targetId }, data: { role: 'ADMIN' } });
            break;

        case 'demote': {
            const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
            if (admins <= 1) {
                res.redirect('/admin/users?notice=Cannot+remove+the+last+administrator');
                return;
            }
            await prisma.user.update({ where: { id: targetId }, data: { role: 'USER' } });
            break;
        }

        case 'limits':
            await prisma.user.update({
                where: { id: targetId },
                data: {
                    monthlyQuota: optionalInt(req.body.monthlyQuota),
                    rateLimitPerMinute: optionalInt(req.body.rateLimitPerMinute)
                }
            });
            break;

        case 'revoke-keys':
            await prisma.apiKey.updateMany({
                where: { userId: targetId, isActive: true },
                data: { isActive: false, revokedAt: new Date() }
            });
            break;

        default:
            res.redirect('/admin/users?notice=Unknown+action');
            return;
    }

    logger.warn(`Admin ${actor.email} performed "${action}" on ${target.email}`);
    res.redirect('/admin/users?notice=Saved');
});

// ── Keys ─────────────────────────────────────────────────────────────────────

router.get('/keys', async (req: Request, res: Response) => {
    const page = pageNumber(req.query.page);

    const [keys, total] = await Promise.all([
        prisma.apiKey.findMany({
            orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            include: { user: { select: { email: true, status: true } } }
        }),
        prisma.apiKey.count()
    ]);

    res.render('admin/keys', {
        title: 'API keys — Admin',
        active: '',
        section: 'admin-keys',
        keys,
        total,
        page,
        pageSize: PAGE_SIZE
    });
});

router.post('/keys/:id/revoke', async (req: Request, res: Response) => {
    await prisma.apiKey.updateMany({
        where: { id: String(req.params.id ?? ''), isActive: true },
        data: { isActive: false, revokedAt: new Date() }
    });

    logger.warn(`Admin ${req.currentUser!.email} revoked key ${req.params.id}`);
    res.redirect('/admin/keys');
});

// ── Usage explorer ───────────────────────────────────────────────────────────

router.get('/usage', async (req: Request, res: Response) => {
    const page = pageNumber(req.query.page);
    const status = String(req.query.status ?? '').trim();
    const endpoint = String(req.query.endpoint ?? '').trim();

    const where: Prisma.UsageLogWhereInput = {};
    if (endpoint) where.endpoint = { contains: endpoint };
    if (status === 'success') where.statusCode = { lt: 400 };
    if (status === 'error') where.statusCode = { gte: 400 };

    const [logs, total, endpoints] = await Promise.all([
        prisma.usageLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE
        }),
        prisma.usageLog.count({ where }),
        prisma.usageLog.groupBy({
            by: ['endpoint'],
            _count: { endpoint: true },
            orderBy: { _count: { endpoint: 'desc' } },
            take: 12
        })
    ]);

    const userIds = [...new Set(logs.map(log => log.userId).filter((id): id is string => Boolean(id)))];
    const users = userIds.length
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
        : [];
    const emailById = new Map(users.map(user => [user.id, user.email]));

    res.render('admin/usage', {
        title: 'Usage — Admin',
        active: '',
        section: 'admin-usage',
        logs,
        emailById,
        endpoints,
        total,
        page,
        pageSize: PAGE_SIZE,
        filters: { status, endpoint }
    });
});

// ── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', async (req: Request, res: Response) => {
    res.render('admin/settings', {
        title: 'Settings — Admin',
        active: '',
        section: 'admin-settings',
        settings: await getSettings(),
        defaults: DEFAULT_SETTINGS,
        labels: SETTING_LABELS,
        notice: typeof req.query.notice === 'string' ? req.query.notice : null
    });
});

router.post('/settings', async (req: Request, res: Response) => {
    const patch: Partial<AppSettings> = {};

    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        const raw = req.body[key];

        if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
            (patch as Record<string, unknown>)[key] = raw === 'on' || raw === 'true';
            continue;
        }

        const value = Number.parseInt(String(raw ?? ''), 10);
        if (Number.isFinite(value) && value >= 0) {
            (patch as Record<string, unknown>)[key] = value;
        }
    }

    await updateSettings(patch);
    logger.warn(`Admin ${req.currentUser!.email} updated global settings`);

    res.redirect('/admin/settings?notice=Settings+saved');
});

// ── Receipt image verification (admin session only) ───────────────────────────

router.get('/image', (_req: Request, res: Response) => {
    res.render('admin/image', {
        title: 'Image verification — Admin',
        active: '',
        section: 'admin-image',
        mistralConfigured: isMistralConfigured()
    });
});

/**
 * Runs OCR (+ optional live verify) for a signed-in administrator without
 * requiring them to paste an API key into the browser.
 */
router.post('/image/verify', imageUpload.single('file'), async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const user = req.currentUser!;

    try {
        if (!req.file) {
            res.status(400).json({ success: false, error: 'Choose a receipt image first.' });
            return;
        }

        const autoVerify =
            req.body?.autoVerify === 'true' ||
            req.body?.autoVerify === 'on' ||
            req.body?.autoVerify === true;

        const suffix = typeof req.body?.suffix === 'string' ? req.body.suffix.trim() : '';

        const outcome = await processReceiptImage(req.file.path, {
            autoVerify,
            accountSuffix: suffix || null
        });

        recordUsage({
            userId: user.id,
            endpoint: '/admin/image/verify',
            method: 'POST',
            statusCode: outcome.httpStatus,
            responseTime: Date.now() - startedAt,
            provider: typeof outcome.body.type === 'string' ? outcome.body.type : null,
            ip: clientIp(req as never),
            source: 'DASHBOARD'
        });

        logger.info(`Admin ${user.email} ran image verification (${outcome.httpStatus})`);

        res.status(outcome.httpStatus).json({
            success: outcome.httpStatus < 400,
            ...outcome.body
        });
    } catch (err) {
        logger.error('Admin image verification failed:', err);
        res.status(500).json({ success: false, error: 'Something went wrong processing the image.' });
    } finally {
        if (req.file?.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch {
                // ignore
            }
        }
    }
});

export default router;
