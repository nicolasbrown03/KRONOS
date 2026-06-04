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

// Rate limiting — protección básica (sin Redis en free tier)
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { ok: false, message: 'Demasiados intentos. Espera 15 minutos.' }
}));
app.use('/api/attendance/mark', rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { ok: false, message: 'Demasiadas marcaciones. Espera un momento.' }
}));

// ─────────────────────────────────────────────────────────────
// Rutas API
// ─────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/corrections', require('./routes/corrections'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/areas',       require('./routes/areas'));
app.use('/api/alerts',      require('./routes/alerts'));

// ─────────────────────────────────────────────────────────────
// Rutas de áreas, sedes y turnos (CRUD básico)
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
    res.json({ ok: true, status: 'online', version: '3.0.0', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, status: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// Endpoints PUBLICOS (sin autenticacion) para la pantalla de marcacion
app.get('/api/public/areas', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name FROM areas ORDER BY name');
    res.json({ ok: true, areas: rows.map(r => r.name) });
  } catch(e) { res.json({ ok: true, areas: [] }); }
});

app.get('/api/public/area-lunch/:area_name', async (req, res) => {
  try {
    const area = decodeURIComponent(req.params.area_name);
    const { rows } = await db.query(
      `SELECT s.manual_lunch, s.lunch_minutes FROM areas a
       LEFT JOIN area_settings s ON s.area_id = a.id
       WHERE LOWER(a.name) = LOWER($1) LIMIT 1`, [area]
    );
    const cfg = rows[0] || {};
    res.json({ ok: true, manual_lunch: cfg.manual_lunch || false, lunch_minutes: cfg.lunch_minutes || 60 });
  } catch(e) { res.json({ ok: true, manual_lunch: false, lunch_minutes: 60 }); }
});

app.get('/api/public/employee/:employee_id', async (req, res) => {
  try {
    const eco = req.query.ecosystem || '';
    const { rows } = await db.query(
      `SELECT u.employee_id, u.full_name, u.cargo, u.status, a.name AS area
       FROM users u LEFT JOIN areas a ON a.id = u.area_id
       WHERE u.employee_id=$1 AND ($2='' OR LOWER(a.name)=LOWER($2)) LIMIT 1`,
      [String(req.params.employee_id).trim(), eco]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Colaborador no encontrado.' });
    if (rows[0].status !== 'active') return res.status(403).json({ ok: false, message: 'Colaborador inactivo.' });
    res.json({ ok: true, employee: rows[0] });
  } catch(e) { res.status(500).json({ ok: false, message: 'Error.' }); }
});

app.post('/api/public/mark', async (req, res) => {
  try {
    const { employee_id, ecosystem, type, lat, lon, geo_accuracy_m, ip_address, ip_data } = req.body;
    if (!employee_id || !ecosystem || !type) return res.status(400).json({ ok: false, message: 'Datos incompletos.' });
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.role, u.status FROM users u
       LEFT JOIN areas a ON a.id = u.area_id
       WHERE u.employee_id=$1 AND LOWER(a.name)=LOWER($2) LIMIT 1`,
      [String(employee_id).trim(), String(ecosystem).trim()]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'ID o ecosistema no encontrado.' });
    const user = rows[0];
    if (user.status !== 'active') return res.status(403).json({ ok: false, message: 'Usuario inactivo.' });
    const jwt = require('jsonwebtoken');
    const tempToken = jwt.sign(
      { id: user.id, employee_id: String(employee_id).trim(), full_name: user.full_name, role: user.role },
      process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    req.user = { id: user.id, employee_id: String(employee_id).trim(), full_name: user.full_name, role: user.role };
    req.body = { type, lat, lon, geo_accuracy_m, ip_address, ip_data };
    req.headers = { ...req.headers, authorization: 'Bearer ' + tempToken };
    const attRouter = require('./routes/attendance');
    attRouter.handle(req, res, () => res.status(404).json({ ok: false }));
  } catch(e) { console.error('public mark:', e.message); res.status(500).json({ ok: false, message: 'Error.' }); }
});

// SPA fallback — todas las rutas no-API sirven el frontend
// ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ ok: false, message: 'Ruta no encontrada.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Inicialización: crear admin inicial si no existe
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
    console.log(`✅ Admin inicial creado. Email: ${email} | Contraseña: ${pass}`);
    console.log(`   ⚠️  Cambia la contraseña después del primer login.`);
  } catch (err) {
    console.warn('initAdmin warning:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────────────────────────────
// Migraciones de columnas nuevas (se ejecutan en cada arranque, idempotentes)
async function runMigrations() {
  const migs = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_attendance BOOLEAN DEFAULT true`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_name_text VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_email VARCHAR(120)`,
    `CREATE TABLE IF NOT EXISTS area_settings (
      area_id UUID PRIMARY KEY REFERENCES areas(id),
      manual_lunch BOOLEAN DEFAULT false,
      lunch_minutes INTEGER DEFAULT 60,
      max_turns INTEGER DEFAULT 1,
      min_hours_between DECIMAL(4,2) DEFAULT 1.0,
      geo_required_override BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS manual_lunch BOOLEAN DEFAULT false`,
    `ALTER TABLE area_settings ADD COLUMN IF NOT EXISTS lunch_minutes INTEGER DEFAULT 60`,
    `CREATE TABLE IF NOT EXISTS excluded_roles (cargo VARCHAR(80) PRIMARY KEY, reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS turn_number INTEGER DEFAULT 1`,
    `INSERT INTO area_settings (area_id, manual_lunch, lunch_minutes)
     SELECT a.id, true, 60 FROM areas a WHERE LOWER(a.name) = 'accounting and treasury'
     ON CONFLICT (area_id) DO UPDATE SET manual_lunch = true`
  ];
  for (const sql of migs) {
    await db.query(sql).catch(e => console.warn('Migration skipped:', e.message.substring(0,60)));
  }
  console.log('   Migraciones OK');
}

app.listen(PORT, async () => {
  console.log(`\n⚡ KRONOS 3.0 corriendo en puerto ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  await initAdmin();
  console.log(`   Listo ✅\n`);
});

module.exports = app;
