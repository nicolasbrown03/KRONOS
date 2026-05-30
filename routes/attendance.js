const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calculateLateMinutes } = require('../utils/colombiaHolidays');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Ecosistemas con múltiples turnos por día
// SAC: hasta 2 ingresos, mínimo 1 hora entre turnos
// ─────────────────────────────────────────────────────────────
const MULTI_TURN_CONFIG = {
  'sac':         { maxTurns: 2, minHoursBetween: 1 },
  'noc':         { maxTurns: 2, minHoursBetween: 1 },
};
function getMultiTurnConfig(areaName) {
  return MULTI_TURN_CONFIG[(areaName || '').toLowerCase().trim()] || null;
}

// ─────────────────────────────────────────────────────────────
// Anti-duplicado en memoria (reemplaza Redis en free tier)
// Formato: Map<userId_type, timestamp>
// ─────────────────────────────────────────────────────────────
const recentMarks = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

function isDuplicate(userId, type) {
  const key = `${userId}_${type}`;
  const last = recentMarks.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentMarks.set(key, Date.now());
  return false;
}

// Limpiar el map cada hora
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentMarks) {
    if (now - ts > DEDUP_WINDOW_MS * 2) recentMarks.delete(key);
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function parseUserAgent(ua = '') {
  const lower = ua.toLowerCase();
  let device  = 'desktop';
  let browser = 'Desconocido';
  let os      = 'Desconocido';

  if (/mobile|android|iphone|ipad/.test(lower)) device = 'mobile';
  else if (/tablet/.test(lower)) device = 'tablet';

  if (lower.includes('chrome') && !lower.includes('edg'))  browser = 'Chrome';
  else if (lower.includes('firefox'))  browser = 'Firefox';
  else if (lower.includes('safari') && !lower.includes('chrome')) browser = 'Safari';
  else if (lower.includes('edg'))      browser = 'Edge';

  if (lower.includes('windows'))    os = 'Windows';
  else if (lower.includes('mac'))   os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('iphone') || lower.includes('ipad')) os = 'iOS';

  return { device, browser, os };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─────────────────────────────────────────────────────────────
// POST /api/attendance/mark
// Body: { type, lat, lon, geo_accuracy_m, ip_address, ip_data }
// ─────────────────────────────────────────────────────────────
router.post('/mark', requireAuth, async (req, res) => {
  try {
    const { type, lat, lon, geo_accuracy_m, ip_address, ip_data } = req.body;
    const userId = req.user.id;

    const VALID_TYPES = ['entry','exit','lunch_out','lunch_in','break_out','break_in',
                         'overtime_start','overtime_end','remote_in','remote_out'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, message: `Tipo de marcación inválido: ${type}` });
    }

    // Anti-duplicado
    if (isDuplicate(userId, type)) {
      return res.status(429).json({ ok: false, message: 'Marcación duplicada. Espera unos minutos.' });
    }

    // Obtener datos del usuario (turno, sede)
    const { rows: uRows } = await db.query(
      `SELECT u.*, a.name AS area_name, s.id AS s_id, s.name AS sede_name,
              s.lat AS s_lat, s.lon AS s_lon, s.radius_meters, s.geo_required,
              s.allowed_ips, sh.id AS sh_id, sh.name AS shift_name,
              sh.start_time, sh.end_time, sh.tolerance_in_min
       FROM users u
       LEFT JOIN areas  a ON a.id = u.area_id
       LEFT JOIN sedes  s ON s.id = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       WHERE u.id=$1`, [userId]
    );
    if (!uRows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    const user = uRows[0];

    const anomalyFlags = [];
    let geoIsValid = true;
    let geoDistanceM = null;

    // ── Validar geocerca ──
    if (lat && lon && user.s_lat && user.s_lon) {
      geoDistanceM = Math.round(distanceMeters(
        parseFloat(lat), parseFloat(lon),
        parseFloat(user.s_lat), parseFloat(user.s_lon)
      ));
      if (geoDistanceM > user.radius_meters) {
        geoIsValid = false;
        anomalyFlags.push(`outside_geofence_${geoDistanceM}m`);
        if (user.geo_required) {
          // Para equipos con geo obligatoria: bloquear
          const forceGeoAreas = ['soporte en sitio','ventas bog','accounting and treasury'];
          if (forceGeoAreas.includes((user.area_name||'').toLowerCase())) {
            recentMarks.delete(`${userId}_${type}`); // desbloquear para reintento
            return res.status(400).json({
              ok: false,
              message: `📍 Estás a ${geoDistanceM}m de la sede autorizada (máx ${user.radius_meters}m). Acércate a la sede para marcar.`
            });
          }
        }
      }
    } else if (user.geo_required && !lat) {
      anomalyFlags.push('no_gps');
    }

    // ── Validar IP ──
    const ipIsVpn   = ip_data?.is_vpn || ip_data?.proxy || false;
    const ipCountry = ip_data?.country_code || '';
    const ipCity    = ip_data?.city || '';
    const ipProvider= ip_data?.org || '';

    if (ipIsVpn) anomalyFlags.push('vpn_detected');
    if (ipCountry && ipCountry !== 'CO') anomalyFlags.push('ip_country_' + ipCountry);

    // ── Validar secuencia lógica ──
    const today = new Date().toISOString().substring(0, 10);
    const { rows: sessionRows } = await db.query(
      `SELECT s.*, e.marked_at AS entry_time, x.marked_at AS exit_time
       FROM attendance_sessions s
       LEFT JOIN attendances e ON e.id = s.entry_id
       LEFT JOIN attendances x ON x.id = s.exit_id
       WHERE s.user_id=$1 AND s.session_date=$2
       ORDER BY s.turn_number`,
      [userId, today]
    );

    const multiCfg = getMultiTurnConfig(user.area_name);
    const openSession = sessionRows.find(s => s.entry_id && !s.exit_id);
    const lastClosedSession = sessionRows.filter(s => s.entry_id && s.exit_id).pop();
    const nextTurn = (sessionRows.length > 0 ? Math.max(...sessionRows.map(s => s.turn_number)) : 0) + 1;

    if (type === 'exit' && !openSession) {
      recentMarks.delete(`${userId}_${type}`);
      return res.status(400).json({ ok: false, message: '⚠️ No puedes registrar salida sin haber marcado entrada hoy.' });
    }

    if (type === 'entry') {
      if (openSession) {
        recentMarks.delete(`${userId}_${type}`);
        return res.status(400).json({ ok: false, message: '⚠️ Ya tienes una entrada sin salida. Marca salida primero.' });
      }

      // Segundo turno: verificar si el ecosistema lo permite
      if (lastClosedSession) {
        if (!multiCfg) {
          recentMarks.delete(`${userId}_${type}`);
          return res.status(400).json({ ok: false, message: '⚠️ La jornada de hoy ya está cerrada. No puedes volver a marcar entrada.' });
        }
        if (nextTurn > multiCfg.maxTurns) {
          recentMarks.delete(`${userId}_${type}`);
          return res.status(400).json({ ok: false, message: `⚠️ Has alcanzado el máximo de ${multiCfg.maxTurns} turnos para hoy.` });
        }
        // Verificar tiempo mínimo entre turnos
        if (lastClosedSession.exit_time) {
          const horasSalida = (Date.now() - new Date(lastClosedSession.exit_time).getTime()) / 3600000;
          if (horasSalida < multiCfg.minHoursBetween) {
            const minutosRestantes = Math.ceil((multiCfg.minHoursBetween - horasSalida) * 60);
            recentMarks.delete(`${userId}_${type}`);
            return res.status(400).json({ ok: false, message: `⚠️ Intervalo entre turnos insuficiente. Espera ${minutosRestantes} minutos más.` });
          }
        }
      }
    }

    // ── Insertar marcación ──
    const { device, browser, os } = parseUserAgent(req.headers['user-agent']);
    const { rows: attRows } = await db.query(
      `INSERT INTO attendances (
         user_id, type, ip_address, ip_country, ip_city, ip_is_vpn, ip_provider,
         lat, lon, geo_accuracy_m, geo_is_valid, geo_distance_m,
         device_type, browser, os, user_agent,
         sede_id, shift_id, source, status, anomaly_flags
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'web',$19,$20)
       RETURNING id, marked_at`,
      [
        userId, type,
        ip_address || req.ip, ipCountry, ipCity, ipIsVpn, ipProvider,
        lat || null, lon || null, geo_accuracy_m || null,
        geoIsValid, geoDistanceM,
        device, browser, os, req.headers['user-agent'],
        user.s_id || null, user.sh_id || null,
        anomalyFlags.length ? 'suspicious' : 'valid',
        JSON.stringify(anomalyFlags)
      ]
    );
    const att = attRows[0];

    // ── Actualizar o crear sesión del día ──
    const sessionDate = att.marked_at.toISOString().substring(0, 10);
    await updateSession(userId, sessionDate, att.id, type, user, nextTurn);

    // ── Calcular tardanza si es entrada ──
    let lateMsg = '';
    if (type === 'entry' && user.start_time) {
      const lateMin = calculateLateMinutes(att.marked_at, user.start_time, user.tolerance_in_min || 5);
      if (lateMin > 0) {
        lateMsg = ` ⚠️ Llegaste ${lateMin} min tarde.`;
        await db.query(
          `UPDATE attendance_sessions SET late_minutes=$1 WHERE user_id=$2 AND session_date=$3`,
          [lateMin, userId, sessionDate]
        );
      }
    }

    // ── Audit log ──
    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, payload_after, ip_address, user_agent)
       VALUES ($1,$2,$3,'ATTENDANCE_CREATED','attendance',$4,$5,$6,$7)`,
      [userId, req.user.full_name, req.user.role, att.id,
       JSON.stringify({ type, anomaly_flags: anomalyFlags }),
       ip_address || req.ip, req.headers['user-agent']]
    ).catch(() => {});

    const hora = att.marked_at.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
    });

    const typeLabels = {
      entry: 'Entrada', exit: 'Salida', lunch_out: 'Inicio almuerzo',
      lunch_in: 'Fin almuerzo', break_out: 'Inicio pausa', break_in: 'Fin pausa',
      overtime_start: 'Inicio hora extra', overtime_end: 'Fin hora extra',
      remote_in: 'Inicio remoto', remote_out: 'Fin remoto'
    };

    const alertMsg = anomalyFlags.length
      ? `\n⚠️ Marcación registrada con alertas: ${anomalyFlags.join(', ')}`
      : '';

    res.json({
      ok: true,
      message: `✅ ${typeLabels[type] || type} registrada a las ${hora}.${lateMsg}${alertMsg}`,
      attendance_id: att.id,
      marked_at: att.marked_at,
      anomaly_flags: anomalyFlags,
    });

  } catch (err) {
    console.error('Mark error:', err.message);
    res.status(500).json({ ok: false, message: 'Error interno al registrar marcación.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Actualizar attendance_session (soporta múltiples turnos)
// ─────────────────────────────────────────────────────────────
async function updateSession(userId, sessionDate, attId, type, user, nextTurn = 1) {
  const colMap = {
    entry: 'entry_id', exit: 'exit_id',
    lunch_out: 'lunch_out_id', lunch_in: 'lunch_in_id'
  };
  const col = colMap[type];

  // Buscar la sesión abierta del turno actual (sin exit)
  const openQ = await db.query(
    `SELECT id, turn_number FROM attendance_sessions
     WHERE user_id=$1 AND session_date=$2 AND exit_id IS NULL
     ORDER BY turn_number DESC LIMIT 1`,
    [userId, sessionDate]
  );
  const openSess = openQ.rows[0];

  if (type === 'entry') {
    // Crear nueva sesión para este turno
    const turn = openSe