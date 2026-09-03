const express = require('express');
const router = express.Router();

/**
 * Phase E.48.2: Retired Legacy Backend OCR Endpoint
 *
 * Active passport OCR was migrated to the Supabase Edge Function
 * (/functions/v1/ocr-passport) used directly by web and Flutter clients.
 * This legacy backend endpoint is permanently retired to eliminate attack
 * surface, prevent paid resource abuse (Cloudinary and 100OCRAPI), and
 * ensure zero passport PII is processed or stored through the Node backend.
 */

/**
 * @swagger
 * /api/ocr/passport:
 *   post:
 *     summary: Retired endpoint (passport OCR migrated to Supabase Edge Function)
 *     tags: [OCR]
 *     responses:
 *       410:
 *         description: OCR endpoint retired
 */
router.post('/passport', (req, res) => {
    return res.status(410).json({ error: 'OCR endpoint retired' });
});

module.exports = router;
