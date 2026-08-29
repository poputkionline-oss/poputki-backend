const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { sendPersonalMessage } = require('../utils/telegramBot');
const { isSeatLockedByBooking, DEFAULT_HOLD_TTL_SECONDS } = require('../utils/paymentExpirationHelper');

const SMARTPAY_API_KEY = process.env.SMARTPAY_API_KEY;
const SMARTPAY_BASE_URL = 'https://ecomm.smartpay.tj/api/merchant';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://poputki.online';

/**
 * Helper function to process successful payments.
 * It checks for seat conflicts, confirms the booking, updates reserved seats, and sends notifications.
 */
async function processSuccessfulPayment(booking) {
    const ticketId = booking.bus_ticket_id;

    // Check for seat conflicts before confirming (excluding current booking)
    const { data: confirmedBookings } = await supabase
        .from('bus_ticket_bookings')
        .select('id, seat_numbers')
        .eq('bus_ticket_id', ticketId)
        .eq('status', 'confirmed')
        .neq('id', booking.id);

    const takenSeats = [];
    (confirmedBookings || []).forEach(b => {
        const s = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
        takenSeats.push(...s);
    });

    const mySeats = typeof booking.seat_numbers === 'string' ? JSON.parse(booking.seat_numbers || '[]') : (booking.seat_numbers || []);
    const conflict = mySeats.some(s => takenSeats.includes(s));

    if (conflict) {
        // Payment was charged but seats are taken. Mark for manual refund.
        await supabase
            .from('bus_ticket_bookings')
            .update({ status: 'conflict_refund_needed' })
            .eq('id', booking.id);

        return { status: 'failed', error: 'Seats were taken by another user during payment. Please contact support for a refund.' };
    }

    // Payment successful and no conflict — confirm booking
    await supabase
        .from('bus_ticket_bookings')
        .update({ status: 'confirmed' })
        .eq('id', booking.id);

    // Officially reserve the seats
    const allTakenSeats = [...new Set([...takenSeats, ...mySeats])];
    await supabase
        .from('bus_tickets')
        .update({ reserved_seats: allTakenSeats })
        .eq('id', ticketId);


    // Send Telegram notifications (fire-and-forget)
    const ticket = booking.bus_tickets;
    if (ticket) {
        const dateStr = ticket.departure_date;
        const timeStr = ticket.departure_time ? ticket.departure_time.substring(0, 5) : '';
        const seatNums = mySeats;

        let passengersList = '';
        const pData = booking.passengers_data || [];
        pData.forEach((p, idx) => {
            const genderStr = p.gender === 'male' ? 'Муж.' : (p.gender === 'female' ? 'Жен.' : '');
            passengersList += `\n${idx + 1}. ${p.lastName || ''} ${p.firstName || ''} (${genderStr}) - Место: ${seatNums[idx] || '—'} [${p.docType || 'Док'}: ${p.docNumber || '—'}]`;
        });

        const ticketNumber = `POP-${String(booking.id).padStart(6, '0')}`;
        const paidAmount = Number(booking.commission_amount ?? Math.round((booking.total_price || 0) * 0.1));
        const remainingAmount = Math.max(0, (booking.total_price || 0) - paidAmount);

        const ticketMsg = `🎫 <b>ЭЛЕКТРОННЫЙ БИЛЕТ POPUTKI.ONLINE</b> 🎫\n\n` +
            `№ билета: <b>${ticketNumber}</b>\n` +
            `✅ <b>Статус:</b> Оплачено\n` +
            `🚌 <b>Рейс:</b> ${ticket.from_city} ➡ ${ticket.to_city}\n` +
            `📍 <b>Маршрут:</b> ${booking.pickup_city || ticket.from_city} ➡ ${booking.drop_off_city || ticket.to_city}\n` +
            `🗓 <b>Дата и время:</b> ${dateStr} в ${timeStr}\n\n` +
            `💺 <b>Количество мест:</b> ${seatNums.length} (Места: ${seatNums.join(', ')})\n` +
            `👥 <b>Пассажиры:</b>${passengersList}\n\n` +
            `💰 <b>Общая стоимость:</b> ${booking.total_price} сом\n` +
            `💳 <b>Оплачено онлайн:</b> ${paidAmount} сом\n` +
            `💵 <b>Остаток перевозчику:</b> ${remainingAmount} сом\n\n` +
            `<i>Пожалуйста, сохраните этот билет. Счастливого пути!</i>\n\n` +
            `POPUTKI.ONLINE — информационный сервис (агрегатор), а не перевозчик`;

        sendPersonalMessage(booking.passenger_id, ticketMsg);

        if (ticket.operator_id) {
            const driverMsg = `🔔 <b>НОВОЕ БРОНИРОВАНИЕ (ОПЛАЧЕНО)</b> 🚌\n\n` +
                `📍 <b>Рейс:</b> ${ticket.from_city} ➡ ${ticket.to_city}\n` +
                `маршрут: <b>${booking.pickup_city || ticket.from_city} ➡ ${booking.drop_off_city || ticket.to_city}</b>\n` +
                `🗓 <b>Дата/время:</b> ${dateStr} в ${timeStr}\n\n` +
                `👤 <b>Основной контакт:</b> ${booking.phone}\n` +
                `💺 <b>Места:</b> ${seatNums.join(', ')} (${seatNums.length} чел.)\n` +
                `👥 <b>Список пассажиров:</b>${passengersList}\n\n` +
                `💰 <b>Сумма:</b> ${booking.total_price} сом`;

            sendPersonalMessage(ticket.operator_id, driverMsg);
        }
    }

    return { status: 'confirmed', booking_id: booking.id };
}

