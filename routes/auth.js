const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { employee_id, password } = req.body;
    if (!employee_id || !password) {
      return res.status(400).json({ ok: false, message: 'ID y contraseña requeridos.' });
    }

    const { rows } = await db.query(
      `SELECT id, employee_id, full_name, role, password_hash, status
       FROM users WHERE employee_id = $1 LIMIT 1`,
      [String(employee_id).trim()]
    );

    if (!rows.length) {
      return res.status(401).json({ ok: false, message: 'Usuario no encontrado.' });
    }

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, message: 'Usuario inactivo o suspendido.' });
    }
    if (!user.password_hash) {
      return res.status(401).json({ ok: false, message: 'Contraseña no configurada. Contacta al administrador.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, message: 'Contraseña incorrecta.' });
    }

    const token = jwt.sign(
      { id: user.id, employee_id: user.employee_id, full_name: user.full_name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Audit log
    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, ip_address, user_agent)
       VALUES ($1,$2,$3,'LOGIN','user',$4,$5,$6)`,
      [user.id, user.full_name, user.role, user.id,
       req.ip, req.headers['user-agent']]
    ).catch(() => {});

    res.json({
      ok: true,
      token,
      user: { id: user.id, employee_id: user.employee_id, full_name: user.full_name, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// GET /api/auth/me — info del usuario autenticado
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.employee_id, u.full_name, u.role, u.cargo,
              a.name AS area, s.name AS sede, sh.name AS shift,
              sh.start_time, sh.end_time, sh.tolerance_in_min
       FROM users u
       LEFT JOIN areas  a ON a.id = u.area_id
       LEFT JOIN sedes  s ON s.id = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 6) {
      return res.status(400).json({ ok: false, message: 'Contraseña nueva debe tener al menos 6 caracteres.' });
    }

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ ok: false, message: 'Contraseña actual incorrecta.' });

    const hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);

    res.json({ ok: true, message: 'Contraseña actualizada.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

module.exports = router;
