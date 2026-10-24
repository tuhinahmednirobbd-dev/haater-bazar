const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/products?category=&brand=&min=&max=&rating=&q=&sort=&page=&limit=
router.get('/', async (req, res) => {
  const q = z
    .object({
      category: z.string().optional(),
      brand: z.string().optional(),
      min: z.coerce.number().min(0).optional(),
      max: z.coerce.number().min(0).optional(),
      rating: z.coerce.number().min(0).max(5).optional(),
      q: z.string().max(100).optional(),
      sort: z.enum(['newest', 'price_asc', 'price_desc', 'rating', 'popular']).default('newest'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(60).default(24),
    })
    .parse(req.query);

  const where = ['p.is_active'];
  const params = [];
  // push(value) stores the value and returns its $n placeholder, so a value can be
  // referenced more than once by reusing the returned string
  const push = (val) => {
    params.push(val);
    return `$${params.length}`;
  };

  if (q.category) {
    // include sub-categories of the chosen category
    const c = push(q.category);
    where.push(`p.category_id IN (SELECT id FROM categories
      WHERE slug = ${c} OR parent_id = (SELECT id FROM categories WHERE slug = ${c}))`);
  }
  if (q.brand) where.push(`p.brand_id = (SELECT id FROM brands WHERE slug = ${push(q.brand)})`);
  if (q.min !== undefined) where.push(`COALESCE(p.discount_price, p.price) >= ${push(q.min)}`);
  if (q.max !== undefined) where.push(`COALESCE(p.discount_price, p.price) <= ${push(q.max)}`);
  if (q.rating) where.push(`p.rating_avg >= ${push(q.rating)}`);
  if (q.q) {
    const like = push(`%${q.q}%`);
    const raw = push(q.q);
    where.push(`(p.title ILIKE ${like} OR similarity(p.title, ${raw}) > 0.25)`);
  }

  const whereSql = where.join(' AND ');

  const orderBy = {
    newest: 'p.created_at DESC',
    price_asc: 'COALESCE(p.discount_price, p.price) ASC',
    price_desc: 'COALESCE(p.discount_price, p.price) DESC',
    rating: 'p.rating_avg DESC, p.rating_count DESC',
    popular: 'p.sold_count DESC',
  }[q.sort];

  const offset = (q.page - 1) * q.limit;
  const sql = `
    SELECT p.id, p.title, p.slug, p.price, p.discount_price, p.rating_avg, p.rating_count,
           p.stock, b.name AS brand,
           (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order LIMIT 1) AS image,
           COUNT(*) OVER() AS total
    FROM products p LEFT JOIN brands b ON b.id = p.brand_id
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${q.limit} OFFSET ${offset}`;
  const { rows } = await db.query(sql, params);
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    items: rows.map(({ total, ...r }) => r),
    total: rows[0] ? Number(rows[0].total) : 0,
    page: q.page,
  });
});

router.get('/categories', async (_req, res) => {
  const { rows } = await db.query('SELECT * FROM categories ORDER BY sort_order, name');
  const roots = rows.filter((c) => !c.parent_id).map((c) => ({
    ...c,
    children: rows.filter((x) => x.parent_id === c.id),
  }));
  res.set('Cache-Control', 'public, max-age=300');
  res.json(roots);
});

router.get('/:slug', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.*, b.name AS brand, c.name AS category
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     JOIN categories c ON c.id = p.category_id
     WHERE p.slug = $1 AND p.is_active`,
    [req.params.slug]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  const p = rows[0];
  const [images, variants, reviews] = await Promise.all([
    db.query('SELECT url FROM product_images WHERE product_id = $1 ORDER BY sort_order', [p.id]),
    db.query('SELECT * FROM product_variants WHERE product_id = $1', [p.id]),
    db.query(
      `SELECT r.rating, r.comment, r.created_at, u.name
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
      [p.id]
    ),
  ]);
  res.json({ ...p, images: images.rows, variants: variants.rows, reviews: reviews.rows });
});

// Only customers who actually received the product may review it
router.post('/:id/reviews', requireAuth, async (req, res) => {
  const parsed = z
    .object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  const bought = await db.query(
    `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.user_id = $1 AND oi.product_id = $2 AND o.status = 'delivered' LIMIT 1`,
    [req.user.id, req.params.id]
  );
  if (!bought.rowCount) return res.status(403).json({ error: 'Only verified buyers can review' });

  await db.query(
    `INSERT INTO reviews (product_id, user_id, rating, comment) VALUES ($1,$2,$3,$4)
     ON CONFLICT (product_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`,
    [req.params.id, req.user.id, parsed.data.rating, parsed.data.comment || null]
  );
  await db.query(
    `UPDATE products SET
       rating_avg = (SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE product_id = $1),
       rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1)
     WHERE id = $1`,
    [req.params.id]
  );
  res.status(201).json({ ok: true });
});

module.exports = router;
