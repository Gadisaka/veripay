import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { validateEnvironment } from './config/env';

validateEnvironment();

import CBERouter from './routes/verifyCBERoute';
import telebirrRouter from './routes/verifyTelebirrRoute';
import dashenRouter from './routes/verifyDashenRoute';
import abyssiniaRouter from './routes/verifyAbyssiniaRoute';
import cbebirrRouter from './routes/verifyCBEBirrRoute';
import mpesaRouter from './routes/verifyMpesaRoute';
import universalRouter from './routes/verifyUniversalRoute';
import authRouter from './routes/authRoute';
import pagesRouter from './routes/pagesRoute';
import dashboardRouter from './routes/dashboardRoute';
import publicVerifyRouter from './routes/publicVerifyRoute';
import adminRouter from './routes/adminRoute';
import logger from './utils/logger';
import { verifyImageHandler } from './services/verifyImage';
import { requestLogger } from './middleware/requestLogger';
import { apiKeyAuth, requireAdminApiKey } from './middleware/apiKeyAuth';
import { loadUser } from './auth/session';
import { connectDatabase, disconnectDatabase } from './utils/prisma';

const pkg = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3001;

logger.info(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Node version: ${process.version}`);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Every rendered page needs the signed-in user and the version in the footer.
app.use(loadUser);
app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.user = req.currentUser ?? null;
    res.locals.version = pkg.version;
    res.locals.active = '';
    next();
});

const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next): void => {
    if (err instanceof SyntaxError && 'body' in err) {
        logger.error('JSON parsing error:', err);
        res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
};

app.use(jsonErrorHandler);

// ── Pages ────────────────────────────────────────────────────────────────────

app.use('/auth', authRouter);
app.use('/dashboard', dashboardRouter);
app.use('/admin', adminRouter);
app.use('/public', publicVerifyRouter);
app.use('/', pagesRouter);

// ── API ──────────────────────────────────────────────────────────────────────
// CORS is scoped to the machine-to-machine endpoints. The browser pages
// authenticate with a cookie and must not be reachable cross-origin.

const apiCors = cors({ origin: '*', credentials: false });

app.use('/verify-cbe', apiCors, apiKeyAuth, CBERouter);
app.use('/verify-telebirr', apiCors, apiKeyAuth, telebirrRouter);
app.use('/verify-dashen', apiCors, apiKeyAuth, dashenRouter);
app.use('/verify-abyssinia', apiCors, apiKeyAuth, abyssiniaRouter);
app.use('/verify-cbebirr', apiCors, apiKeyAuth, cbebirrRouter);
app.use('/verify-mpesa', apiCors, apiKeyAuth, mpesaRouter);
app.post('/verify-image', apiCors, apiKeyAuth, requireAdminApiKey, verifyImageHandler);
app.use('/verify', apiCors, apiKeyAuth, universalRouter);

app.get('/health', apiCors, (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: pkg.version, timestamp: new Date().toISOString() });
});

// ── Fallbacks ────────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/verify')) {
        res.status(404).json({ success: false, error: 'Unknown endpoint' });
        return;
    }

    res.status(404).render('error', {
        title: 'Not found — Veripay',
        heading: 'Page not found',
        message: 'That page does not exist.'
    });
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error:', err);

    if (req.path.startsWith('/verify') || req.xhr) {
        res.status(500).json({ success: false, error: 'Internal server error' });
        return;
    }

    res.status(500).render('error', {
        title: 'Something went wrong — Veripay',
        heading: 'Something went wrong',
        message: 'An unexpected error occurred. Please try again.'
    });
});

async function start(): Promise<void> {
    await connectDatabase();

    const server = app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Server running on port ${PORT}`);
    });

    const gracefulShutdown = async () => {
        logger.info('Shutting down server...');
        server.close(async () => {
            await disconnectDatabase();
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
}

start().catch(err => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
