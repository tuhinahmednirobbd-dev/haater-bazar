const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ============ CART ============
router.get('/cart', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ci.id, ci.quantity, ci.saved_for_later, ci.variant_id,
            p.id AS product_id, p.title, p.slug, p.stock,
            COALESCE(v.price, p.discount_price, p.price) AS unit_price,
            (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order LIMIT 1) AS image
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     WHERE ci.user_id = $1 ORDER BY ci.created_at DESC`,
    [req.user.id]
  );
  const active = rows.filter((r) => !r.saved_for_later);
  const subtotal = active.reduce((s, r) => s + Number(r.unit_price) * r.quantity, 0);
  res.json({ items: rows, subtotal });
});

router.post('/cart', async (req, res) => {
  const parsed = z
    .object({
      product_id: z.string().uuid(),
      variant_id: z.string().uuid().nullable().optional(),
      quantity: z.number().int().min(1).max(20).default(1),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { product_id, variant_id = null, quantity } = parsed.data;

  const p = await db.query('SELECT stock FROM products WHERE id = $1 AND is_active', [product_id]);
  if (!p.rowCount) return res.status(404).json({ error: 'Product not found' });
  if (p.rows[0].stock < quantity) return res.status(409).json({ error: 'Not enough stock' });

  // UNIQUE treats NULL variant_ids as distinct, so match manually
  const existing = await db.query(
    `SELECT id FROM cart_items WHERE user_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3`,
    [req.user.id, product_id, variant_id]
  );
  if (existing.rowCount) {
    await db.query(
      'UPDATE cart_items SET quantity = LEAST(quantity + $1, 20), saved_for_later = FALSE WHERE id = $2',
      [quantity, existing.rows[0].id]
    );
  } else {
    await db.query(
      'INSERT INTO cart_items (user_id, product_id, variant_id, quantity) VALUES ($1,$2,$3,$4)',
      [req.user.id, product_id, variant_id, quantity]
    );
  }
  res.status(201).json({ ok: true });
});

router.patch('/cart/:id', async (req, res) => {
  const parsed = z
    .object({
      quantity: z.number().int().min(1).max(20).optional(),
      saved_for_later: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { quantity, saved_for_later } = parsed.data;
  await db.query(
    `UPDATE cart_items SET quantity = COALESCE($1, quantity),
       saved_for_later = COALESCE($2, saved_for_later)
     WHERE id = $3 AND user_id = $4`,
    [quantity ?? null, saved_for_later ?? null, req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.delete('/cart/:id', async (req, res) => {
  await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ============ WISHLIST ============
router.get('/wishlist', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.title, p.slug, p.price, p.discount_price, p.rating_avg,
            (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order LIMIT 1) AS image
     FROM wishlist_items w JOIN products p ON p.id = w.product_id
     WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/wishlist/:productId', async (req, res) => {
  await db.query(
    'INSERT INTO wishlist_items (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.user.id, req.params.productId]
  );
  res.status(201).json({ ok: true });
});

router.delete('/wishlist/:productId', async (req, res) => {
  await db.query('DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [
    req.user.id,
    req.params.productId,
  ]);
  res.json({ ok: true });
});

module.exports = router;
