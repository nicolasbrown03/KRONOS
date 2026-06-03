const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();

// GET /api/alerts/open-sessions?hours=10
router.get('/open-sessions', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const hours = parseFloat(req.query.hours || 10);
    const area  = req.query.area || null;
    const params = [hours];
    let areaWhere = '', leaderWhere = '';
    if (area) { params.push(area); areaWhere = `AND a.name ILIKE $${params.length}`; }
    if (req.user.role === 'leader') { params.push(req.user.id); leaderWhere = `AND u.leader_id = $${params.length}`; }

    const { rows } = await db.query(
      `SELECT u.employee_id, u.full_name, u.cargo, u.email,
              a.name AS area, s.name AS sede,
              l.full_name AS leader_name, l.email AS leader_email,
              e.marked_at AS entry_time,
              e.ip_address AS entry_ip, e.lat AS entry_lat, e.lon AS entry_lon,
              EXTRACT(EPOCH FROM (NOW() - e.marked_at))/3600 AS hours_open,
              sess.id AS session_id
       FROM attendance_sessions sess
       JOIN users u ON u.id = sess.user_id
       LEFT JOIN areas  a ON a.id = u.area_id
       LEFT JOIN sedes  s ON s.id = u.sede_id
       LEFT JOIN users  l ON l.id = u.leader_id
       LEFT JOIN attendances e ON e.id = sess.entry_id
       WHERE sess.exit_id IS NULL AND sess.entry_id IS NOT NULL
         AND DATE(sess.session_date) = CURRENT_DATE
         AND e.marked_at < NOW() - ($1 || ' hours')::INTERVAL
         AND u.status = 'active'
         AND (u.requires_attendance IS NULL OR u.requires_attendance = true)
         ${areaWhere} ${leaderWhere}
       ORDER BY hours_open DESC`, params
    );

    const enriched = rows.map(r => ({ ...r, hours_open: Math.round(r.hours_open * 10) / 10 }));
    res.json({ ok: true, threshold_hours: hours, records: enriched, total: enriched.length });
  } catch (err) {
    console.error('open-sessions alert error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al consultar jornadas abiertas.' });
  }
});

// POST /api/alerts/send-email
router.post('/send-email', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { hours = 10, area } = req.body;
    const alertsRes = await db.query(
      `SELECT u.employee_id, u.full_name, u.cargo, a.name AS area,
              l.full_name AS leader_name, l.email AS leader_email,
              e.marked_at AS entry_time,
              EXTRACT(EPOCH FROM (NOW() - e.marked_at))/3600 AS hours_open
       FROM attendance_sessions sess
       JOIN users u ON u.id = sess.user_id
       LEFT JOIN areas  a ON a.id = u.area_id
       LEFT JOIN users  l ON l.id = u.leader_id
       LEFT JOIN attendances e ON e.id = sess.entry_id
       WHERE sess.exit_id IS NULL AND sess.entry_id IS NOT NULL
         AND DATE(sess.session_date) = CURRENT_DATE
         AND e.marked_at < NOW() - ($1 || ' hours')::INTERVAL
         AND u.status = 'active'
         ${area ? "AND a.name ILIKE $2" : ""}
       ORDER BY a.name, l.full_name`,
      area ? [hours, area] : [hours]
    );

    if (!alertsRes.rows.length) {
      return res.json({ ok: true, message: 'No hay jornadas abiertas que superen el umbral.', sent: 0 });
    }

    const emailKey = process.env.SENDGRID_API_KEY || process.env.SMTP_KEY;
    if (!emailKey) {
      await db.query(
        `INSERT INTO audit_logs (actor_id,actor_name,actor_role,action,entity_type,payload_after)
         VALUES ($1,$2,$3,'ALERT_TRIGGERED','attendance',$4)`,
        [req.user.id, req.user.full_name, req.user.role,
         JSON.stringify({ type: 'open_sessions', threshold: hours, count: alertsRes.rows.length })]
      ).catch(() => {});
      return res.json({
        ok: true,
        message: alertsRes.rows.length + ' jornadas abiertas detectadas. Para enviar emails configura SENDGRID_API_KEY en Render.',
        records: alertsRes.rows.map(r => ({ employee: r.full_name, area: r.area, hours: Math.round(r.hours_open*10)/10 })),
        sent: 0
      });
    }

    res.json({ ok: true, message: 'Alertas procesadas.', sent: 0 });
  } catch (err) {
    console.error('send-email alert error:', err.message);
    res.status(500).json({ ok: false, message: 'Error enviando alertas.' });
  }
});

module.exports = router;
