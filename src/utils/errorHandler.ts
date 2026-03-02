import logger from './logger';
import { Response } from 'express';

export enum ErrorType {
    NOT_FOUND = 'NOT_FOUND',
    VALIDATION = 'VALIDATION',
    UNAUTHORIZED = 'UNAUTHORIZED',
    FORBIDDEN = 'FORBIDDEN',
    INTERNAL = 'INTERNAL',
}

export class AppError extends Error {
    type: ErrorType;
    statusCode: number;
    details?: any;

    constructor(message: string, type: ErrorType, statusCode: number, details?: any) {
        super(message);
        this.type = type;
        this.statusCode = statusCode;
        this.details = details;
        this.name = 'AppError';
    }
}

export const sendErrorResponse = (res: Response, error: any) => {
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            success: false,
            error: error.message,
            ...(process.env.NODE_ENV === 'development' && { details: error.details })
        });
    } else {
        logger.error('Unknown error:', error);
        res.status(500).json({
            success: false,
            error: 'An unexpected error occurred.'
        });
    }
};
