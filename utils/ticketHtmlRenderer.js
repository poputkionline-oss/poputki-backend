/**
 * utils/ticketHtmlRenderer.js — Canonical Ticket V1.1 HTML/CSS Renderer
 * 
 * POPUTKI.ONLINE
 * Single Source of Truth matching PassengerTicket.vue design 1:1.
 */

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

let cachedLogoBase64 = null;

function getLogoBase64() {
    if (cachedLogoBase64) return cachedLogoBase64;
    try {
        const logoPath = path.join(__dirname, '..', '..', 'poputki-front', 'src', 'assets', 'logo-itself.png');
        if (fs.existsSync(logoPath)) {
            const buf = fs.readFileSync(logoPath);
            cachedLogoBase64 = `data:image/png;base64,${buf.toString('base64')}`;
            return cachedLogoBase64;
        }
    } catch (e) {
        console.warn('[TicketHtmlRenderer] Logo file read warning:', e.message);
    }
    return '';
}

/**
 * Generates an authoritative HTML string matching PassengerTicket.vue 1:1.
 * 
 * @param {Object} projection - Canonical ticket projection from buildPassengerTicketProjection
 * @returns {Promise<string>} HTML document string
 */
async function renderTicketHtml(projection) {
    if (!projection) {
        throw new Error('TICKET_PROJECTION_REQUIRED');
    }

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
    const arrivalDate = route.arrivalDate || route.departureDate || '—';
    const arrivalTime = route.arrivalTime || '—';
    const pickupAddress = route.fromAddress || `г. ${fromCity}`;
    const dropOffAddress = route.toAddress || `г. ${toCity}`;

    const passengerName = passenger.primaryName || 'Пассажир';
    const seats = Array.isArray(passenger.seats) && passenger.seats.length > 0 ? passenger.seats : [];
    const seatDisplay = seats.length > 0 ? seats.join(', ') : '—';

    // Floor calculation matching PassengerTicket.vue
    let floorDisplay = null;
    if (bus.bus_type === 'double') {
        const sNum = seats[0] ? Number(seats[0]) : null;
        floorDisplay = (sNum && sNum <= 20) ? '1 ЭТАЖ' : (sNum ? '2 ЭТАЖ' : '1 ЭТАЖ');
    }

    // Bus description
    const busBrand = bus.brand || 'Setra';
    const busModel = bus.model || 'S431DT';
    const busTypeDisplay = bus.bus_type === 'double' ? 'Двухэтажный' : 'Комфорт-класс';
    const licensePlate = bus.license_plate || '5051ZA20';

    // Route display
    let fullRouteDisplay = `${fromCity} — ${toCity}`;
    if (route.intermediateStops && route.intermediateStops.length > 0) {
        fullRouteDisplay = `${fromCity} — ${route.intermediateStops.join(' — ')} — ${toCity}`;
    }

    // Pricing & Payment breakdown
    const totalPrice = Number(payment.totalPrice || 0);
    const paidAmount = Number(payment.paidAmount || 0);
    const remainingAmount = Number(payment.remainingAmount || 0);

    // Carrier & Support
    const carrierName = carrier.companyName || 'ООО «Рохи Абрешим»';
    const escortName = support.name || null;
    const escortPhone = support.phone || null;
    const escortWhatsapp = support.whatsapp || null;

    const logoBase64 = getLogoBase64();

    // Generate high-resolution QR SVG
    let qrSvg = '';
    try {
        qrSvg = await QRCode.toString(verificationUrl, {
            type: 'svg',
            margin: 1,
            color: { dark: '#0f172a', light: '#ffffff' }
        });
    } catch (qrErr) {
        console.error('QR SVG error:', qrErr.message);
    }

    // Amenities
    const amenities = Array.isArray(bus.amenities) ? bus.amenities : [];
    const hasPower = amenities.includes('power_220v') || amenities.includes('usb');
    const hasWifi = amenities.includes('wifi');
    const hasAc = amenities.includes('ac');
    const hasKitchen = amenities.includes('kitchen');
    const hasWc = amenities.includes('wc');
    const hasAnyAmenities = amenities.length > 0;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>POPUTKI.ONLINE Ticket ${ticketNumber}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: #ffffff;
            margin: 0;
            padding: 16px;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .ticket-outer-frame {
            box-sizing: border-box;
            width: 850px;
            background: #ffffff;
            padding: 8px;
            border-radius: 22px;
            border: 2.5px solid #f59e0b;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
        }
        .ticket-inner-box {
            border: 2px solid #f59e0b;
            border-radius: 16px;
            padding: 16px;
            background: #ffffff;
            position: relative;
        }
        .qr-svg svg {
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body>

    <div class="ticket-outer-frame">
        <div class="ticket-inner-box">

            <!-- TOP HEADER: LOGO + BRAND + TITLE + RIGHT QR CARD -->
            <div class="flex flex-row items-start justify-between gap-3 pb-2 border-b border-amber-400/50 relative">
                <div class="space-y-1 min-w-0 flex-1">
                    <div class="flex items-center gap-3">
                        ${logoBase64 ? `<img src="${logoBase64}" alt="Logo" class="w-14 h-14 object-contain shrink-0" />` : ''}
                        <div>
                            <div class="text-[28px] font-black tracking-tight text-slate-900 leading-none">
                                POPUTKI.ONLINE
                            </div>
                            <div class="text-[10.5px] font-bold text-slate-600 tracking-[0.2em] uppercase mt-0.5">
                                ПОЕЗДКИ С ДОВЕРИЕМ
                            </div>
                        </div>
                    </div>

                    <div class="pt-1">
                        <h1 class="text-lg font-black text-slate-900 tracking-wide uppercase leading-tight">
                            ЭЛЕКТРОННЫЙ БИЛЕТ / МАРШРУТНЫЙ ЛИСТ
                        </h1>
                        <div class="flex items-center gap-3 text-[10.5px] text-slate-600 font-semibold mt-0.5 flex-wrap">
                            <div class="flex items-center gap-1">
                                <span>🌐</span>
                                <span>Оформлено через: <strong class="text-amber-600 font-bold">POPUTKI.ONLINE</strong></span>
                            </div>
                            <span class="text-slate-300 font-normal">|</span>
                            <div class="flex items-center gap-1">
                                <span>🏢</span>
                                <span>Перевозчик: <strong class="text-slate-900 font-bold">${carrierName}</strong></span>
                            </div>
                            <span class="text-slate-300 font-normal">|</span>
                            <div class="flex items-center gap-1">
                                <span>🎫</span>
                                <span>Билет № <strong class="text-slate-900 font-mono font-bold">${ticketNumber}</strong></span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right Verification QR Card -->
                <div class="border-[2px] border-amber-500 rounded-xl p-1.5 bg-white flex flex-col items-center justify-center text-center shrink-0 w-32 shadow-sm">
                    <div class="text-[8.5px] font-black text-amber-600 uppercase tracking-tight leading-tight mb-0.5 text-center">
                        ПРОВЕРИТЬ<br/>ПОДЛИННОСТЬ БИЛЕТА
                    </div>
                    <div class="w-20 h-20 flex items-center justify-center overflow-hidden qr-svg">
                        ${qrSvg}
                    </div>
                    <div class="text-[8px] font-black text-slate-800 tracking-wider mt-0.5 uppercase font-mono">
                        POPUTKI.ONLINE
                    </div>
                </div>
            </div>

            <!-- TOP ROUTE & BUS SUMMARY ROW -->
            <div class="grid grid-cols-12 gap-2.5 py-2 px-3 bg-amber-50/40 rounded-xl border border-amber-300/60 my-2">
                <div class="col-span-6 flex items-start gap-2.5 min-w-0">
                    <div class="w-7 h-7 rounded-full bg-amber-500 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-sm mt-0.5">
                        A
                    </div>
                    <div class="min-w-0">
                        <div class="text-[8.5px] font-black uppercase tracking-wider text-slate-500">МАРШРУТ:</div>
                        <div class="text-[13px] font-black text-amber-700 leading-snug break-words mt-0.5">
                            ${fullRouteDisplay}
                        </div>
                    </div>
                </div>

                <div class="col-span-3 flex items-start gap-2.5 min-w-0 border-l border-amber-200/60 pl-2.5">
                    <div class="w-7 h-7 rounded-full bg-amber-500 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-sm mt-0.5">
                        🚌
                    </div>
                    <div class="min-w-0">
                        <div class="text-[8.5px] font-black uppercase tracking-wider text-slate-500">АВТОБУС:</div>
                        <div class="text-xs font-bold text-slate-800 leading-tight mt-0.5">
                            <span class="block font-black text-slate-900">${busBrand} ${busModel}</span>
                            <span class="text-[10px] text-slate-500">${busTypeDisplay}</span>
                        </div>
                    </div>
                </div>

                <div class="col-span-3 flex items-start gap-2.5 min-w-0 border-l border-amber-200/60 pl-2.5">
                    <div class="w-7 h-7 rounded-full bg-amber-500 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-sm mt-0.5">
                        📋
                    </div>
                    <div class="min-w-0">
                        <div class="text-[8.5px] font-black uppercase tracking-wider text-slate-500">ГОС. НОМЕР АВТОБУСА:</div>
                        <div class="text-base font-black text-amber-600 font-mono leading-tight mt-0.5">
                            ${licensePlate}
                        </div>
                    </div>
                </div>
            </div>

            <!-- MAIN 3-COLUMN TRIP & PASSENGER GRID -->
            <div class="grid grid-cols-12 gap-3 my-2 pt-0.5">

                <!-- COLUMN 1: TRIP DATA -->
                <div class="col-span-4 space-y-1.5 pr-1">
                    <div class="text-[11px] font-black uppercase text-slate-900 tracking-wide pb-1 border-b border-slate-200">
                        ДАННЫЕ ПОЕЗДКИ
                    </div>

                    <div class="flex items-start gap-1.5 pt-0.5">
                        <span class="text-amber-500 text-xs mt-0.5">📍</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">МЕСТО ПОСАДКИ:</div>
                            <div class="text-[11px] font-bold text-slate-800 leading-snug">
                                ${pickupAddress}
                            </div>
                        </div>
                    </div>

                    <div class="flex items-start gap-1.5">
                        <span class="text-amber-500 text-xs mt-0.5">📅</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">ДАТА И ВРЕМЯ ОТПРАВЛЕНИЯ:</div>
                            <div class="text-[11px] font-bold text-slate-900">
                                ${departureDate}
                                <span class="text-xs font-black text-amber-700 ml-1">${departureTime}</span>
                            </div>
                        </div>
                    </div>

                    <div class="flex items-start gap-1.5">
                        <span class="text-slate-800 text-xs mt-0.5">🏁</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">КОНЕЧНЫЙ ПУНКТ:</div>
                            <div class="text-[11px] font-bold text-slate-800 leading-snug">
                                ${dropOffAddress}
                            </div>
                        </div>
                    </div>

                    <div class="flex items-start gap-1.5">
                        <span class="text-slate-800 text-xs mt-0.5">⏰</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">ДАТА И ВРЕМЯ ПРИБЫТИЯ:</div>
                            <div class="text-[11px] font-bold text-slate-900">
                                ${arrivalDate}
                                <span class="text-xs font-black text-slate-800 ml-1">${arrivalTime}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- COLUMN 2: PASSENGER & SEAT & FINANCIALS -->
                <div class="col-span-4 space-y-1.5 border-l border-r border-dashed border-slate-300 px-2.5">
                    <div class="text-[11px] font-black uppercase text-slate-900 tracking-wide pb-1 border-b border-slate-200">
                        ПАССАЖИР И МЕСТО
                    </div>

                    <div class="flex items-start gap-1.5 pt-0.5">
                        <span class="text-slate-800 text-xs mt-0.5">👤</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">ФИО ПАССАЖИРА:</div>
                            <div class="text-xs font-black text-slate-900 leading-tight">
                                ${passengerName}
                            </div>
                        </div>
                    </div>

                    <!-- PROMINENT SEAT CONTAINER -->
                    <div class="bg-amber-50 border-2 border-amber-400 p-2 rounded-xl text-center shadow-sm my-1">
                        <div class="flex items-center justify-around gap-2">
                            <div>
                                <div class="text-[9px] font-black uppercase text-amber-900 tracking-wider">
                                    МЕСТО
                                </div>
                                <div class="text-4xl font-black text-amber-700 leading-none mt-0.5 font-mono">
                                    ${seatDisplay}
                                </div>
                            </div>
                            ${floorDisplay ? `
                            <div class="border-l border-amber-300 pl-3 text-left">
                                <div class="text-[8.5px] font-black uppercase text-amber-800">
                                    ЭТАЖ
                                </div>
                                <div class="text-sm font-black text-slate-900 mt-0.5">
                                    ${floorDisplay}
                                </div>
                            </div>` : ''}
                        </div>
                    </div>

                    <div class="bg-slate-50/80 p-1.5 rounded-lg border border-slate-200 space-y-0.5 text-[9.5px]">
                        <div class="flex justify-between items-center text-slate-700">
                            <span class="font-bold">💰 СТОИМОСТЬ:</span>
                            <span class="font-black text-slate-900 text-xs">${totalPrice} сомони</span>
                        </div>
                        <div class="flex justify-between items-center text-emerald-700 font-medium">
                            <span>Оплачено онлайн:</span>
                            <span class="font-bold">${paidAmount} сомони</span>
                        </div>
                        <div class="flex justify-between items-center text-amber-700 font-bold border-t border-slate-200 pt-0.5">
                            <span>К оплате перевозчику:</span>
                            <span class="font-black">${remainingAmount} сомони</span>
                        </div>
                    </div>
                </div>

                <!-- COLUMN 3: SUPPORT & CARRIER CONTACTS -->
                <div class="col-span-4 space-y-1.5 pl-1">
                    <div class="text-[11px] font-black uppercase text-slate-900 tracking-wide pb-1 border-b border-slate-200">
                        СЛУЖБА СОПРОВОЖДЕНИЯ
                    </div>

                    <div class="flex items-start gap-1.5 pt-0.5">
                        <span class="text-slate-800 text-xs mt-0.5">👤</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">СТАРШИЙ ГРУППЫ НА РЕЙСЕ:</div>
                            <div class="text-[11px] font-bold text-slate-900 leading-snug">
                                ${escortName || '<span class="text-slate-500 italic font-semibold">Будет назначен перед отправлением</span>'}
                            </div>
                        </div>
                    </div>

                    ${escortPhone ? `
                    <div class="flex items-start gap-1.5">
                        <span class="text-slate-800 text-xs mt-0.5">📞</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">ТЕЛЕФОН:</div>
                            <div class="text-xs font-bold text-slate-900 font-mono">${escortPhone}</div>
                        </div>
                    </div>` : ''}

                    ${escortWhatsapp ? `
                    <div class="flex items-start gap-1.5">
                        <span class="text-emerald-600 text-xs mt-0.5">💬</span>
                        <div>
                            <div class="text-[8.5px] font-black uppercase text-slate-500">WHATSAPP:</div>
                            <div class="text-xs font-bold text-slate-900 font-mono">${escortWhatsapp}</div>
                        </div>
                    </div>` : ''}

                    <div class="text-[8.5px] text-slate-500 italic leading-tight pt-0.5">
                        (Обращайтесь по вопросам посадки, прохождения границы и остановок в пути)
                    </div>
                </div>
            </div>

            <!-- RULES & SERVICE IN TRANSIT -->
            <div class="mt-2 pt-1.5 border-t border-amber-400/50">
                <div class="text-center mb-1.5">
                    <span class="text-[9.5px] font-black tracking-wider uppercase text-slate-900 bg-white px-2">
                        ПРАВИЛА И СЕРВИС В ПУТИ
                    </span>
                </div>

                <div class="grid grid-cols-4 gap-2 text-[9.5px] text-slate-700">
                    <div class="flex items-start gap-1">
                        <span class="text-amber-500 font-bold">•</span>
                        <div>
                            <strong class="text-slate-900">Посадка:</strong> прибыть к месту отправления заранее.
                        </div>
                    </div>

                    <div class="flex items-start gap-1">
                        <span class="text-amber-500 font-bold">•</span>
                        <div>
                            <strong class="text-slate-900">Сервис на борту:</strong>
                            <div class="text-[9px] text-slate-600 mt-0.5 space-y-0.5">
                                ${hasPower ? '<div>⚡ Розетки 220V/USB</div>' : ''}
                                ${hasWifi ? '<div>📶 Wi-Fi в пути</div>' : ''}
                                ${hasAc ? '<div>❄️ Климат-контроль</div>' : ''}
                                ${!hasAnyAmenities ? '<div class="text-slate-400 italic">Комфортабельный салон</div>' : ''}
                            </div>
                        </div>
                    </div>

                    <div class="flex items-start gap-1">
                        <span class="text-amber-500 font-bold">•</span>
                        <div>
                            ${hasKitchen ? '<div class="flex items-center gap-1 text-slate-800 font-bold"><span>☕</span> <span>Чай / Кофе</span></div>' : ''}
                            ${hasWc ? '<div class="flex items-center gap-1 text-slate-800 font-bold"><span>🚻</span> <span>Биотуалет</span></div>' : ''}
                            ${!hasKitchen && !hasWc ? '<div class="text-slate-600"><span>🛑 Санитарные остановки</span></div>' : ''}
                        </div>
                    </div>

                    <div class="flex items-start gap-1">
                        <span class="text-amber-500 font-bold">•</span>
                        <div>
                            <strong class="text-slate-900">Багаж:</strong> 1 ручная кладь + 2 места в багажнике.
                        </div>
                    </div>
                </div>
            </div>

            <!-- DARK BOTTOM FOOTER BAR -->
            <div class="mt-2 bg-slate-950 text-white rounded-xl px-3.5 py-2 flex flex-row items-center justify-between gap-1.5 shadow-sm">
                <div class="flex items-center gap-2">
                    <div class="w-5 h-5 rounded bg-amber-500 text-slate-950 flex items-center justify-center font-black text-xs shrink-0">
                        ✓
                    </div>
                    <div>
                        <div class="text-[9.5px] font-black uppercase tracking-wide text-white leading-tight">
                            POPUTKI.ONLINE — ВАШ НАДЁЖНЫЙ ПУТЬ.
                        </div>
                        <div class="text-[8.5px] font-bold text-amber-400 tracking-wider uppercase">
                            ПРОСТО. УДОБНО. БЕЗОПАСНО.
                        </div>
                    </div>
                </div>

                <div class="flex items-center gap-2.5 text-[8.5px] text-slate-300 font-medium">
                    <div class="flex items-center gap-1">
                        <span>🌐</span> <span>poputki.online</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <span class="text-sky-400">✈️</span> <span>@Poputkionline_bot</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <span class="text-rose-400">📷</span> <span>@poputki.online</span>
                    </div>
                </div>
            </div>

        </div>
    </div>

</body>
</html>`;
}

module.exports = {
    renderTicketHtml
};
