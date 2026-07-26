import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '@prisma/client';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export const SESSION_COOKIE = 'veripay_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

interface SessionPayload {
    sub: string;
    email: string;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            currentUser?: User;
        }
    }
}

function getSecret(): string {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error('SESSION_SECRET must be set to a random string of at least 16 characters.');
    }
    return secret;
}

export function issueSession(res: Response, user: User): void {
    const token = jwt.sign({ sub: user.id, email: user.email } satisfies SessionPayload, getSecret(), {
        expiresIn: SESSION_TTL_SECONDS
    });

    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: '/'
    });
}

export function clearSession(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Resolves the signed-in user for every request. Never rejects — routes decide
 * whether a user is required.
 */
export const loadUser = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();

    try {
        const payload = jwt.verify(token, getSecret()) as SessionPayload;
        const user = await prisma.user.findUnique({ where: { id: payload.sub } });

        if (user && user.status === 'ACTIVE') {
            req.currentUser = user;
        }
    } catch {
        // Expired or tampered cookie — treat as signed out.
    }

    next();
};

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.currentUser) {
        const target = encodeURIComponent(req.originalUrl);
        res.redirect(`/login?next=${target}`);
        return;
    }
    next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.currentUser) {
        res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
    }

    if (req.currentUser.role !== 'ADMIN') {
        logger.warn(`Non-admin ${req.currentUser.email} attempted to reach ${req.originalUrl}`);
        res.status(404).render('error', {
            title: 'Not found',
            heading: 'Page not found',
            message: 'That page does not exist.',
            user: req.currentUser
        });
        return;
    }

    next();
};
