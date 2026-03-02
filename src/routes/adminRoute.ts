import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { getUsageStats } from '../middleware/requestLogger';
import logger from '../utils/logger';

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';

const checkAdminAuth = (req: Request, res: Response, next: NextFunction) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;

    if (adminKey !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized admin access' });
    }

    next();
};

router.get('/stats', checkAdminAuth as RequestHandler, (req: Request, res: Response) => {
    try {
        const stats = getUsageStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (err) {
        logger.error('Error fetching usage stats:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch usage statistics' });
    }
});

export default router;
