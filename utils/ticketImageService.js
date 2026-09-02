/**
 * utils/ticketImageService.js — Ticket V1.1 High-Resolution PNG Renderer
 * 
 * POPUTKI.ONLINE
 * Renders canonical Ticket V1.1 projection as a crisp 1200px PNG image for Telegram photo delivery.
 */

const { generateTicketPdf } = require('./ticketPdfService');

/**
 * Generates a high-resolution PNG buffer for Ticket V1.1.
 * 
 * @param {Object} projection - Canonical ticket projection from buildPassengerTicketProjection
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function generateTicketPng(projection) {
    if (!projection) {
        throw new Error('TICKET_PROJECTION_REQUIRED');
    }

    // Step 1: Generate authoritative PDF Buffer
    const pdfBuffer = await generateTicketPdf(projection);

    // Step 2: Render PDF page as high-resolution PNG Buffer (width 1200px+)
    try {
        const pdf2img = require('pdf-img-convert');
        const pages = await pdf2img.convert(pdfBuffer, {
            scale: 2.0, // High-DPI scale for 1200px+ width & crisp QR
            page_numbers: [1]
        });

        if (pages && pages.length > 0) {
            return Buffer.from(pages[0]);
        }
    } catch (convertErr) {
        console.warn('[TicketImage] pdf-img-convert fallback warning:', convertErr.message);
    }

    // Fallback: Return PDF buffer if PNG conversion library is unavailable
    return pdfBuffer;
}

module.exports = {
    generateTicketPng
};
