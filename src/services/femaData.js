// HomeRecord — FEMA Data Service
// ================================
// Three free FEMA APIs, zero cost, no key required:
//
//  1. US Census Geocoder       → address to lat/lng (free, no key)
//  2. FEMA NFHL ArcGIS REST    → flood zone per lat/lng (free, no key)
//  3. OpenFEMA NFIP Claims     → prior flood claims by ZIP (free, no key)
//  4. OpenFEMA Disaster Decl.  → named disasters by state/county (free, no key)
//
// Docs: https://www.fema.gov/about/openfema/api
//       https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer

const fetch = require('node-fetch');

const OPENFEMA  = 'https://www.fema.gov/api/open/v2';
const NFHL      = 'https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer';
const GEOCODER  = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

// ─── 1. GEOCODE ──────────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format:    'json'
  });
  const res  = await fetch(`${GEOCODER}?${params}`);
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) throw new Error(`Could not geocode: ${address}`);
  const c = match.addressComponents || {};
  return {
    lat:          match.coordinates.y,
    lng:          match.coordinates.x,
    matched_addr: match.matchedAddress,
    zip:          c.zip   || '',
    state:        c.state || '',
    city:         c.city  || ''
  };
}

// ─── 2. FLOOD ZONE ───────────────────────────────────────────────────────────
function classifyFloodZone(zone = '') {
  const z = zone.toUpperCase();
  if (z === 'X' || z === 'X500')             return { level:'low',      label:'Minimal flood risk',           color:'green' };
  if (z.startsWith('A') || z==='AE')         return { level:'moderate', label:'1% annual chance flood zone',  color:'amber' };
  if (z.startsWith('V') || z==='VE')         return { level:'high',     label:'Coastal high hazard zone',     color:'red'   };
  if (z === 'D')                             return { level:'unknown',  label:'Undetermined flood risk',      color:'gray'  };
  return                                            { level:'unknown',  label:`Zone ${zone}`,                 color:'gray'  };
}

async function getFloodZone(lat, lng) {
  const params = new URLSearchParams({
    geometryType:  'esriGeometryPoint',
    geometry:      `${lng},${lat}`,
    inSR:          '4326',
    spatialRel:    'esriSpatialRelIntersects',
    outFields:     'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH',
    f:             'json',
    returnGeometry:'false'
  });
  const res  = await fetch(`${NFHL}/28/query?${params}`);
  if (!res.ok) return { flood_zone: 'Unknown', sfha: false, source: 'nfhl' };
  const data = await res.json();
  const a    = data?.features?.[0]?.attributes;
  if (!a) return { flood_zone: 'Unknown', sfha: false, source: 'nfhl' };
  return {
    flood_zone:           a.FLD_ZONE   || 'Unknown',
    zone_subtype:         a.ZONE_SUBTY || null,
    sfha:                 a.SFHA_TF === 'T',
    base_flood_elevation: a.STATIC_BFE || null,
    depth:                a.DEPTH      || null,
    risk_label:           classifyFloodZone(a.FLD_ZONE),
    source:               'fema_nfhl'
  };
}

// ─── 3. NFIP FLOOD CLAIMS ────────────────────────────────────────────────────
async function getFloodClaims(zip, state) {
  const params = new URLSearchParams({
    $limit:  100,
    $where:  `reportedZipCode='${zip}' AND state='${state}'`,
    $select: 'yearOfLoss,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,floodZone',
    $order:  'yearOfLoss DESC'
  });
  const res  = await fetch(`${OPENFEMA}/FimaNfipClaims?${params}`);
  if (!res.ok) return { total_claims: 0, zip, source: 'openfema_nfip' };
  const raw    = await res.json();
  const claims = raw.FimaNfipClaims || raw || [];
  const years  = [...new Set(claims.map(c => c.yearOfLoss).filter(Boolean))].sort((a,b)=>b-a);
  const totalPaid = claims.reduce((s,c) =>
    s + parseFloat(c.amountPaidOnBuildingClaim||0) + parseFloat(c.amountPaidOnContentsClaim||0), 0);
  return {
    total_claims:      claims.length,
    years_with_claims: years,
    most_recent_year:  years[0] || null,
    total_paid_usd:    Math.round(totalPaid),
    zip,
    source: 'openfema_nfip'
  };
}

