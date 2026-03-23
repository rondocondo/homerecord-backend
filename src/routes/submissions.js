// ── SUBMISSIONS ROUTER ────────────────────────────────────────────────────────
// POST /api/submissions          — homeowner submits a record
// GET  /api/submissions/mine     — homeowner views their submissions
const submissionsRouter = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

submissionsRouter.post('/', auth, async (req, res) => {
  const { property_id, event_type, raw_data } = req.body;
  if (!property_id || !raw_data) return res.status(400).json({ error: 'property_id and raw_data required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO data_submissions (property_id, submitted_by, event_type, raw_data)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [property_id, req.user.user_id, event_type, JSON.stringify(raw_data)]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

submissionsRouter.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, p.address_full FROM data_submissions s
       JOIN properties p ON p.property_id = s.property_id
       WHERE s.submitted_by=$1 ORDER BY s.created_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAYMENTS ROUTER ───────────────────────────────────────────────────────────
// POST /api/payments/create-intent   — create Stripe payment intent
// POST /api/payments/webhook         — Stripe webhook (raw body)
const paymentsRouter = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

paymentsRouter.post('/create-intent', auth, async (req, res) => {
  const { property_id } = req.body;
  if (!property_id) return res.status(400).json({ error: 'property_id required' });

  const amount = parseInt(process.env.REPORT_PRICE_CENTS || 3900);
  try {
    // Create pending purchase record
    const { rows } = await db.query(
      `INSERT INTO report_purchases (user_id, property_id, amount_cents, status)
       VALUES ($1,$2,$3,'pending') RETURNING purchase_id`,
      [req.user.user_id, property_id, amount]
    );
    const purchaseId = rows[0].purchase_id;

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: { purchase_id: purchaseId, property_id, user_id: req.user.user_id }
    });

    // Store Stripe PI ID
    await db.query(
      'UPDATE report_purchases SET stripe_pi_id=$1 WHERE purchase_id=$2',
      [intent.id, purchaseId]
    );

    res.json({ client_secret: intent.client_secret, purchase_id: purchaseId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

paymentsRouter.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await db.query(
      `UPDATE report_purchases SET status='completed', stripe_charge_id=$1
       WHERE stripe_pi_id=$2`,
      [pi.latest_charge, pi.id]
    );
    console.log(`✅ Payment succeeded: ${pi.id} for property ${pi.metadata.property_id}`);
  }

  res.json({ received: true });
});

// ── ADMIN ROUTER ──────────────────────────────────────────────────────────────
// GET    /api/admin/submissions           — list pending submissions
// PATCH  /api/admin/submissions/:id       — approve / reject / request info
// GET    /api/admin/stats                 — dashboard stats
const adminRouter  = require('express').Router();
const { adminOnly } = require('../middleware/auth');

adminRouter.use(auth, adminOnly);

adminRouter.get('/submissions', async (req, res) => {
  const { status = 'pending', limit = 50, offset = 0 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT s.*, p.address_full, u.email AS submitter_email, u.full_name AS submitter_name
       FROM data_submissions s
       JOIN properties p ON p.property_id = s.property_id
       JOIN users u ON u.user_id = s.submitted_by
       WHERE s.review_status = $1
       ORDER BY s.created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.patch('/submissions/:id', async (req, res) => {
  const { review_status, reviewer_notes } = req.body;
  const validStatuses = ['approved','rejected','needs_info'];
  if (!validStatuses.includes(review_status)) {
    return res.status(400).json({ error: `review_status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    await db.transaction(async client => {
      const { rows } = await client.query(
        `UPDATE data_submissions
         SET review_status=$1, reviewer_notes=$2, reviewer_id=$3, reviewed_at=NOW()
         WHERE submission_id=$4 RETURNING *`,
        [review_status, reviewer_notes, req.user.user_id, req.params.id]
      );
      const sub = rows[0];
      if (!sub) throw new Error('Submission not found');

      // If approved — create a real property_events row
      if (review_status === 'approved') {
        const d = sub.raw_data;
        const { rows: eventRows } = await client.query(
          `INSERT INTO property_events
           (property_id, event_type, event_date, title, description, cost_estimate,
            status, flag_severity, source_type, category, deep_dive_available)
           VALUES ($1,$2,$3,$4,$5,$6,'resolved','none','homeowner',$7,true) RETURNING event_id`,
          [sub.property_id, sub.event_type || 'repair',
           d.event_date, d.title, d.description, d.cost,
           d.category || 'General repair']
        );
        const newEventId = eventRows[0].event_id;

        // Insert deep dive details if provided
        if (d.contractor_name || d.warranty_term) {
          await client.query(
            `INSERT INTO deep_dive_details
             (event_id, contractor_name, contractor_license, warranty_term,
              warranty_transferable, materials_used)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [newEventId, d.contractor_name, d.contractor_license,
             d.warranty_term, d.warranty_transferable,
             d.materials ? JSON.stringify(d.materials) : null]
          );
        }

        // Link submission to created event
        await client.query(
          'UPDATE data_submissions SET created_event_id=$1 WHERE submission_id=$2',
          [newEventId, sub.submission_id]
        );

        // Recalculate property score (simplified)
        await recalcScore(client, sub.property_id);
      }
      return sub;
    });

    res.json({ success: true, review_status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/stats', async (req, res) => {
  try {
    const [pending, approvedToday, rejected, revenue] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM data_submissions WHERE review_status='pending'`),
      db.query(`SELECT COUNT(*) FROM data_submissions WHERE review_status='approved' AND reviewed_at > NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COUNT(*) FROM data_submissions WHERE review_status='rejected' AND reviewed_at > NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM report_purchases WHERE status='completed' AND purchased_at > NOW() - INTERVAL '30 days'`),
    ]);
    res.json({
      pending:       parseInt(pending.rows[0].count),
      approved_today:parseInt(approvedToday.rows[0].count),
      rejected_today:parseInt(rejected.rows[0].count),
      revenue_30d_cents: parseInt(revenue.rows[0].total)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function recalcScore(client, propertyId) {
  const { rows } = await client.query(
    `SELECT event_type, flag_severity, status FROM property_events WHERE property_id=$1`,
    [propertyId]
  );
  let score = 100;
  score -= rows.filter(e => e.flag_severity === 'critical').length * 15;
  score -= rows.filter(e => e.event_type === 'violation' && e.status === 'open').length * 10;
  score = Math.max(0, Math.min(100, score));
  await client.query(
    `INSERT INTO property_scores (property_id, score_overall, algorithm_version)
     VALUES ($1,$2,'v1.0')`,
    [propertyId, score]
  );
  await client.query(
    'UPDATE properties SET score_overall=$1, updated_at=NOW() WHERE property_id=$2',
    [score, propertyId]
  );
}

module.exports = { submissionsRouter, paymentsRouter, adminRouter };
