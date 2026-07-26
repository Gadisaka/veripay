import { PrismaClient } from '@prisma/client';
import logger from './logger';

export const prisma = new PrismaClient({
    log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' }
    ]
});

prisma.$on('warn', event => logger.warn(`Prisma: ${event.message}`));
prisma.$on('error', event => logger.error(`Prisma: ${event.message}`));

/**
 * Fails fast with an actionable message instead of letting the first request
 * surface a raw connection stack trace.
 */
export async function connectDatabase(): Promise<void> {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            'DATABASE_URL is not set. The API needs a MySQL database — see the deployment notes in README.md.'
        );
    }

    try {
        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Connected to the database');
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not connect to the database: ${detail}`);
    }
}

export async function disconnectDatabase(): Promise<void> {
    await prisma.$disconnect().catch(() => undefined);
}
