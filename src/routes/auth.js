// HomeRecord — Auth routes
// POST /api/auth/register
// POST /api/auth/login
// GET  /api/auth/me
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { auth } = require('../middleware/auth');

function signToken(user) {
  return jwt.sign(
    { user_id: user.user_id, email: user.email, role: user.role, plan: user.plan },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Register
router.post('/register', async (req, res) => {
  const { email, password, full_name, role = 'buyer' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const exists = await db.query('SELECT user_id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4) RETURNING user_id, email, full_name, role, plan, created_at`,
      [email.toLowerCase(), hash, full_name, role]
    );
    const user = rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email=$1', [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT user_id, email, full_name, role, plan, created_at FROM users WHERE user_id=$1',
      [req.user.user_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
