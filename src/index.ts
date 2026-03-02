import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

import CBERouter from './routes/verifyCBERoute';
import telebirrRouter from './routes/verifyTelebirrRoute';
import dashenRouter from './routes/verifyDashenRoute';
import abyssiniaRouter from './routes/verifyAbyssiniaRoute';
import cbebirrRouter from './routes/verifyCBEBirrRoute';
import mpesaRouter from './routes/verifyMpesaRoute';
import universalRouter from './routes/verifyUniversalRoute';
import adminRouter from './routes/adminRoute';
import logger from './utils/logger';
import { verifyImageHandler } from "./services/verifyImage";
import { requestLogger } from './middleware/requestLogger';

const app = express();
const PORT = process.env.PORT || 3001;

logger.info(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Node version: ${process.version}`);
logger.info(`Platform: ${process.platform}`);

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use('/admin', adminRouter);

const jsonErrorHandler: ErrorRequestHandler = async (err, req, res, next): Promise<void> => {
    if (err instanceof SyntaxError && 'body' in err) {
        logger.error('JSON parsing error:', err);
        res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
};

app.use(jsonErrorHandler);

app.use('/verify-cbe', CBERouter);
app.use('/verify-telebirr', telebirrRouter);
app.use('/verify-dashen', dashenRouter);
app.use('/verify-abyssinia', abyssiniaRouter);
app.use('/verify-cbebirr', cbebirrRouter);
app.use('/verify-mpesa', mpesaRouter);
app.post('/verify-image', verifyImageHandler);
app.use('/verify', universalRouter);

app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req: Request, res: Response) => {
    res.json({
        name: 'Payment Verification API',
        version: '2.1.0',
        endpoints: [
            '/verify-cbe',
            '/verify-telebirr',
            '/verify-dashen',
            '/verify-abyssinia',
            '/verify-cbebirr',
            '/verify-mpesa',
            '/verify',
            '/verify-image'
        ]
    });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});

const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
