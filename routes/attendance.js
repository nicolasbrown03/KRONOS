const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calculateLateMinutes } = require('../utils/colombiaHolidays');

const router = express.Router();

// Ecosistemas con multiples turnos por dia
const MULTI_TURN_CONFIG = {
  'sac': { maxTurns: 2, minHoursBetween: 1 },
  'noc': { maxTurns: 2, minHoursBetween: 1 },
};
function getMultiTurnConfig(areaName) {
  return MULTI_TURN_CONFIG[(areaName || '').toLowerCase().trim()] || null;
}

// Anti-duplicado en memoria
const recentMarks = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function isDuplicate(userId, type) {
  const key = `${userId}_${type}`;
  const last = recentMarks.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentMarks.set(key, Date.now());
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentMarks) {
    if (now - ts > DEDUP_WINDOW_MS * 2) recentMarks.delete(key);
  }
}, 60 * 60 * 1000);

function parseUserAgent(ua) {
  ua = ua || '';
  const lower = ua.toLowerCase();
  let device = 'desktop', browser = 'Desconocido', os = 'Desconocido';
  if (/mobile|android|iphone|ipad/.test(lower)) device = 'mobile';
  else if (/tablet/.test(lower)) device = 'tablet';
  if (lower.includes('chrome') && !lower.includes('edg')) browser = 'Chrome';
  else if (lower.includes('firefox')) browser = 'Firefox';
  else if (lower.includes('safari') && !lower.includes('chrome')) browser = 'Safari';
  else if (lower.includes('edg')) browser = 'Edge';
  if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac')) os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('iphone') || lower.includes('ipad')) os = 'iOS';
  return { device, browser, os };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// POST /api/attendance/mark
router.post('/mark', requireAuth, async (req, res) => {
  try {
    const { type, lat, lon, geo_accuracy_m, ip_address, ip_data } = req.body;
    const userId = req.user.id;

    const VALID_TYPES = ['entry','exit','lunch_out','lunch_in','break_out','break_in',
                         'overtime_start','overtime_end','remote_in','remote_out'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, message: 'Tipo invalido: ' + type });
    }
    if (isDuplicate(userId, type)) {
      return res.status(429).json({ ok: false, message: 'Marcacion duplicada. Espera unos minutos.' });
    }

    const { rows: uRows } = await db.query(
      `SELECT u.*, a.name AS area_name, s.id AS s_id, s.name AS sede_name,
              s.lat AS s_lat, s.lon AS s_lon, s.radius_meters, s.geo_required,
              sh.id AS sh_id, sh.start_time, sh.end_time, sh.tolerance_in_min
       FROM users u
       LEFT JOIN areas  a ON a.id = u.area_id
       LEFT JOIN sedes  s ON s.id = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       WHERE u.id=$1`, [userId]
    );
    if (!uRows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    const user = uRows[0];

    const anomalyFlags = [];
    let geoIsValid = true, geoDistanceM = null;

    if (lat && lon && user.s_lat && user.s_lon) {
      geoDistanceM = Math.round(distanceMeters(parseFloat(lat), parseFloat(lon), parseFloat(user.s_lat), parseFloat(user.s_lon)));
      if (geoDistanceM > user.radius_meters) {
        geoIsValid = false;
        anomalyFlags.push('outside_geofence_' + geoDistanceM + 'm');
        if (user.geo_required) {
          const forceGeo = ['soporte en sitio','ventas bog','accounting and treasury'];
          if (forceGeo.includes((user.area_name||'').toLowerCase())) {
            recentMarks.delete(userId + '_' + type);
            return res.status(400).json({ ok: false, message: 'Estas a ' + geoDistanceM + 'm de la sede. Acercate para marcar.' });
          }
        }
      }
    } else if (user.geo_required && !lat) {
      anomalyFlags.push('no_gps');
    }

    const ipIsVpn    = ip_data && (ip_data.is_vpn || ip_data.proxy) ? true : false;
    const ipCountry  = (ip_data && ip_data.country_code) || '';
    const ipCity     = (ip_data && ip_data.city) || '';
    const ipProvider = (ip_data && ip_data.org) || '';
    if (ipIsVpn) anomalyFlags.push('vpn_detected');
    if (ipCountry && ipCountry !== 'CO') anomalyFlags.push('ip_country_' + ipCountry);

    // Sesiones del dia
    const today = new Date().toISOString().substring(0, 10);
    const { rows: sessionRows } = await db.query(
      `SELECT s.*, e.marked_at AS entry_time, x.marked_at AS exit_time
       FROM attendance_sessions s
       LEFT JOIN attendances e ON e.id = s.entry_id
       LEFT JOIN attendances x ON x.id = s.exit_id
       WHERE s.user_id=$1 AND s.session_date=$2 ORDER BY s.turn_number`,
      [userId, today]
    );

    const multiCfg = getMultiTurnConfig(user.area_name);
    const openSession = sessionRows.find(s => s.entry_id && !s.exit_id) || null;
    const closedSessions = sessionRows.filter(s => s.entry_id && s.exit_id);
    const lastClosed = closedSessions[closedSessions.length - 1] || null;
    const currentMaxTurn = sessionRows.length > 0 ? Math.max.apply(null, sessionRows.map(s => s.turn_number || 1)) : 0;
    const nextTurn = currentMaxTurn + 1;

    if (type === 'exit' && !openSession) {
      recentMarks.delete(userId + '_' + type);
      return res.status(400).json({ ok: false, message: 'No puedes registrar salida sin entrada hoy.' });
    }

    if (type === 'entry') {
      if (openSession) {
        recentMarks.delete(userId + '_' + type);
        return res.status(400).json({ ok: false, message: 'Ya tienes entrada sin salida. Marca salida primero.' });
      }
      if (lastClosed) {
        if (!multiCfg) {
          recentMarks.delete(userId + '_' + type);
          return res.status(400).json({ ok: false, message: 'La jornada de hoy ya esta cerrada.' });
        }
        if (nextTurn > multiCfg.maxTurns) {
          recentMarks.delete(userId + '_' + type);
          return res.status(400).json({ ok: false, message: 'Has alcanzado el maximo de ' + multiCfg.maxTurns + ' turnos para hoy.' });
        }
        if (lastClosed.exit_time) {
          const horasSalida = (Date.now() - new Date(lastClosed.exit_time).getTime()) / 3600000;
          if (horasSalida < multiCfg.minHoursBetween) {
            const min = Math.ceil((multiCfg.minHoursBetween - horasSalida) * 60);
            recentMarks.delete(userId + '_' + type);
            return res.status(400).json({ ok: false, message: 'Intervalo insuficiente entre turnos. Espera ' + min + ' minutos.' });
          }
        }
      }
    }

    const { device, browser, os } = parseUserAgent(req.headers['user-agent']);
    const { rows: attRows } = await db.query(
      `INSERT INTO attendances (user_id,type,ip_address,ip_country,ip_city,ip_is_vpn,ip_provider,
         lat,lon,geo_accuracy_m,geo_is_valid,geo_distance_m,device_type,browser,os,user_agent,
         sede_id,shift_id,source,status,anomaly_flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'web',$19,$20)
       RETURNING id, marked_at`,
      [userId, type, ip_address||req.ip, ipCountry, ipCity, ipIsVpn, ipProvider,
       lat||null, lon||null, geo_accuracy_m||null, geoIsValid, geoDistanceM,
       device, browser, os, req.headers['user-agent'],
       user.s_id||null, user.sh_id||null,
       anomalyFlags.length ? 'suspicious' : 'valid', JSON.stringify(anomalyFlags)]
    );
    const att = attRows[0];
    const sessionDate = att.marked_at.toISOString().substring(0, 10);
    await updateSession(userId, sessionDate, att.id, type, user, nextTurn, openSession);

    let lateMsg = '';
    if (type === 'entry' && user.start_time && nextTurn === 1) {
      const lateMin = calculateLateMinutes(att.marked_at, user.start_time, user.tolerance_in_min || 5);
      if (lateMin > 0) {
        lateMsg = ' Llegaste ' + lateMin + ' min tarde.';
        await db.query(
          `UPDATE attendance_sessions SET late_minutes=$1 WHERE user_id=$2 AND session_date=$3 AND turn_number=1`,
          [lateMin, userId, sessionDate]
        );
      }
    }

    await db.query(
      `INSERT INTO audit_logs (actor_id,actor_name,actor_role,action,entity_type,entity_id,payload_after,ip_address,user_agent)
       VALUES ($1,$2,$3,'ATTENDANCE_CREATED','attendance',$4,$5,$6,$7)`,
      [userId, req.user.full_name, req.user.role, att.id,
       JSON.stringify({type, anomaly_flags: anomalyFlags}), ip_address||req.ip, req.headers['user-agent']]
    ).catch(() => {});

    const hora = att.marked_at.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit', timeZone:'America/Bogota'});
    const labels = {entry:'Entrada',exit:'Salida',lunch_out:'Inicio almuerzo',lunch_in:'Fin almuerzo',
                    break_out:'Inicio pausa',break_in:'Fin pausa',
                    overtime_start:'Inicio hora extra',overtime_end:'Fin hora extra',
                    remote_in:'Inicio remoto',remote_out:'Fin remoto'};
    const turnMsg = (multiCfg && nextTurn > 1) ? ' (Turno ' + nextTurn + ')' : '';
    const alertMsg = anomalyFlags.length ? ' Alertas: ' + anomalyFlags.join(', ') : '';

    res.json({
      ok: true,
      message: (labels[type]||type) + ' registrada a las ' + hora + '.' + turnMsg + lateMsg + alertMsg,
      attendance_id: att.id,
      marked_at: att.marked_at,
      anomaly_flags: anomalyFlags
    });

  } catch (err) {
    console.error('Mark error:', err.message);
    res.status(500).json({ ok: false, message: 'Error interno al registrar marcacion.' });
  }
});

