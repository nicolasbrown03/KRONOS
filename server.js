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

// Auto-init schema if tables do not exist
async function initSchema() {
  try {
    const r = await db.query("SELECT to_regclass('public.users') AS t");
    if (r.rows[0].t) { console.log('   DB: tables OK'); return; }
    console.log('   DB: running schema...');
    const fs = require('fs');
    const sql = fs.readFileSync(require('path').join(__dirname,'db','schema.sql'),'utf8');
    await db.query(sql);
    console.log('   DB: schema done');
  } catch(e) { console.error('   DB schema error:', e.message); }
}

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
app.listen(PORT, async () => {
  console.log(`\n⚡ KRONOS 3.0 corriendo en puerto ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  await initSchema();
  await initAdmin();
  console.log(`   Listo ✅\n`);
});

module.exports = app;
