const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { uploadToCloudinary } = require('../utils/cloudinaryUtils');

const OCR_API_KEY = process.env.OCR_API_KEY;
const OCR_API_URL = 'https://api.100ocrapi.com/v1/passport';

/**
 * @swagger
 * /api/ocr/passport:
 *   post:
 *     summary: Extract passport data from image
 *     tags: [OCR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 description: Base64 encoded image string (Data URI)
 */
router.post('/passport', async (req, res) => {
    const { image } = req.body;

    if (!image) {
        return res.status(400).json({ error: 'Image is required' });
    }

    try {
        // 1. Strip the Data URI prefix to get raw base64
        const base64Data = image.includes(',') ? image.split(',')[1] : image;

        // 2. Upload to Cloudinary for storage
        console.log('[OCR] Uploading passport image to Cloudinary...');
        const cloudinaryResult = await uploadToCloudinary(image, {
            folder: 'poputki/passports',
            tags: ['passport', 'ocr']
        });
        console.log('[OCR] Image uploaded to Cloudinary:', cloudinaryResult.url);

        // 3. Call 100OCRAPI using curl (bypasses Cloudflare TLS fingerprinting that blocks axios/node)
        console.log('[OCR] Calling 100OCRAPI via curl...');

        // Write base64 to a temp file to avoid shell argument size limits
        const tmpFile = path.join(os.tmpdir(), `ocr_${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, base64Data);

        try {
            const curlCmd = `curl -s --location --request POST '${OCR_API_URL}' ` +
                `--header 'Content-Type: application/x-www-form-urlencoded' ` +
                `--header 'X-API-Key: ${OCR_API_KEY}' ` +
                `--data-urlencode 'img@${tmpFile}'`;

            const rawResponse = execSync(curlCmd, {
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024
            }).toString();

            console.log('[OCR] 100OCRAPI raw response:', rawResponse.substring(0, 500));

            const data = JSON.parse(rawResponse);

            // 4. Check for API errors
            if (data.status !== 'OK') {
                console.error('[OCR] API returned error status:', data.status, data.message);
                return res.status(400).json({
                    error: 'OCR recognition failed',
                    details: data.message || data.status
                });
            }

            // 5. Map response to our passenger format
            const msg = data.message;

            // Parse full name — API returns "LASTNAME FIRSTNAME" or "LASTNAME, FIRSTNAME"
            let lastName = '';
            let firstName = '';
            if (msg.name) {
                const nameParts = msg.name.replace(',', '').trim().split(/\s+/);
                lastName = nameParts[0] || '';
                firstName = nameParts.slice(1).join(' ') || '';
            }

            // Parse birthDay from "YYYYMMDD" → "YYYY-MM-DD"
            let birthDate = '';
            if (msg.birthDay && msg.birthDay.length === 8) {
                birthDate = `${msg.birthDay.slice(0, 4)}-${msg.birthDay.slice(4, 6)}-${msg.birthDay.slice(6, 8)}`;
            }

            const result = {
                firstName,
                lastName,
                middleName: '',
                birthDate,
                docNumber: msg.passportNumber || '',
                gender: msg.gender === 'M' ? 'male' : (msg.gender === 'F' ? 'female' : ''),
                citizenship: msg.nationality || 'Таджикистан'
            };

            res.json(result);
        } finally {
            // Clean up temp file
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    } catch (err) {
        console.error('[OCR] Error:', err.message);
        res.status(500).json({
            error: 'Failed to process passport',
            details: err.message
        });
    }
});

module.exports = router;