async function updateSession(userId, sessionDate, attId, type, user, nextTurn, openSession) {
  const colMap = { entry:'entry_id', exit:'exit_id', lunch_out:'lunch_out_id', lunch_in:'lunch_in_id' };
  const col = colMap[type];
  if (type === 'entry') {
    await db.query(
      `INSERT INTO attendance_sessions (user_id,session_date,shift_id,entry_id,status,turn_number)
       VALUES ($1,$2,$3,$4,'open',$5)`,
      [userId, sessionDate, user.sh_id||null, attId, nextTurn||1]
    );
  } else if (col && openSession) {
    const status = (type === 'exit') ? 'closed' : 'open';
    await db.query(`UPDATE attendance_sessions SET ${col}=$1, status=$2, updated_at=NOW() WHERE id=$3`, [attId, status, openSession.id]);
  } else if (col) {
    await db.query(
      `INSERT INTO attendance_sessions (user_id,session_date,shift_id,${col},status,turn_number) VALUES ($1,$2,$3,$4,'open',1) ON CONFLICT DO NOTHING`,
      [userId, sessionDate, user.sh_id||null, attId]
    );
  }
}

// GET /api/attendance/today
router.get('/today', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().substring(0, 10);
    const { rows } = await db.query(
      `SELECT s.*, e.marked_at AS entry_time, e.anomaly_flags AS entry_flags,
              x.marked_at AS exit_time, lo.marked_at AS lunch_out_time, li.marked_at AS lunch_in_time
       FROM attendance_sessions s
       LEFT JOIN attendances e  ON e.id = s.entry_id
       LEFT JOIN attendances x  ON x.id = s.exit_id
       LEFT JOIN attendances lo ON lo.id = s.lunch_out_id
       LEFT JOIN attendances li ON li.id = s.lunch_in_id
       WHERE s.user_id=$1 AND s.session_date=$2 ORDER BY s.turn_number`,
      [req.user.id, today]
    );
    const open = rows.find(r => r.entry_time && !r.exit_time);
    const session = open || rows[rows.length - 1] || null;
    res.json({ ok: true, session, all_sessions: rows, date: today });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// GET /api/attendance/history?days=30
router.get('/history', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || 30), 90);
    const { rows } = await db.query(
      `SELECT s.session_date, s.status, s.total_hours, s.overtime_hours, s.late_minutes, s.turn_number,
              e.marked_at AS entry_time, x.marked_at AS exit_time
       FROM attendance_sessions s
       LEFT JOIN attendances e ON e.id = s.entry_id
       LEFT JOIN attendances x ON x.id = s.exit_id
       WHERE s.user_id=$1 AND s.session_date >= NOW() - INTERVAL '${days} days'
       ORDER BY s.session_date DESC, s.turn_number`,
      [req.user.id]
    );
    res.json({ ok: true, records: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

module.exports = router;