/**
 * POST /api/payments/create-invoice
 * Creates a booking with pending_payment status and a SmartPay invoice
 */
router.post('/create-invoice', async (req, res) => {
    const { bus_ticket_id, passenger_id, seat_numbers, passengers_data, phone, pickup_city, drop_off_city } = req.body;

    // Verify user
    const { data: userExists, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('id', passenger_id)
        .maybeSingle();

    if (userError || !userExists) {
        return res.status(401).json({ error: 'Пользователь не найден' });
    }
    if (!seat_numbers || !seat_numbers.length) {
        return res.status(400).json({ error: 'Seat numbers required' });
    }
    if (!passengers_data || !passengers_data.length) {
        return res.status(400).json({ error: 'Passenger data required' });
    }

    try {
        // Fetch ticket
        const { data: ticket, error: ticketError } = await supabase
            .from('bus_tickets')
            .select('*')
            .eq('id', bus_ticket_id)
            .single();

        if (ticketError || !ticket) return res.status(404).json({ error: 'Ticket not found' });

        // Fetch operator's service fee percent (defaults to 10 if not set)
        let feePercent = 10;
        if (ticket.operator_id) {
            const { data: operator } = await supabase
                .from('users')
                .select('service_fee_percent')
                .eq('id', ticket.operator_id)
                .maybeSingle();
            if (operator && operator.service_fee_percent != null) {
                feePercent = parseFloat(operator.service_fee_percent);
            }
        }

        // Check seat availability against active seat locks (confirmed OR active pending hold)
        const { data: existingBookings } = await supabase
            .from('bus_ticket_bookings')
            .select('seat_numbers, status, created_at, hold_expires_at')
            .eq('bus_ticket_id', bus_ticket_id)
            .neq('status', 'cancelled');

        const takenSeats = [];
        (existingBookings || []).forEach(b => {
            if (isSeatLockedByBooking(b)) {
                const seats = typeof b.seat_numbers === 'string' ? JSON.parse(b.seat_numbers || '[]') : (b.seat_numbers || []);
                takenSeats.push(...seats);
            }
        });

        const conflict = seat_numbers.some(s => takenSeats.includes(s));
        if (conflict) return res.status(400).json({ error: 'Одно или несколько мест уже заняты' });

        // Calculate price
        const premiumSeatNums = ticket.bus_type === 'double' ? [1, 2, 3, 4, 69, 70, 71, 72, 73, 74, 75, 76] : [];
        const premiumPrice = ticket.premium_price || ticket.price;
        let totalPrice = 0;
        for (const seatNum of seat_numbers) {
            totalPrice += premiumSeatNums.includes(seatNum) ? premiumPrice : ticket.price;
        }

        const {
            channel,
            source_type,
            source_id
        } = req.body;

        // Generate unique order_id
        const paymentOrderId = `bus_${bus_ticket_id}_${passenger_id}_${Date.now()}`;

        if (!bus_ticket_id || !passenger_id || !seat_numbers || !phone) {
            return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
        }

        // Validate and sanitize attribution parameters
        const validChannels = ['web', 'telegram', 'manual'];
        const validSourceTypes = ['direct', 'carrier_link', 'partner_link', 'manual', 'bot', 'platform'];

        let finalChannel = validChannels.includes(channel) ? channel : 'web';
        let finalSourceType = validSourceTypes.includes(source_type) ? source_type : 'direct';
        let finalSourceId = source_id ? String(source_id).trim() : null;

        // Security verification: If claimed source_type is carrier_link, verify against the ticket operator_id
        if (finalSourceType === 'carrier_link' && finalSourceId) {
            const claimedCarrierId = parseInt(finalSourceId, 10);
            if (!claimedCarrierId || ticket.operator_id !== claimedCarrierId) {
                // False attribution prevention: Reset to direct if carrier ID does not match ticket owner
                finalSourceType = 'direct';
                finalSourceId = null;
            }
        }

        const holdExpiresAt = new Date(Date.now() + DEFAULT_HOLD_TTL_SECONDS * 1000).toISOString();

        // Create booking with pending_payment status and verified attribution
        const { data: booking, error: insertError } = await supabase
            .from('bus_ticket_bookings')
            .insert([{
                bus_ticket_id,
                passenger_id,
                seat_numbers,
                passenger_count: seat_numbers.length,
                passengers_data,
                phone,
                status: 'pending_payment',
                hold_expires_at: holdExpiresAt,
                total_price: totalPrice,
                pickup_city,
                drop_off_city,
                payment_order_id: paymentOrderId,
                channel: finalChannel,
                source_type: finalSourceType,
                source_id: finalSourceId,
                created_by_user_id: null // Online bookings cannot be created by an internal manager
            }])
            .select('id')
            .single();


        if (insertError) throw insertError;

        // Create SmartPay invoice
        // Platform charges only feePercent% as a booking service fee; the carrier collects the rest directly.
        const platformFee = Math.round(totalPrice * feePercent / 100);
        const returnUrl = `https://poputki.online/payment-result?order_id=${paymentOrderId}`;
        const description = `Сервисный сбор (${feePercent}%) — Билет ${ticket.from_city} → ${ticket.to_city}, ${seat_numbers.length} мест (${seat_numbers.join(', ')})`;

        // Build customer name from first passenger
        const firstPassenger = passengers_data[0] || {};
        const customerName = `${firstPassenger.lastName || ''} ${firstPassenger.firstName || ''} ${firstPassenger.middleName || ''}`.trim();

        const invoiceResponse = await fetch(`${SMARTPAY_BASE_URL}/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-app-token': SMARTPAY_API_KEY
            },
            body: JSON.stringify({
                amount: platformFee,          // Only the 10% platform fee is charged via SmartPay
                description,
                order_id: paymentOrderId,
                return_url: returnUrl,
                lifetime: 1800,
                customer_phone: phone ? phone.replace(/\D/g, '').replace(/^992/, '') : undefined,
                qty: seat_numbers.length,
                unit_price: Math.round(ticket.price * feePercent / 100),  // Use dynamic fee percentage from DB
                name: customerName || undefined
            })
        });

        const invoiceData = await invoiceResponse.json();

        if (!invoiceResponse.ok || !invoiceData.payment_link) {
            // Rollback: delete the booking
            await supabase.from('bus_ticket_bookings').delete().eq('id', booking.id);
            return res.status(502).json({ error: 'Ошибка создания платежа. Попробуйте позже.' });
        }

        // Store invoice data
        await supabase
            .from('bus_ticket_bookings')
            .update({
                invoice_uuid: invoiceData.invoice_uuid,
                payment_link: invoiceData.payment_link
            })
            .eq('id', booking.id);

        res.json({
            booking_id: booking.id,
            payment_link: invoiceData.payment_link,
            order_id: paymentOrderId
        });

    } catch (err) {
        console.error('Payment create-invoice error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/payments/verify/:order_id
 * Checks payment status with SmartPay and updates booking accordingly
 */
router.get('/verify/:order_id', async (req, res) => {
    const { order_id } = req.params;

    try {
        // Find our booking
        const { data: booking, error: bookingError } = await supabase
            .from('bus_ticket_bookings')
            .select('*, bus_tickets(*)')
            .eq('payment_order_id', order_id)
            .single();

        if (bookingError || !booking) {
            return res.status(404).json({ error: 'Бронь не найдена' });
        }

        // If already confirmed, just return success
        if (booking.status === 'confirmed') {
            return res.json({ status: 'confirmed', booking_id: booking.id });
        }

        // Poll SmartPay for status
        const statusResponse = await fetch(`${SMARTPAY_BASE_URL}/order/status/${order_id}`, {
            headers: { 'x-app-token': SMARTPAY_API_KEY }
        });

        const statusData = await statusResponse.json();
        const paymentStatus = statusData.status;

        if (paymentStatus === 'Charged') {
            const result = await processSuccessfulPayment(booking);
            return res.json(result);

        } else if (paymentStatus === 'Expired' || paymentStatus === 'Rejected') {
            // Payment failed — cancel booking
            await supabase
                .from('bus_ticket_bookings')
                .update({ status: 'cancelled' })
                .eq('id', booking.id);

            res.json({ status: 'failed', reason: paymentStatus });

        } else {
            // Still pending (Created or other)
            res.json({ status: 'pending', payment_link: booking.payment_link });
        }

    } catch (err) {
        console.error('Payment verify error:', err);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;

// Ensure webhook endpoint is exported below
/**
 * POST /api/payments/webhook
 * Receives server-to-server notifications from the bank upon successful payment.
 */
router.post('/webhook', async (req, res) => {
    const payload = req.body;
    const { order_id } = payload;

    if (!order_id) {
        return res.status(400).json({ error: 'Missing order_id' });
    }

    try {
        // Query the booking associated with the webhook's order_id
        const { data: booking, error: bookingError } = await supabase
            .from('bus_ticket_bookings')
            .select('*, bus_tickets(*)')
            .eq('payment_order_id', order_id)
            .single();

        if (bookingError || !booking) {
            console.error(`[WEBHOOK] Booking not found for order_id: ${order_id}`);
            return res.status(404).json({ error: 'Бронь не найдена' });
        }

        // If already confirmed, acknowledge idempotently
        if (booking.status === 'confirmed') {
            console.log(`[WEBHOOK] Booking already confirmed for order: ${order_id}`);
            return res.json({ status: 'already_confirmed', booking_id: booking.id });
        }

        // Run the main confirmation logic
        const result = await processSuccessfulPayment(booking);

        console.log(`[WEBHOOK] Successfully processed order: ${order_id}. Result:`, result);

        // Respond HTTP 200 OK to the bank
        res.json(result);

    } catch (err) {
        console.error(`[WEBHOOK ERROR] for order_id ${order_id}:`, err);
        res.status(500).json({ error: err.message });
    }
});
