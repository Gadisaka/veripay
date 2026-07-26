import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { marked } from 'marked';
import { isGoogleConfigured } from '../auth/google';
import { getSettings } from '../config/settings';

const router = Router();

const LOGIN_ERRORS: Record<string, string> = {
    cancelled: 'Sign-in was cancelled.',
    unverified: 'That Google account does not have a verified email address.',
    suspended: 'This account has been suspended. Contact the administrator.',
    signups_closed: 'New accounts are not being accepted right now.',
    failed: 'Sign-in failed. Please try again.'
};

router.get('/', async (_req: Request, res: Response) => {
    const settings = await getSettings();

    res.render('landing', {
        title: 'Veripay — free Ethiopian payment verification API',
        description:
            'Free API to verify CBE, Telebirr, Bank of Abyssinia, Dashen, CBE Birr and M-Pesa payments. Sign in with Google for a key.',
        active: 'verify',
        appUrl: (process.env.APP_URL || '').replace(/\/$/, '') || 'https://payment.offsetsoftware.net',
        publicChecksPerHour: settings.publicWidgetPerHour
    });
});

router.get('/changelog', async (_req: Request, res: Response) => {
    let content = '<p>No changelog is available.</p>';

    try {
        const raw = await fs.readFile(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
        content = await marked.parse(raw);
    } catch {
        // Fall through to the placeholder.
    }

    res.render('changelog', {
        title: 'Changelog — Veripay',
        active: 'changelog',
        content
    });
});

router.get('/login', (req: Request, res: Response) => {
    if (req.currentUser) {
        res.redirect('/dashboard');
        return;
    }

    const errorKey = typeof req.query.error === 'string' ? req.query.error : '';
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/dashboard';

    res.render('login', {
        next,
        error: LOGIN_ERRORS[errorKey] ?? null,
        googleConfigured: isGoogleConfigured(),
        devLoginAvailable: process.env.NODE_ENV !== 'production' && Boolean(process.env.DEV_LOGIN_EMAIL)
    });
});

router.get('/docs', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'docs.html'));
});

export default router;
