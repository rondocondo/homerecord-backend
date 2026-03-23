// HomeRecord — Chicago Open Data service
// Fetches permits + violations and maps them to HomeRecord events
const fetch = require('node-fetch');

const PERMITS_URL    = process.env.CHICAGO_PERMITS_URL    || 'https://data.cityofchicago.org/resource/ydr8-5enu.json';
const VIOLATIONS_URL = process.env.CHICAGO_VIOLATIONS_URL || 'https://data.cityofchicago.org/resource/22u3-xenr.json';
const APP_TOKEN      = process.env.CHICAGO_APP_TOKEN || null;

const CATEGORY_MAP = {
  'HVAC':            { category: 'HVAC / Heating',  event_type: 'repair', dot: 'green' },
  'ELECTRICAL':      { category: 'Electrical',       event_type: 'permit', dot: 'green' },
  'PLUMBING':        { category: 'Plumbing / Sewer', event_type: 'repair', dot: 'green' },
  'ROOFING':         { category: 'Roof',             event_type: 'repair', dot: 'green' },
  'RENOVATION':      { category: 'Renovation',       event_type: 'repair', dot: 'green' },
  'REHAB':           { category: 'Renovation',       event_type: 'repair', dot: 'green' },
  'NEW CONSTRUCTION':{ category: 'New construction', event_type: 'permit', dot: 'blue'  },
  'ADDITION':        { category: 'Addition',         event_type: 'permit', dot: 'amber' },
  'WRECKING':        { category: 'Demolition',       event_type: 'permit', dot: 'red'   },
  'EASY PERMIT':     { category: 'Minor repair',     event_type: 'repair', dot: 'green' },
};

function classify(permitType = '', workDesc = '') {
  const text = `${permitType} ${workDesc}`.toUpperCase();
  for (const [k, v] of Object.entries(CATEGORY_MAP)) {
    if (text.includes(k)) return v;
  }
  return { category: 'Building permit', event_type: 'permit', dot: 'blue' };
}

function parseAddress(addr) {
  const m = addr.toUpperCase().trim().match(/^(\d+)\s+([NSEW])?\s*(.+?)(?:\s+(?:AVE|ST|DR|BLVD|LN|RD|CT|PL|WAY))?$/);
  if (!m) return null;
  return { number: m[1], direction: m[2] || '', name: m[3].trim() };
}

function buildTitle(p) {
  const desc  = (p.work_description || '').trim();
  const first = desc.split('.')[0].trim();
  if (first.length > 8 && first.length < 80) return first;
  const t = (p.permit_type || 'Building permit');
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function headers() {
  const h = { Accept: 'application/json' };
  if (APP_TOKEN) h['X-App-Token'] = APP_TOKEN;
  return h;
}

async function fetchPermits(address, limit = 50) {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error(`Cannot parse address: ${address}`);
  const { number, direction, name } = parsed;
  const firstName = name.split(' ')[0];

  const where = [
    `street_number='${number}'`,
    direction ? `street_direction='${direction}'` : null,
    `upper(street_name) like '${firstName}%'`
  ].filter(Boolean).join(' AND ');

  const params = new URLSearchParams({ $limit: limit, $order: 'issue_date DESC', $where: where });
  const res = await fetch(`${PERMITS_URL}?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`Permits API: HTTP ${res.status}`);
  return res.json();
}

async function fetchViolations(address, limit = 20) {
  const parsed = parseAddress(address);
  if (!parsed) return [];
  const { number, name } = parsed;
  const firstName = name.split(' ')[0];

  const where = `address like '${number}%' AND upper(address) like '%${firstName}%'`;
  const params = new URLSearchParams({ $limit: limit, $order: 'violation_date DESC', $where: where });
  const res = await fetch(`${VIOLATIONS_URL}?${params}`, { headers: headers() });
  if (!res.ok) return [];
  return res.json();
}

function mapPermitToEvent(p) {
  const { category, event_type, dot } = classify(p.permit_type, p.work_description);
  const verified = ['ISSUED','COMPLETED','PERMIT ISSUED','FINALED']
    .includes((p.current_status || '').toUpperCase());
  return {
    event_type,
    event_date:    p.issue_date ? p.issue_date.split('T')[0] : null,
    title:         buildTitle(p),
    description:   p.work_description || '',
    cost_estimate: p.reported_cost ? parseFloat(p.reported_cost) : null,
    status:        verified ? 'resolved' : 'unknown',
    flag_severity: 'none',
    source_type:   'city_permit',
    source_ref_id: p.id,
    category,
    deep_dive_available: true,
    verified_auto: verified,
    raw: p,
    deep_dive: {
      permit_number:   p.id,
      permit_type:     p.permit_type,
      status:          p.current_status,
      contractor_name: [p.contractor_first_name, p.contractor_last_name].filter(Boolean).join(' ') || null,
      contractor_phone:p.contact_1_phone || null,
      reported_cost:   p.reported_cost,
      issue_date:      p.issue_date,
      expiration_date: p.expiration_date,
      community_area:  p.community_area,
      ward:            p.ward,
    }
  };
}

function mapViolationToEvent(v) {
  const isOpen = !v.disposition_date;
  return {
    event_type:    'violation',
    event_date:    v.violation_date?.split('T')[0] || null,
    title:         v.violation_description || 'City violation',
    description:   v.violation_description || '',
    status:        isOpen ? 'open' : 'resolved',
    flag_severity: isOpen ? 'critical' : 'info',
    source_type:   'city_permit',
    source_ref_id: v.id,
    category:      'City violation',
    deep_dive_available: true,
    verified_auto: true,
    raw: v,
    deep_dive: {
      case_number:      v.id,
      status:           v.disposition || 'Open',
      violation_date:   v.violation_date,
      disposition_date: v.disposition_date || null,
      inspector_id:     v.inspector_id || null,
    }
  };
}

function calcPermitScore(events) {
  let score = 100;
  score -= events.filter(e => e.event_type === 'violation' && e.status === 'open').length * 15;
  score -= events.filter(e => e.flag_severity === 'critical').length * 10;
  const tenYearsAgo = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000);
  const hasRecent = events.some(e => e.event_date && new Date(e.event_date) > tenYearsAgo);
  if (!hasRecent) score -= 10;
  return Math.max(0, Math.min(100, score));
}

async function getEventsForAddress(address) {
  const [rawPermits, rawViolations] = await Promise.allSettled([
    fetchPermits(address),
    fetchViolations(address)
  ]);

  const permits    = rawPermits.status    === 'fulfilled' ? rawPermits.value    : [];
  const violations = rawViolations.status === 'fulfilled' ? rawViolations.value : [];

  const events = [
    ...permits.map(mapPermitToEvent),
    ...violations.map(mapViolationToEvent)
  ].sort((a, b) => {
    if (!a.event_date) return 1;
    if (!b.event_date) return -1;
    return b.event_date.localeCompare(a.event_date);
  });

  return {
    events,
    permit_score:   calcPermitScore(events),
    total_permits:  permits.length,
    total_violations: violations.length,
    open_violations: violations.filter(v => !v.disposition_date).length,
    source: 'chicago_open_data'
  };
}

module.exports = { getEventsForAddress, fetchPermits, fetchViolations, calcPermitScore };
