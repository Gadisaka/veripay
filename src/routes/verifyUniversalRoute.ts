import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import logger from '../utils/logger';

const router = Router();

interface UniversalVerifyBody {
    reference: string;
    suffix?: string;
    phoneNumber?: string;
}

router.post('/', async (req: Request<{}, {}, UniversalVerifyBody>, res: Response): Promise<void> => {
    const { reference, suffix, phoneNumber } = req.body;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    const result = await runSmartVerify({ reference, suffix, phoneNumber });

    if (!result.success) {
        logger.warn(`Universal verify failed [${result.httpStatus}]: ${result.error}`);
        res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            ...(result.details ? { details: result.details } : {}),
        });
        return;
    }

    // Telebirr already wraps its result in { success, data }; other providers
    // return the object directly, so only wrap when needed.
    const responseBody = (result.data as any)?.success !== undefined
        ? result.data
        : { success: true, data: result.data };

    res.json(responseBody);
});

export default router;
