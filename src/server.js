require('dotenv').config();
require('express-async-errors'); // lets rejected promises in async handlers reach the error middleware
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // behind Nginx / a load balancer

// ---- Security & performance middleware ----
app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true }));

// ---- Routes ----
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/me', require('./routes/cart')); // /api/me/cart, /api/me/wishlist
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`ShopBD API listening on :${port}`));
