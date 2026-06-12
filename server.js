require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const db          = require('./db');
const bcrypt      = require('bcryptjs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// Middlewares globales
// ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { ok: false, message: 'Demasiados intentos. Espera 15 minutos.' }
}));
app.use('/api/public/mark', rateLimit({
  windowMs: 60 * 1000, max: 15,
  message: { ok: false, message: 'Demasiadas marcaciones. Espera un momento.' }
}));

// ─────────────────────────────────────────────────────────────
// RUTAS PÚBLICAS — sin autenticación (empleados marcando)
// ─────────────────────────────────────────────────────────────

// GET /api/public/areas — lista de ecosistemas activos (filtra nombres de personas)
const VALID_ECOSYSTEMS = [
  'accounting and treasury','cedi','instalaciones','noc','relevamiento',
  'sac','soporte en sitio','soporte n2','ventas','ventas bog','tecnología',
  'tecnologia','rrhh','sistemas','gerencia','juridico','juridica'
];
function isValidEcosystem(name) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  // Es válido si está en la lista conocida
  if (VALID_ECOSYSTEMS.includes(lower)) return true;
  // O si tiene 3 palabras o menos Y menos de 30 caracteres (no es nombre de persona)
  const words = name.trim().split(/\s+/);
  return words.length <= 3 && name.length <= 30;
}
app.get('/api/public/areas', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name FROM areas ORDER BY name');
    const areas = rows.filter(r => isValidEcosystem(r.name));
    res.json({ ok: true, areas });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al obtener áreas.' });
  }
});

// GET /api/public/area-lunch/:name — config de almuerzo del ecosistema
app.get('/api/public/area-lunch/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { rows } = await db.query(
      `SELECT s.manual_lunch, s.lunch_minutes
       FROM areas a
       LEFT JOIN area_settings s ON s.area_id = a.id
       WHERE LOWER(a.name) = LOWER($1) LIMIT 1`,
      [name]
    );
    const cfg = rows[0] || {};
    res.json({ ok: true, manual_lunch: cfg.manual_lunch || false, lunch_minutes: cfg.lunch_minutes || 60 });
  } catch (err) {
    res.json({ ok: true, manual_lunch: false, lunch_minutes: 60 });
  }
});

// GET /api/public/employee/:id — busca colaborador por cédula
app.get('/api/public/employee/:id', async (req, res) => {
  try {
    const employeeId = decodeURIComponent(req.params.id).trim();
    const ecosystem  = req.query.ecosystem ? decodeURIComponent(req.query.ecosystem).trim() : null;

    const { rows } = await db.query(
      `SELECT id, employee_id, full_name, cargo, area, status
       FROM users WHERE employee_id = $1 LIMIT 1`,
      [employeeId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Colaborador no encontrado. Verifica la cédula.' });
    }

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, message: 'Usuario inactivo. Contacta al administrador.' });
    }

    res.json({ ok: true, employee: user });
  } catch (err) {
    console.error('public/employee error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al buscar colaborador.' });
  }
});

