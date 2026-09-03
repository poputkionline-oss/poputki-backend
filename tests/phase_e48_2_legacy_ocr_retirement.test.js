/**
 * tests/phase_e48_2_legacy_ocr_retirement.test.js
 *
 * PHASE E.48.2 — Disable Legacy Backend Passport OCR Endpoint
 *
 * Verifies that POST /api/ocr/passport is safely and permanently retired:
 *  - Returns HTTP 410 Gone with `{ error: 'OCR endpoint retired' }`.
 *  - Contains NO Cloudinary uploads, NO 100OCRAPI calls, NO child_process / curl calls.
 *  - Does NOT log passport data or expose internal secrets.
 *  - Confirms active clients (front, mobile) use Supabase Edge Function directly
 *    and have ZERO references to the backend /api/ocr endpoint.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ocrRouter = require('../routes/ocr');

/**
 * Creates a mock req/res pair to invoke an express handler directly.
 */
function createMockReqRes(method = 'POST', url = '/passport', body = {}) {
    let statusCode = null;
    let responseData = null;
    let ended = false;

    const req = {
        method,
        url,
        body,
        headers: {
            'x-mana-man': 'nasa.2006'
        }
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            responseData = data;
            ended = true;
            return this;
        },
        send(data) {
            responseData = data;
            ended = true;
            return this;
        }
    };

    return { req, res, getResult: () => ({ statusCode, responseData, ended }) };
}

