import crypto from 'crypto';
import https from 'https';

/**
 * Minimal Google OAuth 2.0 authorization-code flow.
 *
 * Hand-rolled rather than pulled from a library because `openid-client` v6 is
 * ESM-only and this project compiles to CommonJS. The id_token signature is not
 * separately verified: it is received straight from Google's token endpoint
 * over TLS, which OpenID Connect Core 3.1.3.7 permits.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleProfile {
    googleId: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    emailVerified: boolean;
}

export function isGoogleConfigured(): boolean {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
    const base = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
    return `${base}/auth/google/callback`;
}

export function createState(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function authorizationUrl(state: string): string {
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account'
    });

    return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function decodeIdToken(idToken: string): Record<string, unknown> {
    const segment = idToken.split('.')[1];
    if (!segment) throw new Error('Malformed id_token from Google.');
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Node's fetch speaks HTTP/2 to oauth2.googleapis.com. From this host that
 * handshake stalls until it times out, while a plain HTTP/1.1 POST returns
 * immediately. Keep the token exchange on https.request.
 */
function postForm(url: string, body: URLSearchParams): Promise<{ status: number; text: string }> {
    const payload = body.toString();

    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 15_000
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        text: Buffer.concat(chunks).toString('utf8')
                    });
                });
            }
        );

        req.on('timeout', () => req.destroy(new Error('Google token request timed out')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

export async function exchangeCode(code: string): Promise<GoogleProfile> {
    const response = await postForm(
        TOKEN_ENDPOINT,
        new URLSearchParams({
            code,
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: redirectUri(),
            grant_type: 'authorization_code'
        })
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Google rejected the token exchange (${response.status}): ${response.text.slice(0, 200)}`);
    }

    const tokens = JSON.parse(response.text) as { id_token?: string };
    if (!tokens.id_token) throw new Error('Google did not return an id_token.');

    const claims = decodeIdToken(tokens.id_token);
    const googleId = typeof claims.sub === 'string' ? claims.sub : '';
    const email = typeof claims.email === 'string' ? claims.email : '';

    if (!googleId || !email) {
        throw new Error('Google profile is missing a subject or email address.');
    }

    return {
        googleId,
        email: email.toLowerCase(),
        name: typeof claims.name === 'string' ? claims.name : undefined,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
        emailVerified: claims.email_verified === true
    };
}
