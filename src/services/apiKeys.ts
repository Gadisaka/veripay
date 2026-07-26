import crypto from 'crypto';
import { ApiKey } from '@prisma/client';
import { prisma } from '../utils/prisma';

const KEY_PREFIX = 'vp_live_';
const MAX_KEYS_PER_USER = 10;

export function hashKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export interface CreatedKey {
    record: ApiKey;
    rawKey: string;
}

/**
 * Creates a key and returns the raw value exactly once. Only the SHA-256 digest
 * is persisted, so a lost key cannot be recovered — it has to be replaced.
 */
export async function createApiKey(userId: string, name: string): Promise<CreatedKey> {
    const active = await prisma.apiKey.count({ where: { userId, isActive: true } });
    if (active >= MAX_KEYS_PER_USER) {
        throw new Error(`You can have at most ${MAX_KEYS_PER_USER} active keys. Revoke one first.`);
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const rawKey = `${KEY_PREFIX}${secret}`;

    const record = await prisma.apiKey.create({
        data: {
            userId,
            name: name.trim().slice(0, 60) || 'Default key',
            keyHash: hashKey(rawKey),
            prefix: `${KEY_PREFIX}${secret.slice(0, 6)}`
        }
    });

    return { record, rawKey };
}

export async function listApiKeys(userId: string) {
    return prisma.apiKey.findMany({
        where: { userId },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }]
    });
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const result = await prisma.apiKey.updateMany({
        where: { id: keyId, userId, isActive: true },
        data: { isActive: false, revokedAt: new Date() }
    });

    return result.count > 0;
}

export { MAX_KEYS_PER_USER };
