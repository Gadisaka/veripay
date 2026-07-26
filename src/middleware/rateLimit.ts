/**
 * In-memory sliding-window rate limiter.
 *
 * State is per process. Under Passenger with more than one instance each
 * process counts separately, so the effective limit is multiplied by the
 * instance count. The monthly quota lives in the database and stays exact —
 * this is only the short-term burst guard.
 */

interface Window {
    hits: number[];
}

const buckets = new Map<string, Window>();

let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(windowMs: number): void {
    if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = Date.now();

    const cutoff = Date.now() - windowMs;
    for (const [key, window] of buckets) {
        window.hits = window.hits.filter(at => at > cutoff);
        if (window.hits.length === 0) buckets.delete(key);
    }
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

export function checkRateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
    if (limit <= 0) {
        return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
    }

    sweep(windowMs);

    const now = Date.now();
    const cutoff = now - windowMs;
    const window = buckets.get(key) ?? { hits: [] };

    window.hits = window.hits.filter(at => at > cutoff);

    if (window.hits.length >= limit) {
        buckets.set(key, window);
        const oldest = window.hits[0]!;
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
        };
    }

    window.hits.push(now);
    buckets.set(key, window);

    return { allowed: true, remaining: limit - window.hits.length, retryAfterSeconds: 0 };
}

export function resetRateLimits(): void {
    buckets.clear();
}