// POST /api/public/mark — registrar marcación (sin contraseña)
app.post('/api/public/mark', async (req, res) => {
  try {
    const { employee_id, ecosystem, type, lat, lon, geo_accuracy_m, ip_address, ip_data, maps_link } = req.body;

    if (!employee_id || !type) {
      return res.status(400).json({ ok: false, message: 'employee_id y type son requeridos.' });
    }

    const VALID_TYPES = ['entry','exit','lunch_out','lunch_in'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, message: `Tipo de marcación inválido: ${type}` });
    }

    // Buscar usuario
    const { rows: userRows } = await db.query(
      'SELECT id, full_name, area, status FROM users WHERE employee_id = $1 LIMIT 1',
      [employee_id.trim()]
    );
    if (!userRows.length) return res.status(404).json({ ok: false, message: 'Colaborador no encontrado.' });
    const user = userRows[0];
    if (user.status !== 'active') return res.status(403).json({ ok: false, message: 'Usuario inactivo.' });

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Obtener config multi-turno del ecosistema
    let maxTurns = 1;
    let minHoursBetween = 1;
    try {
      const { rows: cfgRows } = await db.query(
        `SELECT s.max_turns, s.min_hours_between
         FROM areas a
         LEFT JOIN area_settings s ON s.area_id = a.id
         WHERE LOWER(a.name) = LOWER($1) LIMIT 1`,
        [ecosystem || user.area || '']
      );
      if (cfgRows[0]) {
        maxTurns = cfgRows[0].max_turns || 1;
        minHoursBetween = parseFloat(cfgRows[0].min_hours_between) || 1;
      }
    } catch (e) { /* usa defaults */ }

    if (type === 'entry') {
      // Verificar si hay sesión abierta hoy
      const { rows: openSessions } = await db.query(
        `SELECT id, turn_number FROM attendance_sessions
         WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2
           AND check_out IS NULL
         ORDER BY turn_number DESC LIMIT 1`,
        [user.id, todayStr]
      );
      if (openSessions.length) {
        return res.status(400).json({ ok: false, message: 'Ya tienes una entrada activa. Marca Salida primero.' });
      }

      // Contar turnos del día
      const { rows: todayTurns } = await db.query(
        `SELECT COUNT(*) as cnt FROM attendance_sessions
         WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2`,
        [user.id, todayStr]
      );
      const turnsDone = parseInt(todayTurns[0].cnt) || 0;
      if (turnsDone >= maxTurns) {
        return res.status(400).json({ ok: false, message: `Ya completaste el máximo de ${maxTurns} turno(s) hoy.` });
      }

      // Verificar intervalo mínimo entre turnos
      if (turnsDone > 0 && minHoursBetween > 0) {
        const { rows: lastOut } = await db.query(
          `SELECT check_out FROM attendance_sessions
           WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2
             AND check_out IS NOT NULL
           ORDER BY check_out DESC LIMIT 1`,
          [user.id, todayStr]
        );
        if (lastOut.length) {
          const diffHours = (now - new Date(lastOut[0].check_out)) / 3600000;
          if (diffHours < minHoursBetween) {
            const waitMin = Math.ceil((minHoursBetween - diffHours) * 60);
            return res.status(400).json({ ok: false, message: `Intervalo mínimo entre turnos: ${minHoursBetween}h. Espera ${waitMin} min.` });
          }
        }
      }

      // Crear nueva sesión
      const { rows: newSession } = await db.query(
        `INSERT INTO attendance_sessions
           (user_id, check_in, check_in_lat, check_in_lon, check_in_geo_accuracy,
            check_in_ip, check_in_device, check_in_maps_link, turn_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [user.id, now, lat || null, lon || null, geo_accuracy_m || null,
         ip_address || null, JSON.stringify(ip_data || {}), maps_link || null, turnsDone + 1]
      );

      return res.json({
        ok: true,
        message: `✅ Entrada registrada a las ${now.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`,
        session_id: newSession[0].id,
        full_name: user.full_name
      });

    } else if (type === 'exit') {
      // Buscar sesión abierta
      const { rows: openSession } = await db.query(
        `SELECT id, check_in, lunch_out FROM attendance_sessions
         WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2
           AND check_out IS NULL
         ORDER BY check_in DESC LIMIT 1`,
        [user.id, todayStr]
      );
      if (!openSession.length) {
        return res.status(400).json({ ok: false, message: 'No tienes entrada activa hoy. Marca Entrada primero.' });
      }

      const session = openSession[0];

      // Calcular horas trabajadas
      const checkIn = new Date(session.check_in);
      const totalMs = now - checkIn;
      const totalHours = totalMs / 3600000;

      // Determinar si hay almuerzo pendiente — si lleva ≥9h y no marcó almuerzo manual
      let lunchDeductMin = 0;
      if (totalHours >= 9 && !session.lunch_out) {
        lunchDeductMin = 60; // auto-descuento
      }

      const workedMs = totalMs - (lunchDeductMin * 60000);
      const workedHours = workedMs / 3600000;
      const hh = Math.floor(workedHours);
      const mm = Math.round((workedHours - hh) * 60);
      const workedStr = `${hh}h ${mm}m`;

      await db.query(
        `UPDATE attendance_sessions
         SET check_out = $1, check_out_lat = $2, check_out_lon = $3,
             check_out_ip = $4, check_out_maps_link = $5,
             lunch_deduct_auto = $6, total_worked_minutes = $7
         WHERE id = $8`,
        [now, lat || null, lon || null, ip_address || null, maps_link || null,
         lunchDeductMin > 0, Math.round(workedMs / 60000), session.id]
      );

      const autoMsg = lunchDeductMin > 0 ? ' (descuento automático de 1h almuerzo)' : '';
      return res.json({
        ok: true,
        message: `✅ Salida registrada. Trabajaste ${workedStr}${autoMsg}`,
        worked_hours: workedStr,
        full_name: user.full_name
      });

    } else if (type === 'lunch_out') {
      const { rows: openSession } = await db.query(
        `SELECT id FROM attendance_sessions
         WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2
           AND check_out IS NULL AND lunch_out IS NULL
         ORDER BY check_in DESC LIMIT 1`,
        [user.id, todayStr]
      );
      if (!openSession.length) {
        return res.status(400).json({ ok: false, message: 'No hay jornada activa o ya iniciaste almuerzo.' });
      }
      await db.query('UPDATE attendance_sessions SET lunch_out = $1 WHERE id = $2', [now, openSession[0].id]);
      return res.json({ ok: true, message: `🍽️ Inicio de almuerzo registrado.` });

    } else if (type === 'lunch_in') {
      const { rows: openSession } = await db.query(
        `SELECT id FROM attendance_sessions
         WHERE user_id = $1 AND DATE(check_in AT TIME ZONE 'America/Bogota') = $2
           AND check_out IS NULL AND lunch_out IS NOT NULL AND lunch_in IS NULL
         ORDER BY check_in DESC LIMIT 1`,
        [user.id, todayStr]
      );
      if (!openSession.length) {
        return res.status(400).json({ ok: false, message: 'No tienes almuerzo activo.' });
      }
      await db.query('UPDATE attendance_sessions SET lunch_in = $1 WHERE id = $2', [now, openSession[0].id]);
      return res.json({ ok: true, message: `✅ Regreso de almuerzo registrado.` });
    }

  } catch (err) {
    console.error('public/mark error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al registrar marcación.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Rutas API autenticadas
// ─────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/corrections', require('./routes/corrections'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/areas',       require('./routes/areas'));
app.use('/api/alerts',      require('./routes/alerts'));

// ─────────────────────────────────────────────────────────────
// Rutas de áreas, sedes y turnos
// ─────────────────────────────────────────────────────────────
const { requireAuth, requireRole } = require('./middleware/auth');

app.get('/api/areas', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM areas ORDER BY name');
  res.json({ ok: true, areas: rows });
});

app.post('/api/areas', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido.' });
  const { rows } = await db.query(
    'INSERT INTO areas (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name.trim()]
  );
  res.json({ ok: true, area: rows[0] || null });
});

app.get('/api/sedes', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM sedes WHERE active=true ORDER BY name');
  res.json({ ok: true, sedes: rows });
});

app.post('/api/sedes', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { name, address, lat, lon, radius_meters, allowed_ips, geo_required } = req.body;
  if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido.' });
  const { rows } = await db.query(
    `INSERT INTO sedes (name, address, lat, lon, radius_meters, allowed_ips, geo_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, address||null, lat||null, lon||null, radius_meters||300,
     JSON.stringify(allowed_ips||[]), geo_required||false]
  );
  res.json({ ok: true, sede: rows[0] });
});

app.put('/api/sedes/:id', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { name, address, lat, lon, radius_meters, allowed_ips, geo_required, active } = req.body;
  const { rows } = await db.query(
    `UPDATE sedes SET name=$1, address=$2, lat=$3, lon=$4, radius_meters=$5,
     allowed_ips=$6, geo_required=$7, active=$8 WHERE id=$9 RETURNING *`,
    [name, address||null, lat||null, lon||null, radius_meters||300,
     JSON.stringify(allowed_ips||[]), geo_required||false, active!==false, req.params.id]
  );
  res.json({ ok: true, sede: rows[0] });
});

