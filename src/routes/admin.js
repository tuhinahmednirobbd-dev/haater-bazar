const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'seller'));

const audit = (req, action, entity, entityId, meta) =>
  db.query(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, action, entity, String(entityId), meta ? JSON.stringify(meta) : null, req.ip]
  );

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.random().toString(36).slice(2, 6);

// ============ ANALYTICS (admin only) ============
router.get('/analytics', requireRole('admin'), async (_req, res) => {
  const [totals, daily, top, byStatus] = await Promise.all([
    db.query(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue,
                     (SELECT COUNT(*) FROM users WHERE role='customer') AS customers
              FROM orders WHERE status NOT IN ('cancelled','returned')`),
    db.query(`SELECT day, orders, revenue FROM daily_sales WHERE day > now() - interval '30 days' ORDER BY day`),
    db.query(`SELECT p.title, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.unit_price) AS revenue
              FROM order_items oi JOIN products p ON p.id = oi.product_id
              GROUP BY p.title ORDER BY units DESC LIMIT 10`),
    db.query(`SELECT status, COUNT(*) AS count FROM orders GROUP BY status`),
  ]);
  res.json({ totals: totals.rows[0], daily: daily.rows, topProducts: top.rows, byStatus: byStatus.rows });
});

// ============ PRODUCTS ============
const productSchema = z.object({
  title: z.string().min(3).max(255),
  description: z.string().max(10000).optional(),
  category_id: z.number().int(),
  brand_id: z.number().int().nullable().optional(),
  price: z.number().min(0),
  discount_price: z.number().min(0).nullable().optional(),
  stock: z.number().int().min(0),
  sku: z.string().max(80).optional(),
  images: z.array(z.string().url()).max(10).default([]),
  is_active: z.boolean().default(true),
});

router.get('/products', async (req, res) => {
  const mine = req.user.role === 'seller';
  const { rows } = await db.query(
    `SELECT id, title, slug, price, discount_price, stock, is_active, sold_count
     FROM products ${mine ? 'WHERE seller_id = $1' : ''} ORDER BY created_at DESC LIMIT 200`,
    mine ? [req.user.id] : []
  );
  res.json(rows);
});

router.post('/products', async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;
  const { rows } = await db.query(
    `INSERT INTO products (seller_id, category_id, brand_id, title, slug, description, price,
       discount_price, stock, sku, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, slug`,
    [req.user.id, p.category_id, p.brand_id ?? null, p.title, slugify(p.title), p.description || null,
     p.price, p.discount_price ?? null, p.stock, p.sku || null, p.is_active]
  );
  for (const [i, url] of p.images.entries()) {
    await db.query('INSERT INTO product_images (product_id, url, sort_order) VALUES ($1,$2,$3)', [rows[0].id, url, i]);
  }
  await audit(req, 'product.create', 'product', rows[0].id);
  res.status(201).json(rows[0]);
});

router.patch('/products/:id', async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;
  // sellers may only touch their own products
  const own = req.user.role === 'admin' ? '' : 'AND seller_id = $11';
  const params = [p.title ?? null, p.description ?? null, p.category_id ?? null, p.brand_id ?? null,
    p.price ?? null, p.discount_price ?? null, p.stock ?? null, p.sku ?? null, p.is_active ?? null,
    req.params.id];
  if (own) params.push(req.user.id);
  const r = await db.query(
    `UPDATE products SET title=COALESCE($1,title), description=COALESCE($2,description),
       category_id=COALESCE($3,category_id), brand_id=COALESCE($4,brand_id), price=COALESCE($5,price),
       discount_price=COALESCE($6,discount_price), stock=COALESCE($7,stock), sku=COALESCE($8,sku),
       is_active=COALESCE($9,is_active), updated_at=now()
     WHERE id=$10 ${own} RETURNING id`,
    params
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  await audit(req, 'product.update', 'product', req.params.id, p);
  res.json({ ok: true });
});

router.delete('/products/:id', requireRole('admin'), async (req, res) => {
  // soft delete keeps order history intact
  await db.query('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id]);
  await audit(req, 'product.deactivate', 'product', req.params.id);
  res.json({ ok: true });
});

// ============ ORDERS ============
router.get('/orders', requireRole('admin'), async (req, res) => {
  const status = req.query.status;
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.total, o.created_at,
            u.name AS customer
     FROM orders o JOIN users u ON u.id = o.user_id
     ${status ? 'WHERE o.status = $1' : ''} ORDER BY o.created_at DESC LIMIT 200`,
    status ? [status] : []
  );
  res.json(rows);
});

router.patch('/orders/:id/status', requireRole('admin'), async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned']),
      tracking_number: z.string().max(80).optional(),
      note: z.string().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { status, tracking_number, note } = parsed.data;
  const r = await db.query(
    `UPDATE orders SET status = $1, tracking_number = COALESCE($2, tracking_number),
       payment_status = CASE WHEN $1 = 'delivered' AND payment_method = 'cod' THEN 'paid'::payment_status ELSE payment_status END,
       updated_at = now() WHERE id = $3 RETURNING id`,
    [status, tracking_number || null, req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  await db.query('INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)', [
    req.params.id, status, note || null,
  ]);
  await audit(req, 'order.status', 'order', req.params.id, { status });
  res.json({ ok: true });
});

// ============ USERS ============
router.get('/users', requireRole('admin'), async (_req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, email, phone, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 200'
  );
  res.json(rows);
});

router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  const parsed = z
    .object({ is_active: z.boolean().optional(), role: z.enum(['customer', 'seller', 'admin']).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't change your own account here" });
  await db.query(
    'UPDATE users SET is_active = COALESCE($1,is_active), role = COALESCE($2,role) WHERE id = $3',
    [parsed.data.is_active ?? null, parsed.data.role ?? null, req.params.id]
  );
  await audit(req, 'user.update', 'user', req.params.id, parsed.data);
  res.json({ ok: true });
});

module.exports = router;
