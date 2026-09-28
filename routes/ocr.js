const express = require('express');
const router = express.Router();
const { recognizePassportDocument } = require('../services/aiDocumentRecognitionService');

// Simple in-memory rate limiter per IP: max 15 scan requests per 15 minutes window
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 15;

function checkRateLimit(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

    if (now > record.resetAt) {
        record.count = 1;
        record.resetAt = now + RATE_LIMIT_WINDOW_MS;
    } else {
        record.count += 1;
    }

    rateLimitMap.set(ip, record);
    return record.count <= MAX_REQUESTS_PER_WINDOW;
}

// Clean stale rate limit entries periodically (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now > record.resetAt) {
            rateLimitMap.delete(ip);
        }
    }
}, 10 * 60 * 1000).unref?.();

/**
 * @swagger
 * /api/ocr/passport:
 *   post:
 *     summary: Legacy retired endpoint
 *     tags: [OCR]
 *     responses:
 *       410:
 *         description: Legacy endpoint retired. Use /api/ocr/scan instead.
 */
router.post('/passport', (req, res) => {
    return res.status(410).json({ error: 'OCR endpoint retired' });
});

/**
 * @swagger
 * /api/ocr/scan:
 *   post:
 *     summary: Multimodal AI Passport Scanner using OpenAI Vision
 *     tags: [OCR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Base64 data URIs of 1 to 4 document images
 *     responses:
 *       200:
 *         description: Structured document extraction result
 *       400:
 *         description: Invalid input images or payload size
 *       429:
 *         description: Rate limit exceeded
 *       503:
 *         description: OpenAI API key missing or service unavailable
 */
router.post('/scan', async (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Слишком много запросов на сканирование. Пожалуйста, подождите несколько минут.'
        });
    }

    try {
        let images = req.body.images;

        // Support single image `img` or `image` for backward compatibility
        if (!images && (req.body.img || req.body.image)) {
            images = [req.body.img || req.body.image];
        }

        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({
                error: 'INVALID_INPUT',
                message: 'Укажите от 1 до 4 изображений документа в параметре images[]'
            });
        }

        const result = await recognizePassportDocument(images);

        return res.json({
            status: 'OK',
            data: result
        });
    } catch (err) {
        // Redact any PII or Base64 from console logs
        const safeErrorMsg = err.message ? err.message.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED_BASE64]') : 'Internal error';
        console.error('[AI Passport Scanner Error]:', safeErrorMsg);

        const statusCode = err.statusCode || 500;
        const userFriendlyMessage = (err.code === 'OPENAI_API_KEY_MISSING' || err.code === 'OPENAI_TIMEOUT' || err.code === 'OPENAI_RATE_LIMIT')
            ? 'Не удалось автоматически распознать документ. Вы можете повторить попытку или ввести данные вручную.'
            : (err.message || 'Ошибка распознавания документа');

        return res.status(statusCode).json({
            error: err.code || 'AI_SCANNER_ERROR',
            message: userFriendlyMessage
        });
    }
});

module.exports = router;
