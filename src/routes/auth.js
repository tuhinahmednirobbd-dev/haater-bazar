const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Brute-force protection on credential endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });

const phoneRe = /^(\+?88)?01[3-9]\d{8}$/; // Bangladeshi mobile numbers

const registerSchema = z
  .object({
    name: z.string().min(2).max(120),
    email: z.string().email().optional(),
    phone: z.string().regex(phoneRe, 'Invalid Bangladeshi phone number').optional(),
    password: z.string().min(8).max(100),
  })
  .refine((d) => d.email || d.phone, { message: 'Email or phone is required' });

const loginSchema = z.object({
  identifier: z.string().min(3), // email or phone
  password: z.string().min(1),
});

function normalizePhone(p) {
  const digits = p.replace(/\D/g, '');
  return '+880' + digits.slice(-10);
}

function signTokens(user) {
  const payload = { id: user.id, role: user.role };
  const access = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  const refresh = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { access, refresh };
}

async function issueSession(res, user) {
  const { access, refresh } = signTokens(user);
  const hash = crypto.createHash('sha256').update(refresh).digest('hex');
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [user.id, hash]
  );
  res.cookie('refreshToken', refresh, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/api/auth',
  });
  return access;
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

router.post('/register', authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, email, phone, password } = parsed.data;
  const normPhone = phone ? normalizePhone(phone) : null;

  const exists = await db.query('SELECT 1 FROM users WHERE email = $1 OR phone = $2', [
    email || null,
    normPhone,
  ]);
  if (exists.rowCount) return res.status(409).json({ error: 'Account already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    `INSERT INTO users (name, email, phone, password_hash)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, email || null, normPhone, passwordHash]
  );
  const accessToken = await issueSession(res, rows[0]);
  res.status(201).json({ user: publicUser(rows[0]), accessToken });
});

router.post('/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { identifier, password } = parsed.data;
  const isPhone = phoneRe.test(identifier);

  const { rows } = await db.query(
    `SELECT * FROM users WHERE ${isPhone ? 'phone' : 'email'} = $1 AND is_active`,
    [isPhone ? normalizePhone(identifier) : identifier.toLowerCase()]
  );
  const user = rows[0];
  // Same message for unknown user and wrong password: no account enumeration
  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const accessToken = await issueSession(res, user);
  res.json({ user: publicUser(user), accessToken });
});

// Rotates the refresh token on every use
router.post('/refresh', async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ error: 'No refresh token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await db.query(
      `UPDATE refresh_tokens SET revoked = TRUE
       WHERE token_hash = $1 AND NOT revoked AND expires_at > now() RETURNING user_id`,
      [hash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Token revoked' });
    const u = await db.query('SELECT * FROM users WHERE id = $1 AND is_active', [payload.id]);
    if (!u.rowCount) return res.status(401).json({ error: 'User not found' });
    const accessToken = await issueSession(res, u.rows[0]);
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.post('/logout', async (req, res) => {
  const token = req.cookies.refreshToken;
  if (token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
  }
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ ok: true });
});

// ---- Profile & addresses ----
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const addresses = await db.query('SELECT * FROM addresses WHERE user_id = $1', [req.user.id]);
  res.json({ user: publicUser(rows[0]), addresses: addresses.rows });
});

router.patch('/me', requireAuth, async (req, res) => {
  const parsed = z.object({ name: z.string().min(2).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  await db.query('UPDATE users SET name = $1, updated_at = now() WHERE id = $2', [
    parsed.data.name,
    req.user.id,
  ]);
  res.json({ ok: true });
});

const addressSchema = z.object({
  label: z.string().max(30).optional(),
  full_name: z.string().min(2),
  phone: z.string().regex(phoneRe),
  division: z.string().min(2),
  district: z.string().min(2),
  upazila: z.string().optional(),
  address: z.string().min(5),
  postal_code: z.string().max(10).optional(),
  is_default: z.boolean().optional(),
});

router.post('/addresses', requireAuth, async (req, res) => {
  const parsed = addressSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const a = parsed.data;
  if (a.is_default) {
    await db.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
  }
  const { rows } = await db.query(
    `INSERT INTO addresses (user_id,label,full_name,phone,division,district,upazila,address,postal_code,is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user.id, a.label || 'Home', a.full_name, normalizePhone(a.phone), a.division, a.district,
     a.upazila || null, a.address, a.postal_code || null, !!a.is_default]
  );
  res.status(201).json(rows[0]);
});

router.delete('/addresses/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/*
 * Social login (Google / Facebook): verify the provider's ID/access token on the
 * server (google-auth-library or Facebook Graph /me), then upsert into
 * social_accounts + users and call issueSession(). Never trust a client-sent email.
 * Phone OTP login: generate a 6-digit code, store its hash in otp_codes, send via an
 * SMS gateway (e.g. SSL Wireless, BulkSMSBD), verify with attempts limit (max 5).
 */

module.exports = router;
