import { Mistral } from '@mistralai/mistralai';
import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import multer from 'multer';
import logger from '../utils/logger';
import { verifyTelebirr } from './verifyTelebirr';
import { verifyCBE } from './verifyCBE';

const uploadsDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

export const imageUpload = multer({
    dest: uploadsDir,
    limits: { fileSize: 12 * 1024 * 1024 }
});

export function isMistralConfigured(): boolean {
    return Boolean(process.env.MISTRAL_API_KEY?.trim());
}

function getMistralClient(): Mistral {
    const apiKey = process.env.MISTRAL_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('MISTRAL_API_KEY is not configured.');
    }
    return new Mistral({ apiKey });
}

export interface ImageVerifyOptions {
    autoVerify: boolean;
    accountSuffix?: string | null;
}

export interface ImageVerifyResult {
    httpStatus: number;
    body: Record<string, unknown>;
}

/**
 * OCR a receipt screenshot with Mistral, optionally running the real CBE/Telebirr
 * verifier afterwards. Caller is responsible for cleaning up filePath.
 */
export async function processReceiptImage(
    filePath: string,
    options: ImageVerifyOptions
): Promise<ImageVerifyResult> {
    if (!isMistralConfigured()) {
        return {
            httpStatus: 503,
            body: {
                error: 'Image verification is not configured. Set MISTRAL_API_KEY on the server.'
            }
        };
    }

    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = `
You are a payment receipt analyzer. Based on the uploaded image, determine:
- If the receipt was issued by Telebirr or the Commercial Bank of Ethiopia (CBE).
- If it's a CBE receipt, extract the transaction ID (usually starts with 'FT').
- If it's a Telebirr receipt, extract the transaction number (usually starts with 'CE').

Rules:
- CBE receipts usually include a purple header with the title "Commercial Bank of Ethiopia" and a structured table.
- Telebirr receipts are typically green with a large minus sign before the amount.
- CBE receipts may mention Telebirr (as the receiver) but are still CBE receipts.

Return this JSON format exactly:
{
  "type": "telebirr" | "cbe",
  "transaction_id"?: "FTxxxx" (if CBE),
  "transaction_number"?: "CExxxx" (if Telebirr)
}
            `.trim();

    logger.info('Sending image to Mistral Vision...');

    const client = getMistralClient();
    const chatResponse = await client.chat.complete({
        model: 'pixtral-12b',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    {
                        type: 'image_url',
                        imageUrl: `data:image/jpeg;base64,${base64Image}`
                    }
                ]
            }
        ],
        responseFormat: { type: 'json_object' }
    });

    const messageContent = chatResponse.choices?.[0]?.message?.content;

    if (!messageContent || typeof messageContent !== 'string') {
        logger.error('Invalid Mistral response', { messageContent });
        return { httpStatus: 500, body: { error: 'Invalid OCR response' } };
    }

    const result = JSON.parse(messageContent) as {
        type?: string;
        transaction_id?: string;
        transaction_number?: string;
    };
    logger.info('OCR Result', result);

    const { autoVerify, accountSuffix } = options;

    if (result.type === 'telebirr' && result.transaction_number) {
        if (!autoVerify) {
            return {
                httpStatus: 200,
                body: {
                    type: 'telebirr',
                    reference: result.transaction_number,
                    forward_to: '/verify-telebirr'
                }
            };
        }

        try {
            const data = await verifyTelebirr(result.transaction_number);
            return {
                httpStatus: 200,
                body: {
                    verified: true,
                    type: 'telebirr',
                    reference: result.transaction_number,
                    details: data
                }
            };
        } catch (verifyErr: unknown) {
            logger.error('Telebirr verification failed', { verifyErr });
            const err = verifyErr as { name?: string; message?: string; details?: unknown };
            if (err.name === 'TelebirrVerificationError') {
                return {
                    httpStatus: 502,
                    body: {
                        verified: false,
                        type: 'telebirr',
                        reference: result.transaction_number,
                        error: err.message,
                        details: err.details
                    }
                };
            }
            return {
                httpStatus: 500,
                body: {
                    verified: false,
                    type: 'telebirr',
                    reference: result.transaction_number,
                    error: 'Verification failed for Telebirr'
                }
            };
        }
    }

    if (result.type === 'cbe' && result.transaction_id) {
        if (!autoVerify) {
            return {
                httpStatus: 200,
                body: {
                    type: 'cbe',
                    reference: result.transaction_id,
                    forward_to: '/verify-cbe',
                    accountSuffix: 'required_from_user'
                }
            };
        }

        if (!accountSuffix) {
            return {
                httpStatus: 400,
                body: {
                    verified: false,
                    type: 'cbe',
                    reference: result.transaction_id,
                    error: 'Account suffix is required for CBE verification in autoVerify mode'
                }
            };
        }

        try {
            const data = await verifyCBE(result.transaction_id, accountSuffix);

            if (!data.success) {
                const puppeteerMissing =
                    typeof data.error === 'string' &&
                    (data.error.includes('shared libraries') || data.error.includes('Failed to launch the browser'));

                return {
                    httpStatus: puppeteerMissing ? 503 : data.statusCode && data.statusCode >= 400 ? data.statusCode : 502,
                    body: {
                        verified: false,
                        type: 'cbe',
                        reference: result.transaction_id,
                        error: puppeteerMissing
                            ? 'OCR found the CBE reference, but this server cannot run Chrome/Puppeteer (missing system libraries). Use OCR-only mode, or verify the reference with POST /verify-cbe from a host that supports Chromium. New CBE receipt links (mbreciept.cbe.com.et) do not need Puppeteer.'
                            : data.error || 'CBE verification failed',
                        details: data
                    }
                };
            }

            return {
                httpStatus: 200,
                body: {
                    verified: true,
                    type: 'cbe',
                    reference: result.transaction_id,
                    details: data
                }
            };
        } catch (verifyErr) {
            logger.error('CBE verification failed', { verifyErr });
            return {
                httpStatus: 500,
                body: {
                    verified: false,
                    type: 'cbe',
                    reference: result.transaction_id,
                    error: 'Verification failed for CBE'
                }
            };
        }
    }

    return { httpStatus: 422, body: { error: 'Unknown or unrecognized receipt type' } };
}

function cleanupUpload(filePath?: string): void {
    if (!filePath) return;
    try {
        fs.unlinkSync(filePath);
        logger.debug('Temp file deleted', { path: filePath });
    } catch {
        // ignore
    }
}

export const verifyImageHandler = [
    imageUpload.single('file'),

    async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.file) {
                logger.warn('No file uploaded');
                res.status(400).json({ error: 'No file uploaded' });
                return;
            }

            const outcome = await processReceiptImage(req.file.path, {
                autoVerify: req.query.autoVerify === 'true',
                accountSuffix: typeof req.body?.suffix === 'string' ? req.body.suffix : null
            });

            res.status(outcome.httpStatus).json(outcome.body);
        } catch (err) {
            logger.error(
                `Unexpected error in /verify-image: ${err instanceof Error ? err.message : String(err)}`,
                { stack: err instanceof Error ? err.stack : undefined }
            );
            res.status(500).json({ error: 'Something went wrong processing the image.' });
        } finally {
            cleanupUpload(req.file?.path);
        }
    }
];
