const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/*
 * PAYMENT RULES (apply to every gateway):
 *  1. The amount charged always comes from the orders table, never from the client.
 *  2. An order is marked "paid" ONLY after the server verifies the transaction
 *     directly with the gateway (validation / execute / query API).
 *  3. Browser redirects (success/fail/cancel URLs) are untrusted: they only trigger verification.
 *  4. gateway_txn_id is UNIQUE, so a replayed callback can't pay twice.
 *
 * Gateways:
 *  - Cards, Nagad, bKash, Rocket via SSLCommerz (one integration, many methods) -> easiest start
 *  - bKash direct "Tokenized Checkout" -> lower fees at scale, needs merchant approval
 */

const API = process.env.API_URL || 'http://localhost:5000';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:3000';

async function loadOwnedOrder(orderId, userId) {
  const { rows } = await db.query(
    `SELECT o.*, u.name, u.email, u.phone FROM orders o JOIN users u ON u.id = o.user_id
     WHERE o.id = $1 AND o.user_id = $2 AND o.payment_status IN ('pending','failed')`,
    [orderId, userId]
  );
  return rows[0];
}

async function markPaid(orderId, method, txnId, payload) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO payments (order_id, method, amount, status, gateway_txn_id, gateway_payload)
       SELECT id, $2, total, 'paid', $3, $4 FROM orders WHERE id = $1
       ON CONFLICT (gateway_txn_id) DO NOTHING RETURNING id`,
      [orderId, method, txnId, JSON.stringify(payload)]
    );
    if (ins.rowCount) {
      await client.query(
        `UPDATE orders SET payment_status='paid', status='confirmed', updated_at=now() WHERE id=$1`,
        [orderId]
      );
      await client.query(`INSERT INTO order_status_history (order_id,status,note) VALUES ($1,'confirmed','Payment received')`, [orderId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- SSLCommerz (cards / bKash / Nagad / Rocket) ----------
const sslBase = () =>
  process.env.SSLCOMMERZ_SANDBOX === 'true'
    ? 'https://sandbox.sslcommerz.com'
    : 'https://securepay.sslcommerz.com';

router.post('/:orderId/init', requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not payable' });
  const addr = order.address_snapshot;

  const body = new URLSearchParams({
    store_id: process.env.SSLCOMMERZ_STORE_ID,
    store_passwd: process.env.SSLCOMMERZ_STORE_PASS,
    total_amount: String(order.total),
    currency: 'BDT',
    tran_id: order.id, // our order id
    success_url: `${API}/api/payments/ssl/success`,
    fail_url: `${API}/api/payments/ssl/fail`,
    cancel_url: `${API}/api/payments/ssl/cancel`,
    cus_name: order.name,
    cus_email: order.email || 'noemail@shopbd.com',
    cus_phone: order.phone || addr.phone,
    cus_add1: addr.address,
    cus_city: addr.district,
    cus_country: 'Bangladesh',
    shipping_method: 'NO',
    product_name: `Order ${order.order_number}`,
    product_category: 'general',
    product_profile: 'general',
    // Optionally restrict methods: multi_card_name: 'bkash,nagad,visacard,mastercard'
  });
  const r = await fetch(`${sslBase()}/gwprocess/v4/api.php`, { method: 'POST', body });
  const data = await r.json();
  if (data.status !== 'SUCCESS') return res.status(502).json({ error: 'Gateway error' });
  res.json({ redirectUrl: data.GatewayPageURL });
});

// SSLCommerz POSTs here after the customer pays. We VERIFY server-to-server before trusting it.
router.post('/ssl/success', express.urlencoded({ extended: false }), async (req, res) => {
  const { val_id, tran_id } = req.body;
  try {
    const url =
      `${sslBase()}/validator/api/validationserverAPI.php?val_id=${encodeURIComponent(val_id)}` +
      `&store_id=${process.env.SSLCOMMERZ_STORE_ID}&store_passwd=${process.env.SSLCOMMERZ_STORE_PASS}&format=json`;
    const v = await (await fetch(url)).json();
    const order = await db.query('SELECT total FROM orders WHERE id = $1', [tran_id]);
    const ok =
      ['VALID', 'VALIDATED'].includes(v.status) &&
      order.rowCount &&
      Number(v.amount) === Number(order.rows[0].total) &&
      v.currency === 'BDT';
    if (ok) {
      await markPaid(tran_id, 'card', v.bank_tran_id || val_id, v);
      return res.redirect(`${CLIENT}/account/orders/${tran_id}?paid=1`);
    }
  } catch (e) {
    console.error('SSL verify failed', e);
  }
  res.redirect(`${CLIENT}/checkout?payment=failed`);
});
router.post('/ssl/fail', express.urlencoded({ extended: false }), async (req, res) => {
  await db.query(`UPDATE orders SET payment_status='failed' WHERE id=$1 AND payment_status='pending'`, [req.body.tran_id]);
  res.redirect(`${CLIENT}/checkout?payment=failed`);
});
router.post('/ssl/cancel', express.urlencoded({ extended: false }), (_req, res) =>
  res.redirect(`${CLIENT}/checkout?payment=cancelled`)
);

// ---------- bKash direct (Tokenized Checkout) ----------
async function bkashToken() {
  const r = await fetch(`${process.env.BKASH_BASE_URL}/tokenized/checkout/token/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      username: process.env.BKASH_USERNAME,
      password: process.env.BKASH_PASSWORD,
    },
    body: JSON.stringify({
      app_key: process.env.BKASH_APP_KEY,
      app_secret: process.env.BKASH_APP_SECRET,
    }),
  });
  return (await r.json()).id_token; // cache this ~55 min in production
}
const bkashHeaders = (token) => ({
  'Content-Type': 'application/json',
  authorization: token,
  'x-app-key': process.env.BKASH_APP_KEY,
});