// ─── 4. DISASTER DECLARATIONS ────────────────────────────────────────────────
async function getDisasterDeclarations(state, county) {
  const countyClean = (county||'').toUpperCase().replace(' COUNTY','').trim();
  const where = countyClean
    ? `state='${state}' AND upper(designatedArea) like '${countyClean}%'`
    : `state='${state}'`;
  const params = new URLSearchParams({
    $limit:  15,
    $where:  where,
    $select: 'disasterNumber,declarationTitle,incidentType,declarationDate,incidentBeginDate,incidentEndDate,designatedArea',
    $order:  'declarationDate DESC'
  });
  const res  = await fetch(`${OPENFEMA}/DisasterDeclarationsSummaries?${params}`);
  if (!res.ok) return [];
  const raw  = await res.json();
  return (raw.DisasterDeclarationsSummaries || raw || []).map(d => ({
    disaster_number:  d.disasterNumber,
    title:            d.declarationTitle,
    incident_type:    d.incidentType,
    declaration_date: d.declarationDate?.split('T')[0],
    begin_date:       d.incidentBeginDate?.split('T')[0],
    end_date:         d.incidentEndDate?.split('T')[0],
    area:             d.designatedArea
  }));
}

// ─── 5. RISK SCORER ──────────────────────────────────────────────────────────
function calcDisasterScore({ floodZone, floodClaims, disasters }) {
  let score = 100;
  const level = floodZone?.risk_label?.level;
  if (level === 'high')          score -= 35;
  else if (level === 'moderate') score -= 15;
  else if (level === 'unknown')  score -= 5;
  const claims = floodClaims?.total_claims || 0;
  if (claims > 50)      score -= 15;
  else if (claims > 10) score -= 8;
  else if (claims > 0)  score -= 4;
  const tenYearsAgo = new Date().getFullYear() - 10;
  const recent = (disasters||[]).filter(d => d.declaration_date &&
    new Date(d.declaration_date).getFullYear() >= tenYearsAgo);
  score -= Math.min(recent.length * 3, 15);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── 6. MASTER FUNCTION ──────────────────────────────────────────────────────
async function getRiskForProperty({ address, lat, lng, zip, state, county } = {}) {
  console.log(`🌊 FEMA lookup: ${address || `${lat},${lng}`}`);

  let coords = { lat, lng, zip, state };
  if (address && (!lat || !lng)) {
    try {
      const geo = await geocodeAddress(address);
      coords = { lat: geo.lat, lng: geo.lng, zip: geo.zip, state: geo.state };
      console.log(`  ✓ Geocoded → ${geo.matched_addr}`);
    } catch (e) { console.warn(`  ⚠ Geocode failed: ${e.message}`); }
  }

  const [fzResult, fcResult, ddResult] = await Promise.allSettled([
    coords.lat && coords.lng ? getFloodZone(coords.lat, coords.lng) : Promise.resolve({ flood_zone:'Unknown', sfha:false }),
    coords.zip && coords.state ? getFloodClaims(coords.zip, coords.state) : Promise.resolve({ total_claims:0 }),
    coords.state ? getDisasterDeclarations(coords.state, county) : Promise.resolve([])
  ]);

  const floodZone   = fzResult.status  === 'fulfilled' ? fzResult.value  : { flood_zone:'Unknown' };
  const floodClaims = fcResult.status  === 'fulfilled' ? fcResult.value  : { total_claims:0 };
  const disasters   = ddResult.status  === 'fulfilled' ? ddResult.value  : [];
  const score       = calcDisasterScore({ floodZone, floodClaims, disasters });

  console.log(`  ✓ Zone: ${floodZone.flood_zone} · Claims: ${floodClaims.total_claims} · Score: ${score}/100`);

  return { score, flood_zone: floodZone, flood_claims: floodClaims, disasters, coords,
           fetched_at: new Date().toISOString() };
}

// ─── 7. DB WRITER ────────────────────────────────────────────────────────────
async function saveRiskToDb(db, propertyId, risk) {
  await db.query(
    `INSERT INTO disaster_risk (property_id, fema_flood_zone, flood_claims_count, environmental_flags, last_updated)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (property_id) DO UPDATE
       SET fema_flood_zone=$2, flood_claims_count=$3, environmental_flags=$4, last_updated=NOW()`,
    [propertyId, risk.flood_zone?.flood_zone || 'Unknown', risk.flood_claims?.total_claims || 0,
     JSON.stringify({ sfha: risk.flood_zone?.sfha || false, recent_disasters: risk.disasters?.slice(0,5) || [],
                      risk_level: risk.flood_zone?.risk_label?.level || 'unknown' })]
  );
  await db.query('UPDATE properties SET score_disaster=$1, updated_at=NOW() WHERE property_id=$2',
    [risk.score, propertyId]);
}

if (require.main === module) {
  require('dotenv').config();
  const address = process.argv[2] || '4821 N Elmwood Ave, Chicago IL 60614';
  getRiskForProperty({ address })
    .then(d => console.log(JSON.stringify(d, null, 2)))
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { getRiskForProperty, getFloodZone, getFloodClaims,
                   getDisasterDeclarations, geocodeAddress, calcDisasterScore,
                   saveRiskToDb, classifyFloodZone };
