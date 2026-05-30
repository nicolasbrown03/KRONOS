const express = require('express');
const db      = require('../db');
const XLSX    = require('xlsx');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateHoursBreakdown, isHoliday, isSunday } = require('../utils/colombiaHolidays');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/reports/daily?date=YYYY-MM-DD&area=Instalaciones
// Asistencia del día completo — reporte operativo
// ─────────────────────────────────────────────────────────────
router.get('/daily', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const date   = req.query.date || new Date().toISOString().substring(0, 10);
    const area   = req.query.area || null;
    const params = [date];
    let areaWhere = '';

    if (area) { params.push(area); areaWhere = `AND a.name ILIKE $${params.length}`; }
    // Líderes solo ven su equipo
    let leaderWhere = '';
    if (req.user.role === 'leader') {
      params.push(req.user.id);
      leaderWhere = `AND u.leader_id = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT u.employee_id, u.full_name, u.cargo, a.name AS area, s.name AS sede,
              sh.start_time AS shift_start,
              e.marked_at  AS entry_time,
              x.marked_at  AS exit_time,
              sess.late_minutes,
              sess.total_hours,
              sess.overtime_hours,
              sess.status  AS session_status,
              e.geo_is_valid, e.anomaly_flags,
              l.full_name  AS leader_name
       FROM users u
       LEFT JOIN areas  a  ON a.id  = u.area_id
       LEFT JOIN sedes  s  ON s.id  = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       LEFT JOIN users  l  ON l.id  = u.leader_id
       LEFT JOIN attendance_sessions sess ON sess.user_id=u.id AND sess.session_date=$1
       LEFT JOIN attendances e ON e.id = sess.entry_id
       LEFT JOIN attendances x ON x.id = sess.exit_id
       WHERE u.status='active' ${areaWhere} ${leaderWhere}
       ORDER BY a.name, u.full_name`,
      params
    );

    // Resumen estadístico
    const total      = rows.length;
    const present    = rows.filter(r => r.entry_time).length;
    const absent     = total - present;
    const late       = rows.filter(r => r.late_minutes > 0).length;
    const inSession  = rows.filter(r => r.entry_time && !r.exit_time).length;
    const anomalies  = rows.filter(r => r.anomaly_flags?.length > 0).length;

    res.json({
      ok: true, date,
      summary: { total, present, absent, late, in_session: inSession, anomalies },
      records: rows
    });
  } catch (err) {
    console.error('daily report error:', err.message);
    res.status(500).json({ ok: false, message: 'Error generando reporte.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/range?start=YYYY-MM-DD&end=YYYY-MM-DD&area=X&employee_id=Y
// Reporte por rango de fechas — para nómina y seguimiento
// Incluye cálculo de horas extras, recargos y festivos Colombia
// ─────────────────────────────────────────────────────────────
router.get('/range', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const { start, end, area, employee_id, format } = req.query;
    if (!start || !end) {
      return res.status(400).json({ ok: false, message: 'start y end son requeridos (YYYY-MM-DD).' });
    }
    if (start > end) {
      return res.status(400).json({ ok: false, message: 'start debe ser anterior a end.' });
    }

    const params = [start, end];
    const conditions = [];

    if (area)        { params.push(area);        conditions.push(`a.name ILIKE $${params.length}`); }
    if (employee_id) { params.push(employee_id); conditions.push(`u.employee_id = $${params.length}`); }
    if (req.user.role === 'leader') {
      params.push(req.user.id);
      conditions.push(`u.leader_id = $${params.length}`);
    }

    const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(
      `SELECT u.employee_id, u.full_name, u.cargo, a.name AS area, s.name AS sede,
              sh.start_time AS shift_start, sh.end_time AS shift_end,
              sess.session_date,
              e.marked_at AS entry_time, x.marked_at AS exit_time,
              lo.marked_at AS lunch_out, li.marked_at AS lunch_in,
              sess.late_minutes, sess.total_hours, sess.overtime_hours,
              sess.status AS session_status,
              e.anomaly_flags, u.leader_id
       FROM attendance_sessions sess
       JOIN users u ON u.id = sess.user_id
       LEFT JOIN areas  a  ON a.id  = u.area_id
       LEFT JOIN sedes  s  ON s.id  = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       LEFT JOIN attendances e  ON e.id  = sess.entry_id
       LEFT JOIN attendances x  ON x.id  = sess.exit_id
       LEFT JOIN attendances lo ON lo.id = sess.lunch_out_id
       LEFT JOIN attendances li ON li.id = sess.lunch_in_id
       WHERE sess.session_date BETWEEN $1 AND $2 ${where}
       ORDER BY u.full_name, sess.session_date`,
      params
    );

    // Enriquecer con cálculo de horas extras y recargos por día
    const enriched = rows.map(row => {
      let breakdown = null;
      if (row.entry_time && row.exit_time) {
        const lunchMin = (row.lunch_out && row.lunch_in)
          ? Math.round((new Date(row.lunch_in) - new Date(row.lunch_out)) / 60000)
          : 0;
        breakdown = calculateHoursBreakdown(new Date(row.entry_time), new Date(row.exit_time), lunchMin);
      }
      return {
        ...row,
        is_holiday: isHoliday(row.session_date),
        is_sunday:  isSunday(row.session_date),
        breakdown
      };
    });

    // Consolidado por colaborador
    const byEmployee = {};
    enriched.forEach(r => {
      const k = r.employee_id;
      if (!byEmployee[k]) {
        byEmployee[k] = {
          employee_id: r.employee_id, full_name: r.full_name,
          cargo: r.cargo, area: r.area, sede: r.sede,
          days_worked: 0, scheduled_days: 0,
          total_worked_hours: 0, late_minutes_total: 0,
          absences: 0, incomplete_days: 0,
          overtime_hed: 0, overtime_hen: 0, overtime_hedf: 0, overtime_hendf: 0,
          recargo_nocturno: 0, recargo_dominical: 0, recargo_festivo: 0,
          days: []
        };
      }
      const emp = byEmployee[k];
      emp.days.push(r);

      if (r.entry_time) {
        emp.days_worked++;
        emp.late_minutes_total += (r.late_minutes || 0);
        emp.total_worked_hours += (r.total_hours || 0);
        if (r.session_status === 'incomplete') emp.incomplete_days++;
      } else {
        emp.absences++;
      }

      if (r.breakdown) {
        emp.overtime_hed    += r.breakdown.overtime_hed    || 0;
        emp.overtime_hen    += r.breakdown.overtime_hen    || 0;
        emp.overtime_hedf   += r.breakdown.overtime_hedf   || 0;
        emp.overtime_hendf  += r.breakdown.overtime_hendf  || 0;
        emp.recargo_nocturno   += r.breakdown.recargo_nocturno   || 0;
        emp.recargo_dominical  += r.breakdown.recargo_dominical  || 0;
        emp.recargo_festivo    += r.breakdown.recargo_festivo    || 0;
      }
    });

    // Redondear
    Object.values(byEmployee).forEach(emp => {
      ['total_worked_hours','overtime_hed','overtime_hen','overtime_hedf','overtime_hendf',
       'recargo_nocturno','recargo_dominical','recargo_festivo'].forEach(k => {
        emp[k] = Math.round(emp[k] * 100) / 100;
      });
    });

    const summary = Object.values(byEmployee);

    // Si piden Excel: generar y devolver
    if (format === 'xlsx') {
      return sendExcelReport(res, summary, enriched, start, end);
    }

    res.json({ ok: true, start, end, records: enriched, summary, total_employees: summary.length });

  } catch (err) {
    console.error('range report error:', err.message);
    res.status(500).json({ ok: false, message: 'Error generando reporte.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/employee/:employee_id?start=&end=
// Historial detallado de un colaborador
// ─────────────────────────────────────────────────────────────
router.get('/employee/:employee_id', requireAuth, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const start = req.query.start || new Date(new Date().setDate(1)).toISOString().substring(0,10);
    const end   = req.query.end   || new Date().toISOString().substring(0,10);

    // Empleados solo pueden ver su propio historial
    if (req.user.role === 'employee' && req.user.employee_id !== employee_id) {
      return res.status(403).json({ ok: false, message: 'Solo puedes ver tu propio historial.' });
    }

    const { rows } = await db.query(
      `SELECT sess.session_date,
              e.marked_at AS entry_time,  e.ip_address AS entry_ip,
              e.lat AS entry_lat, e.lon AS entry_lon, e.geo_is_valid, e.anomaly_flags,
              x.marked_at AS exit_time,
              lo.marked_at AS lunch_out, li.marked_at AS lunch_in,
              sess.late_minutes, sess.total_hours, sess.status AS session_status,
              sh.start_time AS shift_start, sh.end_time AS shift_end
       FROM attendance_sessions sess
       JOIN users u ON u.id = sess.user_id AND u.employee_id=$1
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       LEFT JOIN attendances e  ON e.id  = sess.entry_id
       LEFT JOIN attendances x  ON x.id  = sess.exit_id
       LEFT JOIN attendances lo ON lo.id = sess.lunch_out_id
       LEFT JOIN attendances li ON li.id = sess.lunch_in_id
       WHERE sess.session_date BETWEEN $2 AND $3
       ORDER BY sess.session_date DESC`,
      [employee_id, start, end]
    );

    // Totales del período
    const totals = rows.reduce((acc, r) => {
      acc.days_worked     += r.entry_time ? 1 : 0;
      acc.absences        += !r.entry_time ? 1 : 0;
      acc.late_minutes    += r.late_minutes || 0;
      acc.total_hours     += r.total_hours  || 0;
      return acc;
    }, { days_worked: 0, absences: 0, late_minutes: 0, total_hours: 0 });
    totals.total_hours = Math.round(totals.total_hours * 100) / 100;

    res.json({ ok: true, employee_id, start, end, records: rows, totals });

  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/payroll?start=&end=  — Reporte 15→15
// ─────────────────────────────────────────────────────────────
router.get('/payroll', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { start, end, area, format } = req.query;
  req.query.format = format;
  // Reutiliza /range con formato nómina
  return res.redirect(`/api/reports/range?start=${start}&end=${end}&area=${area||''}&format=${format||'json'}`);
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/anomalies?start=&end=
// Marcaciones sospechosas (VPN, fuera de geocerca, etc.)
// ─────────────────────────────────────────────────────────────
router.get('/anomalies', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const start = req.query.start || new Date().toISOString().substring(0,10);
    const end   = req.query.end   || new Date().toISOString().substring(0,10);

    const { rows } = await db.query(
      `SELECT a.id, a.type, a.marked_at, a.anomaly_flags,
              a.ip_address, a.ip_is_vpn, a.ip_country, a.ip_city,
              a.lat, a.lon, a.geo_distance_m, a.geo_is_valid,
              u.employee_id, u.full_name, u.cargo, ar.name AS area
       FROM attendances a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN areas ar ON ar.id = u.area_id
       WHERE a.status = 'suspicious'
         AND DATE(a.marked_at AT TIME ZONE 'America/Bogota') BETWEEN $1 AND $2
       ORDER BY a.marked_at DESC`,
      [start, end]
    );
    res.json({ ok: true, start, end, records: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Generar Excel para nómina
// ─────────────────────────────────────────────────────────────
function sendExcelReport(res, summary, detail, start, end) {
  const wb = XLSX.utils.book_new();

  // Hoja 1: Resumen por colaborador
  const summaryData = summary.map(e => ({
    'Cédula':           e.employee_id,
    'Nombre':           e.full_name,
    'Cargo':            e.cargo,
    'Área':             e.area,
    'Días trabajados':  e.days_worked,
    'Ausencias':        e.absences,
    'Horas trabajadas': e.total_worked_hours,
    'Tardanzas (min)':  e.late_minutes_total,
    'HED (+25%)':       e.overtime_hed,
    'HEN (+75%)':       e.overtime_hen,
    'HEDF (+100%)':     e.overtime_hedf,
    'HENDF (+150%)':    e.overtime_hendf,
    'Rec. Nocturno (35%)':   e.recargo_nocturno,
    'Rec. Dominical (75%)':  e.recargo_dominical,
    'Rec. Festivo (75%)':    e.recargo_festivo,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), 'Resumen Nómina');

  // Hoja 2: Detalle diario
  const detailData = detail.map(r => ({
    'Cédula':     r.employee_id,
    'Nombre':     r.full_name,
    'Área':       r.area,
    'Fecha':      r.session_date,
    'Festivo':    r.is_holiday ? 'SÍ' : 'No',
    'Domingo':    r.is_sunday  ? 'SÍ' : 'No',
    'Entrada':    r.entry_time ? new Date(r.entry_time).toLocaleTimeString('es-CO',{timeZone:'America/Bogota'}) : '',
    'Salida':     r.exit_time  ? new Date(r.exit_time).toLocaleTimeString('es-CO',{timeZone:'America/Bogota'}) : '',
    'Horas':      r.total_hours || 0,
    'Tardanza':   r.late_minutes || 0,
    'Estado':     r.session_status,
    'Alertas':    (r.anomaly_flags||[]).join(', '),
    'HED':        r.breakdown?.overtime_hed   || 0,
    'HEN':        r.breakdown?.overtime_hen   || 0,
    'HEDF':       r.breakdown?.overtime_hedf  || 0,
    'HENDF':      r.breakdown?.overtime_hendf || 0,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailData), 'Detalle Diario');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="KRONOS_Reporte_${start}_${end}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

module.exports = router;
