import { Router, Request, Response } from 'express';
import { User } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { getSettings } from '../config/settings';
import { authorizationUrl, createState, exchangeCode, isGoogleConfigured, GoogleProfile } from '../auth/google';
import { clearSession, issueSession } from '../auth/session';
import logger from '../utils/logger';

const router = Router();

const STATE_COOKIE = 'veripay_oauth_state';

function adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(email => email.trim().toLowerCase())
        .filter(Boolean);
}

async function upsertUser(profile: GoogleProfile): Promise<User | null> {
    const existing = await prisma.user.findFirst({
        where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] }
    });

    // The first account to sign in becomes an administrator, so a fresh
    // deployment is reachable without seeding the database by hand.
    const isFirstUser = !existing && (await prisma.user.count()) === 0;
    const shouldBeAdmin = isFirstUser || adminEmails().includes(profile.email);

    if (!existing) {
        const settings = await getSettings();
        if (!settings.signupsEnabled) return null;

        return prisma.user.create({
            data: {
                googleId: profile.googleId,
                email: profile.email,
                name: profile.name,
                avatarUrl: profile.avatarUrl,
                role: shouldBeAdmin ? 'ADMIN' : 'USER',
                lastLoginAt: new Date()
            }
        });
    }

    return prisma.user.update({
        where: { id: existing.id },
        data: {
            googleId: profile.googleId,
            name: profile.name ?? existing.name,
            avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
            role: shouldBeAdmin ? 'ADMIN' : existing.role,
            lastLoginAt: new Date()
        }
    });
}

function safeNext(raw: unknown): string {
    // Only same-origin paths, so the redirect cannot be pointed at another host.
    if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) return raw;
    return '/dashboard';
}

router.get('/google', (req: Request, res: Response) => {
    if (!isGoogleConfigured()) {
        res.status(503).render('error', {
            title: 'Sign-in unavailable',
            heading: 'Google sign-in is not configured',
            message: 'This deployment is missing GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
            user: null
        });
        return;
    }

    const state = createState();
    const next = safeNext(req.query.next);

    res.cookie(STATE_COOKIE, `${state}|${next}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 10 * 60 * 1000,
        path: '/'
    });

    res.redirect(authorizationUrl(state));
});

router.get('/google/callback', async (req: Request, res: Response) => {
    const cookie = req.cookies?.[STATE_COOKIE] as string | undefined;
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const [expectedState, next] = (cookie || '').split('|');
    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';

    if (!expectedState || expectedState !== returnedState) {
        res.status(400).render('error', {
            title: 'Sign-in failed',
            heading: 'Sign-in could not be completed',
            message: 'The request could not be validated. Please start again from the login page.',
            user: null
        });
        return;
    }

    if (typeof req.query.code !== 'string') {
        res.redirect('/login?error=cancelled');
        return;
    }

    try {
        const profile = await exchangeCode(req.query.code);

        if (!profile.emailVerified) {
            res.redirect('/login?error=unverified');
            return;
        }

        const user = await upsertUser(profile);
        if (!user) {
            res.redirect('/login?error=signups_closed');
            return;
        }

        if (user.status === 'SUSPENDED') {
            res.redirect('/login?error=suspended');
            return;
        }

        issueSession(res, user);
        logger.info(`Signed in: ${user.email}`);
        res.redirect(safeNext(next));
    } catch (err) {
        logger.error('Google sign-in failed:', err);
        res.redirect('/login?error=failed');
    }
});

/**
 * Development-only shortcut so the dashboard can be exercised without
 * registering an OAuth client. Refuses to run in production.
 */
router.get('/dev-login', async (req: Request, res: Response) => {
    const email = process.env.DEV_LOGIN_EMAIL?.trim().toLowerCase();

    if (process.env.NODE_ENV === 'production' || !email) {
        res.status(404).render('error', {
            title: 'Not found',
            heading: 'Page not found',
            message: 'That page does not exist.',
            user: null
        });
        return;
    }

    const user = await upsertUser({
        googleId: `dev-${email}`,
        email,
        name: 'Development User',
        emailVerified: true
    });

    if (!user) {
        res.redirect('/login?error=signups_closed');
        return;
    }

    issueSession(res, user);
    logger.warn(`Development login used for ${email}`);
    res.redirect(safeNext(req.query.next));
});

router.post('/logout', (_req: Request, res: Response) => {
    clearSession(res);
    res.redirect('/');
});

export default router;
