/**
 * utils/ticketPdfService.js — PDF Ticket Generator for Ticket V1.1
 * 
 * POPUTKI.ONLINE
 */

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

/**
 * Resolves font paths safely with fallback
 */
function getFontPaths() {
    const localDir = path.join(__dirname, '..', 'assets', 'fonts');
    const regPath = path.join(localDir, 'arial.ttf');
    const boldPath = path.join(localDir, 'arialbd.ttf');

    if (fs.existsSync(regPath) && fs.existsSync(boldPath)) {
        return { regular: regPath, bold: boldPath };
    }

    // Windows fallback
    const winReg = 'C:\\Windows\\Fonts\\arial.ttf';
    const winBold = 'C:\\Windows\\Fonts\\arialbd.ttf';
    if (fs.existsSync(winReg) && fs.existsSync(winBold)) {
        return { regular: winReg, bold: winBold };
    }

    return null;
}

/**
 * Generates a clean, professional PDF Buffer matching Ticket V1.1 specs.
 * 
 * @param {Object} projection - Ticket projection object from buildPassengerTicketProjection
 * @returns {Promise<Buffer>} PDF Buffer
 */
async function generateTicketPdf(projection) {
    if (!projection) {
        throw new Error('TICKET_PROJECTION_REQUIRED');
    }

    // Generate QR Code PNG Buffer
    const verificationUrl = projection.verificationUrl || `https://www.poputki.online/ticket/${projection.verificationToken || ''}`;
    const qrBuffer = await QRCode.toBuffer(verificationUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 300,
        color: {
            dark: '#1e293b',
            light: '#ffffff'
        }
    });

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 36,
                info: {
                    Title: `POPUTKI-TICKET-${projection.ticketNumber || 'POP-000000'}`,
                    Author: 'POPUTKI.ONLINE',
                    Subject: 'Электронный билет на рейс'
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

            const primaryColor = '#2563eb'; // Poputki blue
            const darkText = '#1e293b';
            const grayText = '#64748b';
            const lightBg = '#f8fafc';
            const borderBg = '#e2e8f0';

            // --- HEADER BRANDING ---
            doc.rect(36, 36, 523, 60).fill('#0f172a');
            
            doc.fillColor('#38bdf8').font(fontBold).fontSize(20).text('POPUTKI', 50, 48, { continued: true });
            doc.fillColor('#ffffff').fontSize(20).text('.ONLINE');

            doc.fillColor('#94a3b8').font(fontReg).fontSize(10).text('СЛУЖБА МЕЖДУГОРОДНИХ ПОЕЗДОК', 50, 72);

            // Ticket Number Tag (Top Right)
            doc.rect(410, 48, 135, 36).fill('#1e293b');
            doc.fillColor('#94a3b8').font(fontReg).fontSize(8).text('БИЛЕТ №', 420, 53);
            doc.fillColor('#38bdf8').font(fontBold).fontSize(13).text(projection.ticketNumber || 'POP-000000', 420, 65);

            // Sub-header title
            doc.fillColor(grayText).font(fontBold).fontSize(11).text('ЭЛЕКТРОННЫЙ БИЛЕТ / МАРШРУТНЫЙ ЛИСТ', 36, 110);
            doc.moveTo(36, 126).lineTo(559, 126).strokeColor(borderBg).lineWidth(1).stroke();

            // --- MAIN CARD ---
            let y = 140;

            // Route Section
            doc.rect(36, y, 523, 70).fill(lightBg).strokeColor(borderBg).lineWidth(1).stroke();
            
            const fromCity = projection.route?.fromCity || '—';
            const toCity = projection.route?.toCity || '—';

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('МАРШРУТ СЛЕДОВАНИЯ', 50, y + 10);
            doc.fillColor(darkText).font(fontBold).fontSize(18).text(`${fromCity}  →  ${toCity}`, 50, y + 26);

            if (projection.route?.intermediateStops && projection.route.intermediateStops.length > 0) {
                const stopsText = 'Через: ' + projection.route.intermediateStops.join(', ');
                doc.fillColor(grayText).font(fontReg).fontSize(9).text(stopsText, 50, y + 52);
            }

            y += 85;

            // --- TRIP & SEAT DETAILS (2 COLUMNS) ---
            const colWidth = 250;
            const col1X = 36;
            const col2X = 309;

            // Column 1: Departure & Bus
            doc.rect(col1X, y, colWidth, 140).fill('#ffffff').strokeColor(borderBg).lineWidth(1).stroke();
            
            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ДАТА И ВРЕМЯ ОТПРАВЛЕНИЯ', col1X + 12, y + 10);
            doc.fillColor(primaryColor).font(fontBold).fontSize(14).text(`${projection.departureDate || '—'} в ${projection.departureTime || '—'}`, col1X + 12, y + 24);

            if (projection.arrivalTime) {
                doc.fillColor(grayText).font(fontReg).fontSize(8).text(`Прибытие (ориент.): ${projection.arrivalTime}`, col1X + 12, y + 42);
            }

            doc.moveTo(col1X + 12, y + 56).lineTo(col1X + colWidth - 12, y + 56).strokeColor('#f1f5f9').stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ТРАНСПОРТНОЕ СРЕДСТВО', col1X + 12, y + 66);
            const busTitle = projection.bus?.model ? `${projection.bus.brand || ''} ${projection.bus.model}`.trim() : 'Автобус / Микроавтобус';
            doc.fillColor(darkText).font(fontBold).fontSize(11).text(busTitle, col1X + 12, y + 80);

            if (projection.bus?.license_plate) {
                doc.fillColor(grayText).font(fontReg).fontSize(9).text(`Гос. номер: ${projection.bus.license_plate}`, col1X + 12, y + 96);
            }

            if (projection.bus?.bus_type === 'double') {
                doc.fillColor('#7c3aed').font(fontBold).fontSize(9).text('Двухэтажный автобус', col1X + 12, y + 112);
            }

            // Column 2: Passenger & Seat
            doc.rect(col2X, y, colWidth, 140).fill('#ffffff').strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ПАССАЖИР', col2X + 12, y + 10);
            doc.fillColor(darkText).font(fontBold).fontSize(12).text(projection.passenger?.name || 'Пассажир', col2X + 12, y + 24);

            doc.moveTo(col2X + 12, y + 56).lineTo(col2X + colWidth - 12, y + 56).strokeColor('#f1f5f9').stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('МЕСТО В САЛОНЕ', col2X + 12, y + 66);
            const seatText = (projection.passenger?.seats && projection.passenger.seats.length > 0)
                ? projection.passenger.seats.join(', ')
                : 'Без места / По посадке';
            doc.fillColor('#0284c7').font(fontBold).fontSize(16).text(`МЕСТО № ${seatText}`, col2X + 12, y + 80);

            if (projection.bus?.bus_type === 'double' && projection.passenger?.seats?.[0]) {
                const sNum = Number(projection.passenger.seats[0]);
                const floorText = sNum <= 20 ? '1 ЭТАЖ' : '2 ЭТАЖ';
                doc.fillColor('#7c3aed').font(fontBold).fontSize(9).text(`Расположение: ${floorText}`, col2X + 12, y + 104);
            }

            y += 155;

            // --- CARRIER & SUPPORT SECTION ---
            doc.rect(36, y, 523, 65).fill(lightBg).strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('ПЕРЕВОЗЧИК И ПОДДЕРЖКА', 50, y + 10);
            const carrierName = projection.carrier?.name || 'Официальный перевозчик POPUTKI.ONLINE';
            doc.fillColor(darkText).font(fontBold).fontSize(11).text(carrierName, 50, y + 24);

            if (projection.support?.name) {
                const suppContact = `Сопровождающий: ${projection.support.name}` + (projection.support.phone ? ` (${projection.support.phone})` : '');
                doc.fillColor(grayText).font(fontReg).fontSize(9).text(suppContact, 50, y + 42);
            } else {
                doc.fillColor(grayText).font(fontReg).fontSize(8).text('Поддержка POPUTKI.ONLINE: www.poputki.online', 50, y + 42);
            }

            y += 80;

            // --- FINANCIAL BREAKDOWN & PAYMENT STATUS ---
            doc.rect(36, y, 523, 50).fill('#f1f5f9').strokeColor(borderBg).lineWidth(1).stroke();

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('СТОИМОСТЬ ПОЕЗДКИ', 50, y + 10);
            doc.fillColor(darkText).font(fontBold).fontSize(12).text(`${projection.pricing?.totalPrice || 0} сомони`, 50, y + 26);

            const isManual = projection.isManual;
            const paidOnline = projection.pricing?.paidOnline || 0;
            const remaining = projection.pricing?.remainingToCarrier || 0;

            doc.fillColor(grayText).font(fontReg).fontSize(9).text('СТАТУС ОПЛАТЫ', 300, y + 10);
            if (isManual) {
                doc.fillColor('#d97706').font(fontBold).fontSize(11).text(`К оплате водителю: ${remaining} сомони`, 300, y + 26);
            } else {
                doc.fillColor('#16a34a').font(fontBold).fontSize(11).text(`Оплачено онлайн: ${paidOnline} сом. (К оплате на месте: ${remaining} сом.)`, 300, y + 26);
            }

            y += 65;

            // --- SECURE QR VERIFICATION BOX ---
            const qrBoxY = y;
            doc.rect(36, qrBoxY, 523, 150).fill('#ffffff').strokeColor(primaryColor).lineWidth(1.5).stroke();

            // Embed QR Image (Left side of box)
            doc.image(qrBuffer, 50, qrBoxY + 10, { width: 130, height: 130 });

            // Verification Description (Right side of box)
            const qrTextX = 200;
            doc.fillColor(primaryColor).font(fontBold).fontSize(12).text('ПРОВЕРИТЬ ПОДЛИННОСТЬ БИЛЕТА', qrTextX, qrBoxY + 18);
            
            doc.fillColor(darkText).font(fontReg).fontSize(9).text(
                'Данный билет защищен цифровой подписью POPUTKI.ONLINE.\n' +
                'Водитель или контролер может отсканировать QR-код кассовым сканером\n' +
                'или камерой смартфона для моментальной проверки статуса бронирования.',
                qrTextX, qrBoxY + 38, { width: 340, lineGap: 3 }
            );

            doc.fillColor(grayText).font(fontReg).fontSize(8).text(
                `Ссылка верификации:\n${verificationUrl}`,
                qrTextX, qrBoxY + 95, { width: 340, lineGap: 2 }
            );

            // --- FOOTER SECURITY DISCLAIMER ---
            const footerY = 770;
            doc.moveTo(36, footerY).lineTo(559, footerY).strokeColor(borderBg).lineWidth(1).stroke();
            doc.fillColor(grayText).font(fontReg).fontSize(7.5).text(
                'POPUTKI.ONLINE — Автоматизированная система бронирования межгородских поездок. Билет действителен при предъявлении документа, удостоверяющего личность.',
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
