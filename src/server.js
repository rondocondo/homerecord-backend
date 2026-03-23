// HomeRecord — Main server
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const authRoutes      = require('./routes/auth');
const propertyRoutes  = require('./routes/properties');
const reportRoutes    = require('./routes/reports');
const { submissionsRouter, paymentsRouter, adminRouter } = require('./routes/submissions');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));

// Stripe webhooks need raw body — must come before express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Rate limiting — 100 requests per 15 minutes per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests — please slow down.' }
}));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/properties',  propertyRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/submissions', submissionsRouter);
app.use('/api/payments',    paymentsRouter);
app.use('/api/admin',       adminRouter);

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message
  });
});

app.listen(PORT, () => {
  console.log(`\n🏠 HomeRecord API running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV}`);
  console.log(`   Docs:        http://localhost:${PORT}/health\n`);
});

module.exports = app;
