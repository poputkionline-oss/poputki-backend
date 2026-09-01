const express = require('express');
const cors = require('cors');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();
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

// Security Header Check Middleware
app.use((req, res, next) => {
    // Skip security check for: CORS, Health, API Docs, and Phone Redirects
    // /api/claims/bot/* endpoints are exempt: Telegram cannot send x-mana-man;
    // they are individually secured by requireClaimBotSecret (X-Claim-Bot-Secret).
    if (
        req.method === 'OPTIONS' ||
        req.url === '/health' ||
        req.url.startsWith('/api-docs') ||
        req.url.startsWith('/api/call/') ||
        req.url.startsWith('/api/claims/bot/')
    ) {
        return next();
    }

    const clientHeader = req.headers['x-mana-man'];
    if (clientHeader !== 'nasa.2006') {
        console.warn(`[SECURITY] 403 Forbidden - Missing or invalid header from ${req.ip} for ${req.url}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});

app.get("/health", (req, res) => {
    res.status(200).send("ok");
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
