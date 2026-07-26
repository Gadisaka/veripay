import crypto from 'crypto';
import logger from '../utils/logger';

/**
 * Validates configuration at boot so a misconfigured deployment fails with a
 * readable message rather than a stack trace on the first request.
 */
export function validateEnvironment(): void {
    const isProduction = process.env.NODE_ENV === 'production';
    const fatal: string[] = [];

    if (!process.env.DATABASE_URL) {
        fatal.push('DATABASE_URL is required (MySQL connection string).');
    }

    if (!process.env.SESSION_SECRET) {
        if (isProduction) {
            fatal.push('SESSION_SECRET is required. Generate one with: openssl rand -hex 32');
        } else {
            process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
            logger.warn('SESSION_SECRET was not set — generated a temporary one. Sessions reset on restart.');
        }
    } else if (process.env.SESSION_SECRET.length < 16) {
        fatal.push('SESSION_SECRET must be at least 16 characters.');
    }

    if (!process.env.APP_URL) {
        if (isProduction) {
            fatal.push('APP_URL is required so OAuth redirects point at the right host.');
        } else {
            process.env.APP_URL = `http://localhost:${process.env.PORT || 3001}`;
        }
    }

    if (fatal.length > 0) {
        logger.error(`Cannot start:\n  - ${fatal.join('\n  - ')}`);
        process.exit(1);
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        logger.warn('Google sign-in is not configured — nobody can create an account or issue API keys.');
    }

    if (isProduction && process.env.DEV_LOGIN_EMAIL) {
        logger.warn('DEV_LOGIN_EMAIL is set but ignored in production.');
    }
}
