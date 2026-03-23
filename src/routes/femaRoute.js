// HomeRecord — FEMA risk route (add to properties.js)
// GET /api/properties/:id/risk  — fetch + cache FEMA risk data

const femaData = require('../services/femaData');

// Add this handler inside your properties router:
router.get('/:id/risk', async (req, res) => {
  try {
    // Get property from DB
    const { rows } = await db.query('SELECT * FROM properties WHERE property_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    const prop = rows[0];

    // Check if we have fresh risk data (less than 30 days old)
    const { rows: existing } = await db.query(
      'SELECT * FROM disaster_risk WHERE property_id=$1', [prop.property_id]
    );
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (existing[0] && new Date(existing[0].last_updated) > thirtyDaysAgo) {
      return res.json({ source: 'cached', risk: existing[0] });
    }

    // Fetch fresh from FEMA
    const risk = await femaData.getRiskForProperty({
      address: prop.address_full,
      lat:     prop.lat,
      lng:     prop.lng,
      zip:     prop.zip,
      state:   prop.state
    });

    // Save to DB
    await femaData.saveRiskToDb(db, prop.property_id, risk);

    res.json({ source: 'live', risk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Standalone address risk lookup (no property_id needed — used on search page)
router.get('/risk/lookup', async (req, res) => {
  const { address, lat, lng, zip, state } = req.query;
  if (!address && (!lat || !lng)) {
    return res.status(400).json({ error: 'address or lat+lng required' });
  }
  try {
    const risk = await femaData.getRiskForProperty({ address, lat, lng, zip, state });
    res.json(risk);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