app.get('/api/shifts', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM shifts WHERE active=true ORDER BY start_time');
  res.json({ ok: true, shifts: rows });
});

app.post('/api/shifts', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { name, start_time, end_time, crosses_midnight, tolerance_in_min, work_hours } = req.body;
  if (!name || !start_time || !end_time) return res.status(400).json({ ok: false, message: 'Nombre, inicio y fin requeridos.' });
  const { rows } = await db.query(
    `INSERT INTO shifts (name, start_time, end_time, crosses_midnight, tolerance_in_min, work_hours)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, start_time, end_time, crosses_midnight||false, tolerance_in_min||5, work_hours||8.0]
  );
  res.json({ ok: true, shift: rows[0] });
});

// ─────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  const { entity_type, actor_id, start, end, page = 1 } = req.query;
  const limit = 100;
  const offset = (page - 1) * limit;
  const params = [];
  const conds = [];

  if (entity_type) { params.push(entity_type); conds.push(`entity_type=$${params.length}`); }
  if (actor_id)    { params.push(actor_id);     conds.push(`actor_id=$${params.length}`); }
  if (start) { params.push(start); conds.push(`DATE(created_at) >= $${params.length}`); }
  if (end)   { params.push(end);   conds.push(`DATE(created_at) <= $${params.length}`); }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  res.json({ ok: true, logs: rows });
});

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, status: 'online', version: '3.0.1', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, status: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// SPA fallback
// ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ ok: false, message: 'Ruta no encontrada.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Migraciones (idempotentes, se ejecutan en cada arranque)
// ─────────────────────────────────────────────────────────────
async function runMigrations() {
  const migs = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_attendance BOOLEAN DEFAULT true`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_name_text VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_email VARCHAR(120)`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS turn_number INTEGER DEFAULT 1`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS lunch_deduct_auto BOOLEAN DEFAULT false`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS total_worked_minutes INTEGER`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS check_in_maps_link TEXT`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS check_out_maps_link TEXT`,
    `CREATE TABLE IF NOT EXISTS area_settings (
       area_id UUID PRIMARY KEY REFERENCES areas(id),
       manual_lunch BOOLEAN DEFAULT false,
       lunch_minutes INTEGER DEFAULT 60,
       max_turns INTEGER DEFAULT 1,
       min_hours_between DECIMAL(4,2) DEFAULT 1.0,
       geo_required_override BOOLEAN DEFAULT false,
       exclude_from_attendance BOOLEAN DEFAULT false,
       updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS manual_lunch BOOLEAN DEFAULT false`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS lunch_minutes INTEGER DEFAULT 60`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS max_turns INTEGER DEFAULT 1`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS min_hours_between DECIMAL(4,2) DEFAULT 1.0`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS geo_required_override BOOLEAN DEFAULT false`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS exclude_from_attendance BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS excluded_roles (cargo VARCHAR(80) PRIMARY KEY, reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `INSERT INTO area_settings (area_id, manual_lunch, lunch_minutes)
     SELECT a.id, true, 60 FROM areas a WHERE LOWER(a.name) = 'accounting and treasury'
     ON CONFLICT (area_id) DO UPDATE SET manual_lunch = true`
  ];
  for (const sql of migs) {
    await db.query(sql).catch(e => console.warn('Migration skipped:', e.message.substring(0,80)));
  }
  console.log('   ✅ Migraciones ejecutadas');
}

// ─────────────────────────────────────────────────────────────
// Admin inicial
// ─────────────────────────────────────────────────────────────
async function initAdmin() {
  try {
    const email = process.env.ADMIN_INITIAL_EMAIL || 'admin@somosinternet.co';
    const pass  = process.env.ADMIN_INITIAL_PASSWORD || 'Kronos2026!';
    const { rows } = await db.query("SELECT id FROM users WHERE role='super_admin' LIMIT 1");
    if (rows.length > 0) return;
    const hash = await bcrypt.hash(pass, 12);
    await db.query(
      `INSERT INTO users (employee_id, full_name, email, password_hash, role, status)
       VALUES ('ADMIN001', 'Administrador KRONOS', $1, $2, 'super_admin', 'active')
       ON CONFLICT DO NOTHING`,
      [email, hash]
    );
    console.log(`✅ Admin inicial creado. Email: ${email}`);
  } catch (err) {
   
    console.warn('initAdmin warning:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Iniciar
// ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n⚡ KRONOS 3.0 corriendo en puerto ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  await runMigrations();
  await initAdmin();
  console.log(`   Listo ✅\n`);
});

module.exports = app;