router.post('/:orderId/bkash/create', requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not payable' });
  const token = await bkashToken();
  const r = await fetch(`${process.env.BKASH_BASE_URL}/tokenized/checkout/create`, {
    method: 'POST',
    headers: bkashHeaders(token),
    body: JSON.stringify({
      mode: '0011',
      payerReference: order.phone || order.id,
      callbackURL: `${API}/api/payments/bkash/callback`,
      amount: Number(order.total).toFixed(2),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: order.order_number,
    }),
  });
  const data = await r.json();
  if (!data.bkashURL) return res.status(502).json({ error: 'bKash error' });
  // store paymentID -> order mapping so the callback can find the order
  await db.query(
    `INSERT INTO payments (order_id, method, amount, status, gateway_txn_id)
     VALUES ($1,'bkash',$2,'pending',$3)`,
    [order.id, order.total, 'PENDING-' + data.paymentID]
  );
  res.json({ redirectUrl: data.bkashURL });
});

router.get('/bkash/callback', async (req, res) => {
  const { paymentID, status } = req.query;
  if (status !== 'success') return res.redirect(`${CLIENT}/checkout?payment=${status}`);
  try {
    const pending = await db.query(
      `SELECT order_id, amount FROM payments WHERE gateway_txn_id = $1`,
      ['PENDING-' + paymentID]
    );
    if (!pending.rowCount) throw new Error('Unknown payment');
    const token = await bkashToken();
    const r = await fetch(`${process.env.BKASH_BASE_URL}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: bkashHeaders(token),
      body: JSON.stringify({ paymentID }),
    });
    const data = await r.json();
    if (data.statusCode === '0000' && data.transactionStatus === 'Completed' &&
        Number(data.amount) === Number(pending.rows[0].amount)) {
      await db.query(`DELETE FROM payments WHERE gateway_txn_id = $1`, ['PENDING-' + paymentID]);
      await markPaid(pending.rows[0].order_id, 'bkash', data.trxID, data);
      return res.redirect(`${CLIENT}/account/orders/${pending.rows[0].order_id}?paid=1`);
    }
  } catch (e) {
    console.error('bKash execute failed', e);
  }
  res.redirect(`${CLIENT}/checkout?payment=failed`);
});

/*
 * Nagad: same pattern as bKash (initialize -> checkout -> verify). Nagad's merchant API
 * needs RSA key exchange and merchant onboarding; until approved, offer Nagad through
 * SSLCommerz above, which already supports it.
 */

module.exports = router;
