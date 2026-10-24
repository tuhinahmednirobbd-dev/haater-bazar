const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SHIPPING_DHAKA = 60;
const SHIPPING_OUTSIDE = 120;
const FREE_SHIPPING_OVER = 2000;

const checkoutSchema = z.object({
  address_id: z.string().uuid(),
  payment_method: z.enum(['cod', 'bkash', 'nagad', 'card']),
  coupon_code: z.string().max(40).optional(),
});

/*
 * POST /api/orders  (checkout)
 * Prices, stock and totals are ALWAYS recomputed on the server from the database.
 * The whole thing runs in one transaction with row locks so two buyers can't oversell stock.
 */
router.post('/', async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { address_id, payment_method, coupon_code } = parsed.data;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const addr = await client.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [
      address_id,
      req.user.id,
    ]);
    if (!addr.rowCount) throw Object.assign(new Error('Address not found'), { status: 400 });

    const cart = await client.query(
      `SELECT ci.quantity, ci.product_id, ci.variant_id, p.title,
              COALESCE(v.price, p.discount_price, p.price) AS unit_price
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id AND p.is_active
       LEFT JOIN product_variants v ON v.id = ci.variant_id
       WHERE ci.user_id = $1 AND NOT ci.saved_for_later`,
      [req.user.id]
    );
    if (!cart.rowCount) throw Object.assign(new Error('Cart is empty'), { status: 400 });

    // Lock + decrement stock
    for (const item of cart.rows) {
      const table = item.variant_id ? 'product_variants' : 'products';
      const id = item.variant_id || item.product_id;
      const upd = await client.query(
        `UPDATE ${table} SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
        [item.quantity, id]
      );
      if (!upd.rowCount) {
        throw Object.assign(new Error(`"${item.title}" is out of stock`), { status: 409 });
      }
      await client.query('UPDATE products SET sold_count = sold_count + $1 WHERE id = $2', [
        item.quantity,
        item.product_id,
      ]);
    }

    const subtotal = cart.rows.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0);
    const a = addr.rows[0];
    let shipping = a.district.toLowerCase() === 'dhaka' ? SHIPPING_DHAKA : SHIPPING_OUTSIDE;
    if (subtotal >= FREE_SHIPPING_OVER) shipping = 0;

    let discount = 0;
    let couponId = null;
    if (coupon_code) {
      const c = await client.query(
        `SELECT * FROM coupons WHERE code = $1 AND is_active
           AND (expires_at IS NULL OR expires_at > now())
           AND (usage_limit IS NULL OR used_count < usage_limit)
           AND min_order <= $2 FOR UPDATE`,
        [coupon_code.toUpperCase(), subtotal]
      );
      if (!c.rowCount) throw Object.assign(new Error('Invalid coupon'), { status: 400 });
      const cp = c.rows[0];
      discount = cp.percent_off ? (subtotal * cp.percent_off) / 100 : Number(cp.amount_off);
      discount = Math.min(discount, subtotal);
      couponId = cp.id;
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [cp.id]);
    }
    const total = subtotal + shipping - discount;

    const num = await client.query(`SELECT nextval('order_seq') AS n`);
    const orderNumber = `SB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(
      num.rows[0].n
    ).padStart(5, '0')}`;

    const order = await client.query(
      `INSERT INTO orders (order_number, user_id, address_snapshot, subtotal, shipping_fee,
         discount, total, coupon_id, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [orderNumber, req.user.id, JSON.stringify(a), subtotal, shipping, discount, total, couponId,
       payment_method, payment_method === 'cod' ? 'unpaid' : 'pending']
    );
    const orderId = order.rows[0].id;

    for (const i of cart.rows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, title, unit_price, quantity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, i.product_id, i.variant_id, i.title, i.unit_price, i.quantity]
      );
    }
    await client.query(`INSERT INTO order_status_history (order_id, status) VALUES ($1,'pending')`, [orderId]);
    await client.query('DELETE FROM cart_items WHERE user_id = $1 AND NOT saved_for_later', [req.user.id]);

    await client.query('COMMIT');
    res.status(201).json({
      order: order.rows[0],
      // online methods: client then calls POST /api/payments/:orderId/init
      next: payment_method === 'cod' ? 'done' : 'pay',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Checkout failed' });
  } finally {
    client.release();
  }
});

// Order history
router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, order_number, status, payment_method, payment_status, total, created_at
     FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

// Order detail + tracking timeline
router.get('/:id', async (req, res) => {
  const o = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!o.rowCount) return res.status(404).json({ error: 'Order not found' });
  const [items, history] = await Promise.all([
    db.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]),
    db.query('SELECT status, note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [req.params.id]),
  ]);
  res.json({ ...o.rows[0], items: items.rows, timeline: history.rows });
});

router.post('/:id/cancel', async (req, res) => {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status IN ('pending','confirmed') RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(409).json({ error: 'Order can no longer be cancelled' });
  // restock
  await db.query(
    `UPDATE products p SET stock = stock + oi.quantity
     FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id AND oi.variant_id IS NULL`,
    [req.params.id]
  );
  await db.query(
    `UPDATE product_variants v SET stock = stock + oi.quantity
     FROM order_items oi WHERE oi.order_id = $1 AND oi.variant_id = v.id`,
    [req.params.id]
  );
  // NOTE: if the order was already paid online, trigger a gateway refund here.
  await db.query(`INSERT INTO order_status_history (order_id, status) VALUES ($1,'cancelled')`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
