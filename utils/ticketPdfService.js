/**
 * utils/ticketPdfService.js — Canonical Server-Side Ticket V1.1 PDF Renderer
 * 
 * POPUTKI.ONLINE
 * Single Source of Truth matching PassengerTicket.vue design 1:1.
 */

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

/**
 * Resolves Cyrillic-capable font paths safely
 */
function getFontPaths() {
    const localDir = path.join(__dirname, '..', 'assets', 'fonts');
    const regPath = path.join(localDir, 'arial.ttf');
    const boldPath = path.join(localDir, 'arialbd.ttf');

    if (fs.existsSync(regPath) && fs.existsSync(boldPath)) {
        return { regular: regPath, bold: boldPath };
    }

    const winReg = 'C:\\Windows\\Fonts\\arial.ttf';
    const winBold = 'C:\\Windows\\Fonts\\arialbd.ttf';
    if (fs.existsSync(winReg) && fs.existsSync(winBold)) {
        return { regular: winReg, bold: winBold };
    }

    return null;
}

/**
 * Generates an authoritative PDF Buffer matching Ticket V1.1 layout.
 * 
 * @param {Object} projection - Canonical ticket projection from buildPassengerTicketProjection
 * @returns {Promise<Buffer>} PDF Buffer
 */
async function generateTicketPdf(projection) {
    if (!projection) {
        throw new Error('TICKET_PROJECTION_REQUIRED');
    }

    // Safely extract canonical properties from Ticket V1.1 projection
    const ticketNumber = projection.ticketNumber || 'POP-000000';
    const verificationUrl = projection.verificationUrl || `https://www.poputki.online/ticket/${projection.verificationToken || ''}`;

    const route = projection.route || {};
    const passenger = projection.passenger || {};
    const bus = projection.bus || {};
    const payment = projection.payment || {};
    const carrier = projection.carrier || {};
    const support = projection.support || {};

    const fromCity = route.fromCity || '—';
    const toCity = route.toCity || '—';
    const departureDate = route.departureDate || '—';
    const departureTime = route.departureTime || '—';
    const arrivalTime = route.arrivalTime || '';

    const passengerName = passenger.primaryName || 'Пассажир';
    const seats = Array.isArray(passenger.seats) && passenger.seats.length > 0 ? passenger.seats : [];
    const seatDisplay = seats.length > 0 ? seats.join(', ') : 'Без места / По посадке';

    // Floor calculation for double-decker buses matching PassengerTicket.vue
    let floorDisplay = null;
    if (bus.bus_type === 'double') {
        const sNum = seats[0] ? Number(seats[0]) : null;
        floorDisplay = (sNum && sNum <= 20) ? '1 ЭТАЖ' : (sNum ? '2 ЭТАЖ' : '1 ЭТАЖ');
    }

    // Bus description
    let busTitle = 'Автобус';
    if (bus.brand || bus.model) {
        busTitle = [bus.brand, bus.model].filter(Boolean).join(' ').trim();
    }
    const licensePlate = bus.license_plate || null;

    // Pricing & Payment breakdown
    const totalPrice = Number(payment.totalPrice || 0);
    const paidAmount = Number(payment.paidAmount || 0);
    const remainingAmount = Number(payment.remainingAmount || 0);
    const isManual = Boolean(payment.isManual);

    // Carrier & Escort
    const carrierName = carrier.companyName || 'Перевозчик POPUTKI.ONLINE';
    const escortName = support.name || null;
    const escortPhone = support.phone || null;

    // Generate QR Code PNG Buffer (High contrast, scalable)
    const qrBuffer = await QRCode.toBuffer(verificationUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: {
            dark: '#0f172a',
            light: '#ffffff'
        }
    });

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 36,
                info: {
                    Title: `POPUTKI-TICKET-${ticketNumber}`,
                    Author: 'POPUTKI.ONLINE',
                    Subject: 'Электронный билет / Маршрутный лист'
                }
            });

            const fontPaths = getFontPaths();
            if (fontPaths) {
                doc.registerFont('MainFont', fontPaths.regular);
                doc.registerFont('MainBold', fontPaths.bold);
                doc.font('MainFont');
            }

            const fontReg = fontPaths ? 'MainFont' : 'Helvetica';
            const fontBold = fontPaths ? 'MainBold' : 'Helvetica-Bold';

            const buffers = [];
            doc.on('data', b => buffers.push(b));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', err => reject(err));

            const primaryColor = '#2563eb';
            const darkText = '#0f172a';
            const grayText = '#64748b';
            const lightBg = '#f8fafc';
            const borderBg = '#cbd5e1';

            // --- HEADER BRANDING BAR ---
            doc.rect(36, 36, 523, 62).fill('#0f172a');
            
            doc.fillColor('#38bdf8').font(fontBold).fontSize(22).text('POPUTKI', 52, 48, { continued: true });
            doc.fillColor('#ffffff').fontSize(22).text('.ONLINE');

            doc.fillColor('#94a3b8').font(fontReg).fontSize(9).text('СЛУЖБА МЕЖДУГОРОДНИХ ПОЕЗДОК', 52, 74);

            // Ticket Number Tag (Top Right Pill)
            doc.rect(400, 48, 145, 38).fill('#1e293b');
            doc.fillColor('#94a3b8').font(fontReg).fontSize(8).text('ЭЛЕКТРОННЫЙ БИЛЕТ №', 410, 53);
            doc.fillColor('#38bdf8').font(fontBold).fontSize(14).text(ticketNumber, 410, 65);

            // Sub-header title line
            doc.fillColor(grayText).font(fontBold).fontSize(10).text('МАРШРУТНЫЙ ЛИСТ ПАССАЖИРА', 36, 112);
            doc.moveTo(36, 126).lineTo(559, 126).strokeColor(borderBg).lineWidth(1).stroke();

            // --- MAIN ROUTE CARD ---
            let y = 138;
            doc.rect(36, y, 523, 72).fill(lightBg).strokeColor(borderBg).lineWidth(1).stroke();
            
            doc.fillColor(grayText).font(fontReg).fontSize(9).text('МАРШРУТ СЛЕДОВАНИЯ', 52, y + 12);
            doc.fillColor(darkText).font(fontBold).fontSize(18).text(`${fromCity}  →  ${toCity}`, 52, y + 28);

            if (route.intermediateStops && route.intermediateStops.length > 0) {
                const stopsText = 'Промежуточные остановки: ' + route.intermediateStops.join(' — ');
                doc.fillColor(grayText).font(fontReg).fontSize(8.5).text(stopsText, 52, y + 54);
            }

            y += 86;

            // --- TRIP & SEAT DETAILS (2 COLUMNS) ---
            const colWidth = 252;
            const col1X = 36;
            const col2X = 307;

            // Column 1: Departure & Bus
            doc.rect(col1X, y, colWidth, 145).fill('#ffffff').strokeColor(borderBg).lineWidth(1).stroke();
            
            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ДАТА И ВРЕМЯ ОТПРАВЛЕНИЯ', col1X + 14, y + 12);
            doc.fillColor(primaryColor).font(fontBold).fontSize(14).text(`${departureDate} в ${departureTime}`, col1X + 14, y + 26);

            if (arrivalTime) {
                doc.fillColor(grayText).font(fontReg).fontSize(8.5).text(`Прибытие (ориентировочно): ${arrivalTime}`, col1X + 14, y + 46);
            }

            doc.moveTo(col1X + 14, y + 60).lineTo(col1X + colWidth - 14, y + 60).strokeColor('#f1f5f9').stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ТРАНСПОРТНОЕ СРЕДСТВО', col1X + 14, y + 70);
            doc.fillColor(darkText).font(fontBold).fontSize(11).text(busTitle, col1X + 14, y + 84);

            if (licensePlate) {
                doc.fillColor(grayText).font(fontReg).fontSize(9).text(`Гос. номер: ${licensePlate}`, col1X + 14, y + 100);
            }

            if (bus.bus_type === 'double') {
                doc.fillColor('#7c3aed').font(fontBold).fontSize(8.5).text('Двухэтажный автобус', col1X + 14, y + 118);
            }

            // Column 2: Passenger & Seat
            doc.rect(col2X, y, colWidth, 145).fill('#ffffff').strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ПАССАЖИР', col2X + 14, y + 12);
            doc.fillColor(darkText).font(fontBold).fontSize(13).text(passengerName, col2X + 14, y + 26);

            doc.moveTo(col2X + 14, y + 60).lineTo(col2X + colWidth - 14, y + 60).strokeColor('#f1f5f9').stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('МЕСТО В САЛОНЕ', col2X + 14, y + 70);
            doc.fillColor('#0284c7').font(fontBold).fontSize(16).text(`МЕСТО № ${seatDisplay}`, col2X + 14, y + 84);

            if (floorDisplay) {
                doc.rect(col2X + 14, y + 108, 80, 22).fill('#f3e8ff');
                doc.fillColor('#7c3aed').font(fontBold).fontSize(9).text(floorDisplay, col2X + 22, y + 114);
            }

            y += 160;

            // --- CARRIER & ESCORT SECTION ---
            doc.rect(36, y, 523, 65).fill(lightBg).strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ПЕРЕВОЗЧИК И СОПРОВОЖДЕНИЕ', 52, y + 10);
            doc.fillColor(darkText).font(fontBold).fontSize(11).text(carrierName, 52, y + 24);

            if (escortName) {
                const suppContact = `Сопровождающий на рейсе: ${escortName}` + (escortPhone ? ` (${escortPhone})` : '');
                doc.fillColor(grayText).font(fontReg).fontSize(9).text(suppContact, 52, y + 44);
            } else {
                doc.fillColor(grayText).font(fontReg).fontSize(8.5).text('Служба поддержки POPUTKI.ONLINE: www.poputki.online', 52, y + 44);
            }

            y += 78;

            // --- FINANCIAL BREAKDOWN & PAYMENT STATUS ---
            doc.rect(36, y, 523, 54).fill('#f1f5f9').strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('СТОИМОСТЬ БИЛЕТА', 52, y + 10);
            doc.fillColor(darkText).font(fontBold).fontSize(13).text(`${totalPrice} сомони`, 52, y + 26);

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('СТАТУС И ДЕТАЛИ ОПЛАТЫ', 290, y + 10);
            if (isManual) {
                doc.fillColor('#d97706').font(fontBold).fontSize(11).text(`Оплата на месте водителю: ${remainingAmount} сом.`, 290, y + 26);
            } else {
                doc.fillColor('#16a34a').font(fontBold).fontSize(11).text(`Оплачено онлайн: ${paidAmount} сом. (Водителю: ${remainingAmount} сом.)`, 290, y + 26);
            }

            y += 68;

            // --- SECURE QR VERIFICATION BOX ---
            const qrBoxY = y;
            doc.rect(36, qrBoxY, 523, 150).fill('#ffffff').strokeColor(primaryColor).lineWidth(1.5).stroke();

            // Embed QR Image (Left side of box)
            doc.image(qrBuffer, 52, qrBoxY + 10, { width: 130, height: 130 });

            // Verification Description (Right side of box)
            const qrTextX = 198;
            doc.fillColor(primaryColor).font(fontBold).fontSize(12).text('ПРОВЕРИТЬ ПОДЛИННОСТЬ БИЛЕТА', qrTextX, qrBoxY + 16);
            
            doc.fillColor(darkText).font(fontReg).fontSize(9).text(
                'Данный электронный билет защищен цифровой подписью POPUTKI.ONLINE.\n' +
                'Водитель или контролер может отсканировать QR-код камерой смартфона\n' +
                'для моментального подтверждения статуса и права на посадку.',
                qrTextX, qrBoxY + 36, { width: 340, lineGap: 3 }
            );

            doc.fillColor(grayText).font(fontReg).fontSize(8).text(
                `Прямая ссылка верификации:\n${verificationUrl}`,
                qrTextX, qrBoxY + 96, { width: 340, lineGap: 2 }
            );

            // --- FOOTER SECURITY DISCLAIMER ---
            const footerY = 770;
            doc.moveTo(36, footerY).lineTo(559, footerY).strokeColor(borderBg).lineWidth(1).stroke();
            doc.fillColor(grayText).font(fontReg).fontSize(7.5).text(
                'POPUTKI.ONLINE — Официальный сервис межгородских маршрутных перевозок. Настоящий документ является действительным электронным билетом.',
                36, footerY + 8, { align: 'center', width: 523 }
            );

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    generateTicketPdf,
    getFontPaths
};
