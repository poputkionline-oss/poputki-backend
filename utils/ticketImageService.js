/**
 * utils/ticketImageService.js — Ticket V1.1 High-Resolution PNG Image Renderer
 * 
 * POPUTKI.ONLINE
 * Single Source of Truth matching PassengerTicket.vue 1:1 via Puppeteer HTML screenshot.
 */

const fs = require('fs');
const path = require('path');
const { renderTicketHtml } = require('./ticketHtmlRenderer');

let puppeteerModule = null;
let chromiumModule = null;

async function loadPuppeteerModules() {
    if (!puppeteerModule) {
        const pMod = await import('puppeteer-core');
        puppeteerModule = pMod.default || pMod;
    }
    if (!chromiumModule) {
        const cMod = await import('@sparticuz/chromium');
        chromiumModule = cMod.default || cMod;
    }
    return { puppeteer: puppeteerModule, chromium: chromiumModule };
}

/**
 * Resolves local or production Chromium / Chrome executable path safely.
 */
async function getExecutablePath(chromium) {
    // Windows local development fallback
    const winChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const winEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (process.platform === 'win32') {
        if (fs.existsSync(winChrome)) return winChrome;
        if (fs.existsSync(winEdge)) return winEdge;
    }

    try {
        if (typeof chromium.executablePath === 'function') {
            const p = await chromium.executablePath();
            if (p && fs.existsSync(p)) return p;
        } else if (typeof chromium.executablePath === 'string' && fs.existsSync(chromium.executablePath)) {
            return chromium.executablePath;
        }
    } catch (e) {
        console.warn('[TicketImage] Chromium executable resolution notice:', e.message);
    }

    // Linux production fallback
    const linuxChrome = '/usr/bin/chromium-browser';
    if (fs.existsSync(linuxChrome)) return linuxChrome;

    throw new Error('NO_VALID_CHROMIUM_EXECUTABLE_FOUND');
}

/**
 * Generates a high-resolution PNG image buffer matching PassengerTicket.vue 1:1.
 * 
 * @param {Object} projection - Canonical ticket projection from buildPassengerTicketProjection
 * @returns {Promise<Buffer>} High-resolution PNG Buffer
 */
async function generateTicketPng(projection) {
    if (!projection) {
        throw new Error('TICKET_PROJECTION_REQUIRED');
    }

    const { puppeteer, chromium } = await loadPuppeteerModules();
    const htmlContent = await renderTicketHtml(projection);
    const execPath = await getExecutablePath(chromium);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args || ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: execPath,
            headless: true
        });

        const page = await browser.newPage();
        // High-DPI viewport (1400px width with scale factor 2 = 2800px crisp PNG)
        await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const element = await page.$('.ticket-outer-frame');
        if (!element) {
            throw new Error('TICKET_OUTER_FRAME_NOT_FOUND');
        }

        const pngBuffer = await element.screenshot({ type: 'png', omitBackground: true });
        return pngBuffer;
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

module.exports = {
    generateTicketPng
};
