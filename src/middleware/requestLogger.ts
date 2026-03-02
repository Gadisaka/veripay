import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

const statsCache = {
  totalRequests: 0,
  endpointStats: new Map<string, {
    count: number,
    successCount: number,
    failureCount: number,
    avgResponseTime: number
  }>(),
  ipStats: new Map<string, number>()
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(2, 15);

  logger.info(`[${requestId}] Incoming ${req.method} request to ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    query: Object.keys(req.query).length ? req.query : undefined,
  });

  statsCache.totalRequests++;

  const endpoint = `${req.method} ${req.originalUrl.split('?')[0]}`;
  if (!statsCache.endpointStats.has(endpoint)) {
    statsCache.endpointStats.set(endpoint, {
      count: 0,
      successCount: 0,
      failureCount: 0,
      avgResponseTime: 0
    });
  }
  const endpointStat = statsCache.endpointStats.get(endpoint)!;
  endpointStat.count++;

  const ipCount = statsCache.ipStats.get(req.ip ?? '') || 0;
  statsCache.ipStats.set(req.ip ?? '', ipCount + 1);

  res.on('finish', () => {
    const responseTime = Date.now() - start;
    const endpointStat = statsCache.endpointStats.get(endpoint)!;

    if (res.statusCode < 400) {
      endpointStat.successCount++;
    } else {
      endpointStat.failureCount++;
    }

    endpointStat.avgResponseTime =
      (endpointStat.avgResponseTime * (endpointStat.count - 1) + responseTime) / endpointStat.count;

    logger.info(`[${requestId}] Response sent in ${responseTime}ms with status ${res.statusCode}`, {
      statusCode: res.statusCode,
      responseTime,
      contentLength: res.get('Content-Length') || 'unknown',
    });

    if (res.statusCode >= 400) {
      logger.warn(`[${requestId}] Error occurred with status ${res.statusCode}`);
    }
  });

  next();
};

export const getUsageStats = () => {
  const endpointStatsObj: Record<string, any> = {};
  statsCache.endpointStats.forEach((value, key) => {
    endpointStatsObj[key] = value;
  });

  const ipStatsObj: Record<string, number> = {};
  statsCache.ipStats.forEach((value, key) => {
    ipStatsObj[key] = value;
  });

  return {
    totalRequests: statsCache.totalRequests,
    endpointStats: endpointStatsObj,
    ipStats: ipStatsObj
  };
};