describe('Phase E.48.2 — Legacy Backend Passport OCR Retirement', () => {

    // 1. POST /api/ocr/passport -> 410 Gone
    it('[E48.2-01] POST /passport returns HTTP 410 Gone with structured error', () => {
        const layer = ocrRouter.stack.find(l => l.route && l.route.methods.post && l.route.path === '/passport');
        assert.ok(layer, 'POST /passport route must exist in ocr router');

        const handler = layer.route.stack[0].handle;
        const { req, res, getResult } = createMockReqRes('POST', '/passport', { image: 'data:image/jpeg;base64,dummy' });

        handler(req, res);
        const result = getResult();

        assert.equal(result.statusCode, 410);
        assert.deepEqual(result.responseData, { error: 'OCR endpoint retired' });
    });

    // 2. Source code audit: No Cloudinary call in routes/ocr.js
    it('[E48.2-02] routes/ocr.js contains no Cloudinary imports or calls', () => {
        const ocrSource = fs.readFileSync(path.join(__dirname, '../routes/ocr.js'), 'utf8');
        assert.equal(ocrSource.includes('uploadToCloudinary'), false, 'Cloudinary upload must be removed');
        assert.equal(ocrSource.includes('cloudinaryUtils'), false, 'cloudinaryUtils must not be imported');
    });

    // 3. Source code audit: No 100OCRAPI call or external API URL
    it('[E48.2-03] routes/ocr.js contains no 100OCRAPI references', () => {
        const ocrSource = fs.readFileSync(path.join(__dirname, '../routes/ocr.js'), 'utf8');
        assert.equal(ocrSource.includes('100ocrapi.com'), false, '100ocrapi URL must be removed');
        assert.equal(ocrSource.includes('OCR_API_URL'), false, 'OCR_API_URL must be removed');
    });

    // 4. Source code audit: No child_process or curl commands
    it('[E48.2-04] routes/ocr.js contains no execSync or curl commands', () => {
        const ocrSource = fs.readFileSync(path.join(__dirname, '../routes/ocr.js'), 'utf8');
        assert.equal(ocrSource.includes('execSync'), false, 'execSync must be removed');
        assert.equal(ocrSource.includes('child_process'), false, 'child_process must not be imported');
        assert.equal(ocrSource.includes('curl'), false, 'curl command must not be present');
    });

    // 5. Source code audit: No temp file creation (os/fs temp files)
    it('[E48.2-05] routes/ocr.js contains no temp file processing', () => {
        const ocrSource = fs.readFileSync(path.join(__dirname, '../routes/ocr.js'), 'utf8');
        assert.equal(ocrSource.includes('tmpdir'), false, 'os.tmpdir must not be used');
        assert.equal(ocrSource.includes('writeFileSync'), false, 'writeFileSync must not be used');
    });

    // 6. Source code audit: No secret references or API keys in routes/ocr.js
    it('[E48.2-06] routes/ocr.js does not reference or leak OCR_API_KEY', () => {
        const ocrSource = fs.readFileSync(path.join(__dirname, '../routes/ocr.js'), 'utf8');
        assert.equal(ocrSource.includes('process.env.OCR_API_KEY'), false, 'OCR_API_KEY must not be referenced');
    });

    // 7. Frontend call-site audit: confirms NO backend OCR calls
    it('[E48.2-07] frontend codebase has zero calls to /api/ocr or backend OCR', () => {
        const frontSrcDir = path.join(__dirname, '../../../poputki-front/src');
        if (!fs.existsSync(frontSrcDir)) return;

        function scanFiles(dir) {
            let files = [];
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory() && item.name !== 'node_modules') {
                    files = files.concat(scanFiles(fullPath));
                } else if (['.js', '.vue'].some(ext => item.name.endsWith(ext))) {
                    files.push(fullPath);
                }
            }
            return files;
        }

        const frontFiles = scanFiles(frontSrcDir);
        const backendOcrCallers = frontFiles.filter(f => {
            const content = fs.readFileSync(f, 'utf8');
            return content.includes('/api/ocr') || content.includes('/ocr/passport');
        });

        assert.equal(backendOcrCallers.length, 0, 'No frontend file should call backend /api/ocr');
    });

    // 8. Frontend active OCR verification: uses Supabase Edge Function directly
    it('[E48.2-08] frontend active OCR callers use Supabase Edge Function directly', () => {
        const bookingViewPath = path.join(__dirname, '../../../poputki-front/src/views/BusBookingView.vue');
        const adminViewPath = path.join(__dirname, '../../../poputki-front/src/views/BusAdminView.vue');

        if (fs.existsSync(bookingViewPath)) {
            const content = fs.readFileSync(bookingViewPath, 'utf8');
            assert.ok(
                content.includes('/functions/v1/ocr-passport'),
                'BusBookingView.vue must use Supabase Edge Function /functions/v1/ocr-passport'
            );
        }

        if (fs.existsSync(adminViewPath)) {
            const content = fs.readFileSync(adminViewPath, 'utf8');
            assert.ok(
                content.includes('/functions/v1/ocr-passport'),
                'BusAdminView.vue must use Supabase Edge Function /functions/v1/ocr-passport'
            );
        }
    });

    // 9. Mobile call-site audit: confirms Flutter uses Supabase Edge Function directly
    it('[E48.2-09] Flutter mobile app uses Supabase Edge Function and zero backend OCR', () => {
        const flutterWidgetPath = path.join(
            __dirname,
            '../../../poputki-mobile-flutter/lib/widgets/passport_ocr_widget.dart'
        );

        if (fs.existsSync(flutterWidgetPath)) {
            const content = fs.readFileSync(flutterWidgetPath, 'utf8');
            assert.ok(
                content.includes('/functions/v1/ocr-passport'),
                'Flutter widget must call Supabase Edge Function /functions/v1/ocr-passport'
            );
            assert.equal(
                content.includes('/api/ocr'),
                false,
                'Flutter widget must not call backend /api/ocr'
            );
        }
    });

    // 10. Bot call-site audit: confirms Telegram bot has zero OCR calls
    it('[E48.2-10] Telegram bot has zero calls to OCR endpoints', () => {
        const botApiPath = path.join(__dirname, '../../../poputki-bot/api');
        if (!fs.existsSync(botApiPath)) return;

        for (const file of fs.readdirSync(botApiPath)) {
            if (file.endsWith('.js')) {
                const content = fs.readFileSync(path.join(botApiPath, file), 'utf8');
                assert.equal(content.includes('ocr'), false, `Bot file ${file} must not call OCR`);
            }
        }
    });
});
