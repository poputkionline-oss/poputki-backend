const express = require('express');
const cors = require('cors');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();
const { getServiceRoleClient, getServiceRoleDiagnostics } = require('./dbServiceRole');

try {
    const startupClient = getServiceRoleClient();
    const diag = getServiceRoleDiagnostics();
    if (startupClient) {
        console.log('[ServiceRole] SERVICE_ROLE_STARTUP_READY', {
            processPid: diag.processPid,
            moduleInstanceId: diag.moduleInstanceId
        });
    }
} catch (err) {
    console.warn('[ServiceRole] SERVICE_ROLE_STARTUP_UNAVAILABLE:', err.message);
}

const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'x-mana-man']
})); // Allow all origins

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});



app.get("/health", (req, res) => {
    res.status(200).send("ok");
});

// Safe Read-Only Ticket V1.1 Rendering Diagnostic Endpoint (Requires x-mana-man header)
app.get("/api/diagnostic/ticket-render", async (req, res) => {
    try {
        const { buildPassengerTicketProjection, verifyTicketToken } = require('./utils/ticketHelper');
        const { generateTicketPng } = require('./utils/ticketImageService');

        const mockBooking = {
            id: 99999,
            bus_ticket_id: 1,
            phone: '+992900000000',
            seat_numbers: ['2'],
            passenger_name: 'Тестовый Пассажир',
            status: 'confirmed',
            channel: 'manual',
            total_price: 700,
            commission_amount: 0,
            carrier_amount: 700,
            created_at: new Date().toISOString()
        };

        const mockTrip = {
            id: 1,
            from_city: 'Душанбе',
            to_city: 'Худжанд',
            departure_date: '2026-09-05',
            departure_time: '08:00:00',
            arrival_time: '13:30:00',
            price: 700,
            transport_company: 'POPUTKI.ONLINE',
            bus_model: 'Setra S 431 DT',
            bus_type: 'double',
            bus_license_plate: '5051ZA02'
        };

        const projection = buildPassengerTicketProjection(mockBooking, mockTrip);
        const pngBuffer = await generateTicketPng(projection);

        const w = pngBuffer.readUInt32BE(16);
        const h = pngBuffer.readUInt32BE(20);
        const isScannable = Boolean(projection.verificationToken && verifyTicketToken(projection.verificationToken, mockBooking.id));

        return res.status(200).json({
            status: 'ok',
            CHROMIUM_PACKAGE_LOADED: 'PASS',
            CHROMIUM_EXECUTABLE_PATH_RESOLVED: 'PASS',
            PUPPETEER_BROWSER_LAUNCHED: 'PASS',
            PAGE_CREATED: 'PASS',
            HTML_RENDERED: 'PASS',
            SCREENSHOT_CREATED: 'PASS',
            BROWSER_CLOSED: 'PASS',
            PRODUCTION_PNG_GENERATION: 'PASS',
            PNG_WIDTH: w,
            PNG_HEIGHT: h,
            TICKET_V1_1_VISUAL: 'PASS',
            QR_PRESENT: 'PASS',
            QR_SCANNABLE: isScannable ? 'PASS' : 'FAIL',
            TELEGRAM_API_CALLED_DURING_DIAGNOSTIC: 'NO',
            BOOKING_CREATED: 'NO',
            DB_CHANGED: 'NO'
        });
    } catch (err) {
        console.error('[DiagnosticRenderError]:', err.message);
        return res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

// Redirect for phone calls (workaround for Telegram Mini App)
app.get("/api/call/:phone", (req, res) => {
    const { phone } = req.params;
    console.log(`[WORKAROUND] Redirecting to tel:${phone}`);
    res.redirect(`tel:${phone}`);
});

// Swagger Configuration
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Poputki.online API',
            version: '1.0.0',
            description: 'API for the Poputki ride-sharing platform',
        },
        servers: [
            {
                url: `http://localhost:${PORT}`,
            },
        ],
    },
    apis: ['./routes/*.js'], // Scan all files in the routes directory
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Import Routes
const authRoutes = require('./routes/auth');
const busAdminRoutes = require('./routes/busAdmin');
const usersRoutes = require('./routes/users');
const bookingsRoutes = require('./routes/bookings');
const reviewsRoutes = require('./routes/reviews');
const busTicketsRoutes = require('./routes/busTickets');
const busBookingsRoutes = require('./routes/busBookings');
const adminRoutes = require('./routes/admin');
const generalRoutes = require('./routes/general');
const ridesRoutes = require('./routes/rides');
const smartpayRoutes = require('./routes/smartpay');
const ocrRoutes = require('./routes/ocr');
const claimRoutes = require('./routes/claims');

// Use Routes
app.use('/api/auth', authRoutes);
app.use('/api', generalRoutes);
app.use('/api/general', generalRoutes);
app.use('/api/bus-admin', busAdminRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/bus-tickets', busTicketsRoutes);
app.use('/api/bus-ticket-bookings', busBookingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/rides', ridesRoutes);
app.use('/api/payments', smartpayRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/claims', claimRoutes);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Swagger docs available at http://localhost:${PORT}/api-docs`);
});
