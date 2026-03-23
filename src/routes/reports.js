// HomeRecord — Reports route
// GET  /api/reports/:propertyId  (requires purchase or pro plan)
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

router.get('/:propertyId', auth, async (req, res) => {
  const { propertyId } = req.params;
  const userId = req.user.user_id;

  try {
    // Pro users have unlimited access
    if (req.user.plan === 'pro' || req.user.plan === 'enterprise') {
      return deliverReport(req, res, propertyId);
    }

    // Check if user has purchased this report
    const { rows } = await db.query(
      `SELECT * FROM report_purchases
       WHERE user_id=$1 AND property_id=$2 AND status='completed'`,
      [userId, propertyId]
    );
    if (!rows.length) {
      return res.status(402).json({
        error: 'Purchase required',
        price_cents: parseInt(process.env.REPORT_PRICE_CENTS || 3900),
        message: 'Buy this report for $39 or upgrade to Pro for unlimited access'
      });
    }

    deliverReport(req, res, propertyId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function deliverReport(req, res, propertyId) {
  const [propResult, eventsResult, ownershipResult, riskResult, scoresResult] =
    await Promise.all([
      db.query('SELECT * FROM properties WHERE property_id=$1', [propertyId]),
      db.query(`SELECT e.*, v.method AS verification_method, v.confidence,
                       dd.contractor_name, dd.warranty_term, dd.warranty_transferable,
                       dd.inspection_result, dd.materials_used
                FROM property_events e
                LEFT JOIN verifications v ON v.verification_id = e.verified_by
                LEFT JOIN deep_dive_details dd ON dd.event_id = e.event_id
                WHERE e.property_id=$1 ORDER BY e.event_date DESC NULLS LAST`, [propertyId]),
      db.query('SELECT * FROM ownership_history WHERE property_id=$1 ORDER BY transfer_date DESC', [propertyId]),
      db.query('SELECT * FROM disaster_risk WHERE property_id=$1', [propertyId]),
      db.query('SELECT * FROM property_scores WHERE property_id=$1 ORDER BY computed_at DESC LIMIT 1', [propertyId]),
    ]);

  const property = propResult.rows[0];
  if (!property) return res.status(404).json({ error: 'Property not found' });

  res.json({
    property,
    events:    eventsResult.rows,
    ownership: ownershipResult.rows,
    risk:      riskResult.rows[0] || null,
    scores:    scoresResult.rows[0] || null,
    flags:     eventsResult.rows.filter(e => ['critical','warning'].includes(e.flag_severity)),
    generated_at: new Date().toISOString()
  });
}

module.exports = router;
