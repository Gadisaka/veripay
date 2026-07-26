import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import { getSettings } from '../config/settings';
import { checkRateLimit } from '../middleware/rateLimit';
import { clientIp, recordUsage } from '../services/usage';
import logger from '../utils/logger';

const router = Router();

/**
 * Powers the verification widget on the landing page. No API key, so it is
 * limited per IP address and attributed to no account.
 */
router.post('/verify', async (req: Request, res: Response) => {
    const settings = await getSettings();
    const ip = clientIp(req as never);
    const startedAt = Date.now();

    const { reference, suffix, phoneNumber } = req.body ?? {};

    // Validated before the allowance is consumed, so a typo does not cost a check.
    if (typeof reference !== 'string' || reference.trim().length === 0) {
        res.status(400).json({ success: false, error: 'A payment reference is required.' });
        return;
    }

    const rate = checkRateLimit(`public:${ip}`, settings.publicWidgetPerHour, 3_600_000);

    if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        res.status(429).json({
            success: false,
            error: `You have used all ${settings.publicWidgetPerHour} free checks for this hour. Sign in with Google for an API key — it is free and the limits are much higher.`
        });
        return;
    }

    try {
        const result = await runSmartVerify({
            reference: reference.trim().slice(0, 300),
            suffix: typeof suffix === 'string' && suffix.trim() ? suffix.trim().slice(0, 20) : undefined,
            phoneNumber: typeof phoneNumber === 'string' && phoneNumber.trim() ? phoneNumber.trim().slice(0, 20) : undefined
        });

        recordUsage({
            endpoint: '/public/verify',
            method: 'POST',
            statusCode: result.success ? 200 : 422,
            responseTime: Date.now() - startedAt,
            provider: result.provider,
            ip,
            source: 'PUBLIC'
        });

        res.status(result.success ? 200 : (result.httpStatus ?? 422)).json({
            success: result.success,
            provider: result.provider,
            ...(result.success ? { data: result.data } : { error: result.error }),
            remainingFreeChecks: rate.remaining
        });
    } catch (err) {
        logger.error('Public verification failed:', err);
        res.status(500).json({ success: false, error: 'Verification failed unexpectedly.' });
    }
});

export default router;
