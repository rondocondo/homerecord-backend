// HomeRecord — FEMA routes
// GET  /api/fema/risk?lat=41.878&lng=-87.629&zip=60614&state=IL
// POST /api/fema/sync/:propertyId  — fetch + store FEMA data for a property

const router   = require('express').Router();
const db       = require('../db');
const { auth } = require('../middleware/auth');
const fema     = require('../services/femaData');

// Live FEMA lookup by coordinates (no auth required — used on report page)
router.get('/risk', async (req, res) => {
  const { lat, lng, zip, state = 'IL', county = '' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  try {
    const data = await fema.getDisasterRiskForProperty({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      zip, state, county
    });
    res.json(data.display);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync FEMA data for a stored property — saves to disaster_risk table
// and inserts disaster declaration events into property_events
router.post('/sync/:propertyId', auth, async (req, res) => {
  const { propertyId } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT * FROM properties WHERE property_id=$1', [propertyId]
    );
    const prop = rows[0];
    if (!prop) return res.status(404).json({ error: 'Property not found' });
    if (!prop.lat || !prop.lng) return res.status(400).json({ error: 'Property has no coordinates — geocode first' });

    const data = await fema.getDisasterRiskForProperty({
      lat:    parseFloat(prop.lat),
      lng:    parseFloat(prop.lng),
      zip:    prop.zip,
      state:  prop.state || 'IL',
      county: req.body.county || ''
    });

    await db.transaction(async client => {
      // Upsert disaster_risk row
      await client.query(
        `INSERT INTO disaster_risk
           (property_id, fema_flood_zone, flood_claims_count, environmental_flags)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (property_id)
         DO UPDATE SET
           fema_flood_zone    = EXCLUDED.fema_flood_zone,
           flood_claims_count = EXCLUDED.flood_claims_count,
           environmental_flags= EXCLUDED.environmental_flags,
           last_updated       = NOW()`,
        [propertyId,
         data.disaster_risk.fema_flood_zone,
         data.disaster_risk.flood_claims_count,
         JSON.stringify(data.disaster_risk.environmental_flags)]
      );

      // Insert disaster declaration events (skip duplicates)
      let inserted = 0;
      for (const event of data.events) {
        const exists = await client.query(
          'SELECT event_id FROM property_events WHERE property_id=$1 AND source_ref_id=$2',
          [propertyId, event.source_ref_id]
        );
        if (exists.rows.length) continue;
        await client.query(
          `INSERT INTO property_events
             (property_id, event_type, event_date, title, description,
              status, flag_severity, source_type, source_ref_id, category, deep_dive_available)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [propertyId, event.event_type, event.event_date, event.title,
           event.description, event.status, event.flag_severity,
           event.source_type, event.source_ref_id, event.category, event.deep_dive_available ?? true]
        );
        inserted++;
      }

      // Update property score for disaster
      await client.query(
        'UPDATE properties SET score_disaster=$1, updated_at=NOW() WHERE property_id=$2',
        [data.display.score, propertyId]
      );
    });

    res.json({
      flood_zone:      data.display.flood_zone,
      flood_zone_desc: data.display.flood_zone_desc,
      score:           data.display.score,
      score_label:     data.display.score_label,
      events_inserted: data.events.length,
      nfip_claims:     data.display.nfip_claims_zip,
      disasters:       data.display.disaster_count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Flood zone lookup widget — returns zone + description for any lat/lng
router.get('/floodzone', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  try {
    const zone = await fema.getFloodZone(parseFloat(lat), parseFloat(lng));
    res.json(zone);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
