// HomeRecord — Property routes
// GET  /api/properties/search?address=...
// GET  /api/properties/:id
// GET  /api/properties/:id/events
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const chicagoData = require('../services/chicagoData');

// Search properties by address
router.get('/search', async (req, res) => {
  const { address, city = 'Chicago', state = 'IL', limit = 10 } = req.query;
  if (!address) return res.status(400).json({ error: 'address query param required' });

  try {
    // 1. Check our database first
    const { rows } = await db.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM property_events e WHERE e.property_id = p.property_id) AS event_count,
              (SELECT COUNT(*) FROM property_events e WHERE e.property_id = p.property_id AND e.flag_severity = 'critical') AS flag_count
       FROM properties p
       WHERE p.address_full ILIKE $1 OR p.address_full ILIKE $2
       LIMIT $3`,
      [`%${address}%`, `${address}%`, parseInt(limit)]
    );

    // 2. If nothing in DB, pull from Chicago API and return live data
    if (!rows.length) {
      try {
        const liveData = await chicagoData.getEventsForAddress(address);
        return res.json({
          source: 'live_api',
          properties: [],
          live_events: liveData.events.slice(0, 5),
          permit_score: liveData.permit_score,
          message: 'No property record yet — showing live permit data'
        });
      } catch {
        return res.json({ source: 'none', properties: [], message: 'No data found for this address' });
      }
    }

    res.json({ source: 'database', properties: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full property by ID
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM properties WHERE property_id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all events for a property (the timeline)
router.get('/:id/events', async (req, res) => {
  const { type, verified_only } = req.query;
  try {
    let query = `
      SELECT e.*,
             v.method         AS verification_method,
             v.confidence     AS verification_confidence,
             v.source_url     AS verification_url,
             dd.contractor_name, dd.warranty_term, dd.warranty_transferable,
             dd.inspection_result
      FROM property_events e
      LEFT JOIN verifications v  ON v.verification_id = e.verified_by
      LEFT JOIN deep_dive_details dd ON dd.event_id = e.event_id
      WHERE e.property_id = $1`;
    const params = [req.params.id];

    if (type) { query += ` AND e.event_type = $${params.length+1}`; params.push(type); }
    if (verified_only === 'true') { query += ` AND e.verified_by IS NOT NULL`; }
    query += ' ORDER BY e.event_date DESC NULLS LAST';

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync a property with Chicago live data (admin / background job)
router.post('/:id/sync', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM properties WHERE property_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    const prop = rows[0];

    const liveData = await chicagoData.getEventsForAddress(prop.address_full);
    let inserted = 0;

    await db.transaction(async client => {
      for (const event of liveData.events) {
        // Skip if already exists (by source ref ID)
        const exists = await client.query(
          'SELECT event_id FROM property_events WHERE property_id=$1 AND source_ref_id=$2',
          [prop.property_id, event.source_ref_id]
        );
        if (exists.rows.length) continue;

        await client.query(
          `INSERT INTO property_events
           (property_id, event_type, event_date, title, description, cost_estimate,
            status, flag_severity, source_type, source_ref_id, category, deep_dive_available)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [prop.property_id, event.event_type, event.event_date, event.title,
           event.description, event.cost_estimate, event.status, event.flag_severity,
           event.source_type, event.source_ref_id, event.category, event.deep_dive_available]
        );
        inserted++;
      }

      // Update permit score and sync timestamp
      await client.query(
        `UPDATE properties SET score_permits=$1, last_synced_at=NOW() WHERE property_id=$2`,
        [liveData.permit_score, prop.property_id]
      );
    });

    res.json({ synced: inserted, permit_score: liveData.permit_score, total_events: liveData.events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
