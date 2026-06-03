const express = require('express');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const XLSX    = require('xlsx');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────
// GET /api/users — listar colaboradores (admin)
// ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const { area, status, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (area)   { params.push(area);   conditions.push(`a.name ILIKE $${params.length}`); }
    if (status) { params.push(status); conditions.push(`u.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(u.full_name ILIKE $${params.length} OR u.employee_id ILIKE $${params.length})`); }

    // Líderes solo ven su equipo
    if (req.user.role === 'leader') {
      params.push(req.user.id);
      conditions.push(`u.leader_id = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), offset);

    const { rows } = await db.query(
      `SELECT u.id, u.employee_id, u.full_name, u.email, u.phone,
              u.role, u.cargo, u.status, u.start_date, u.buk_id, u.cost_center,
              a.name AS area, s.name AS sede, sh.name AS shift,
              l.full_name AS leader_name
       FROM users u
       LEFT JOIN areas  a  ON a.id  = u.area_id
       LEFT JOIN sedes  s  ON s.id  = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       LEFT JOIN users  l  ON l.id  = u.leader_id
       ${where}
       ORDER BY u.full_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Total count
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM users u
       LEFT JOIN areas a ON a.id = u.area_id ${where}`,
      countParams
    );

    res.json({ ok: true, users: rows, total: parseInt(countRows[0].count), page: parseInt(page) });
  } catch (err) {
    console.error('users list error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al obtener usuarios.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/users/:id — detalle
// ─────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.*, a.name AS area, s.name AS sede, sh.name AS shift,
              sh.start_time, sh.end_time, l.full_name AS leader_name
       FROM users u
       LEFT JOIN areas  a  ON a.id  = u.area_id
       LEFT JOIN sedes  s  ON s.id  = u.sede_id
       LEFT JOIN shifts sh ON sh.id = u.shift_id
       LEFT JOIN users  l  ON l.id  = u.leader_id
       WHERE u.id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    const u = rows[0];
    delete u.password_hash;
    res.json({ ok: true, user: u });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/users — crear colaborador individual
// ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { employee_id, full_name, email, phone, role, cargo,
            area_name, sede_name, shift_name, leader_employee_id,
            password, start_date, buk_id, cost_center, contract_type } = req.body;

    if (!employee_id || !full_name) {
      return res.status(400).json({ ok: false, message: 'ID y nombre son requeridos.' });
    }

    const { area_id, sede_id, shift_id, leader_id } =
      await resolveRelations(area_name, sede_name, shift_name, leader_employee_id);

    const hash = password ? await bcrypt.hash(password, 12) : await bcrypt.hash(employee_id + 'K!', 12);

    const { rows } = await db.query(
      `INSERT INTO users (employee_id, full_name, email, phone, role, cargo,
         area_id, sede_id, shift_id, leader_id, password_hash,
         start_date, buk_id, cost_center, contract_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, employee_id, full_name, role`,
      [employee_id.trim(), full_name.trim(), email || null, phone || null,
       role || 'employee', cargo || null,
       area_id, sede_id, shift_id, leader_id, hash,
       start_date || null, buk_id || null, cost_center || null, contract_type || null]
    );

    await auditLog(db, req.user, 'USER_CREATED', 'user', rows[0].id, null, rows[0]);
    res.status(201).json({ ok: true, user: rows[0],
      message: `✅ ${rows[0].full_name} creado. Contraseña inicial: ${password || employee_id + 'K!'}` });

  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, message: 'El ID ya existe.' });
    console.error('create user error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al crear usuario.' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/users/:id — actualizar colaborador
// ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { full_name, email, phone, role, cargo, status,
            area_name, sede_name, shift_name, leader_employee_id,
            start_date, buk_id, cost_center, contract_type } = req.body;

    const { area_id, sede_id, shift_id, leader_id } =
      await resolveRelations(area_name, sede_name, shift_name, leader_employee_id);

    const { rows } = await db.query(
      `UPDATE users SET
         full_name=$1, email=$2, phone=$3, role=$4, cargo=$5, status=$6,
         area_id=$7, sede_id=$8, shift_id=$9, leader_id=$10,
         start_date=$11, buk_id=$12, cost_center=$13, contract_type=$14,
         updated_at=NOW()
       WHERE id=$15 RETURNING id, employee_id, full_name, role, status`,
      [full_name, email || null, phone || null, role || 'employee', cargo || null, status || 'active',
       area_id, sede_id, shift_id, leader_id,
       start_date || null, buk_id || null, cost_center || null, contract_type || null,
       req.params.id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    await auditLog(db, req.user, 'USER_UPDATED', 'user', rows[0].id, null, rows[0]);
    res.json({ ok: true, user: rows[0], message: '✅ Usuario actualizado.' });

  } catch (err) {
    console.error('update user error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al actualizar usuario.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/users/reset-password/:id
// ─────────────────────────────────────────────────────────────
router.post('/reset-password/:id', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT employee_id, full_name FROM users WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });

    const newPass = rows[0].employee_id + 'K!';
    const hash = await bcrypt.hash(newPass, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.params.id]);

    await auditLog(db, req.user, 'PASSWORD_RESET', 'user', req.params.id, null, { reset_for: rows[0].full_name });
    res.json({ ok: true, message: `✅ Contraseña de ${rows[0].full_name} restablecida a: ${newPass}` });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al restablecer contraseña.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/users/import/buk  — IMPORTACIÓN MASIVA DESDE BUK
//
// Acepta archivo Excel (.xlsx) exportado de BUK.
// Columnas esperadas (el sistema intenta mapear automáticamente):
//   Cédula / RUT / ID → employee_id
//   Nombres / Nombre  → first_name
//   Apellidos          → last_name
//   Nombre Completo    → full_name (alternativo)
//   Cargo / Puesto     → cargo
//   Área / Departamento / Gerencia → area
//   Email / Correo     → email
//   Supervisor / Líder → leader_employee_id
//   Centro de costo    → cost_center
//   Fecha inicio       → start_date
//   ID BUK / Código    → buk_id
// ─────────────────────────────────────────────────────────────
router.post('/import/buk', requireAuth, requireRole('super_admin','admin'),
  upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: 'Archivo requerido.' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rawRows.length) return res.status(400).json({ ok: false, message: 'El archivo está vacío.' });

    // ── Mapeo flexible de columnas ──
    const COL_MAP = {
      employee_id: ['id','cédula','cedula','rut','id colaborador','id empleado','numero documento',
                    'no. documento','documento','código colaborador'],
      full_name:   ['empleado','nombre completo','nombres y apellidos','nombre colaborador'],
      first_name:  ['nombres','nombre'],
      last_name:   ['apellidos','apellido'],
      cargo:       ['cargo','puesto','posición','posicion'],
      area:        ['nombre ecosistema','área','area','departamento','gerencia'],
      email:       ['email','correo','correo electronico','correo electrónico'],
      leader:      ['líder de ecosistema','lider de ecosistema','supervisor','jefe directo','responsable'],
      cost_center: ['centro de costo','cc','centrocosto'],
      start_date:  ['fecha inicio','fecha ingreso','fecha de ingreso'],
      buk_id:      ['id buk','código buk','codigo buk','id interno'],
      sede:        ['municipio','sede','ubicación','ubicacion','ciudad'],
    };

    function findCol(row, keys) {
      const rowKeys = Object.keys(row).map(k => ({ orig: k, norm: k.toLowerCase().trim() }));
      // Fase 1: coincidencia exacta (mas segura)
      for (const key of keys) {
        const exact = rowKeys.find(k => k.norm === key);
        if (exact) return row[exact.orig];
      }
      // Fase 2: el encabezado de columna CONTIENE la clave (no al reves, evita falsos positivos)
      for (const key of keys) {
        const partial = rowKeys.find(k => k.norm.includes(key) && key.length >= 3);
        if (partial) return row[partial.orig];
      }
      return '';
    }

    // Obtener todos los líderes existentes para resolver por employee_id
    const { rows: leaderRows } = await db.query('SELECT id, employee_id, full_name FROM users');
    const leaderMap = {};      // por employee_id
    const leaderNameMap = {};  // por nombre completo (para Excel que trae nombres de lideres)
    leaderRows.forEach(l => {
      leaderMap[l.employee_id] = l.id;
      if (l.full_name) leaderNameMap[l.full_name.toLowerCase().trim()] = l.id;
    });
    function findLeaderByName(name, nameMap, users) {
      if (!name) return null;
      const norm = name.toLowerCase().trim();
      if (nameMap[norm]) return nameMap[norm];
      const words = norm.split(/\s+/).filter(w => w.length > 2);
      if (words.length < 2) return null;
      for (const u of users) {
        if (!u.full_name) continue;
        const uWords = u.full_name.toLowerCase().split(/\s+/);
        const matches = words.filter(w => uWords.some(uw => uw.includes(w) || w.includes(uw)));
        if (matches.length >= Math.min(words.length, 3)) return u.id;
      }
      return null;
    }

    const results = { created: 0, updated: 0, errors: [] };
    const importId = require('crypto').randomUUID();

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];

      try {
        let empId = String(findCol(raw, COL_MAP.employee_id) || '').trim().replace(/[.,]/g, '');
        if (!empId) { results.errors.push({ row: i + 2, error: 'Sin ID de colaborador' }); continue; }

        let fullName = String(findCol(raw, COL_MAP.full_name) || '').trim();
        if (!fullName) {
          const fn = String(findCol(raw, COL_MAP.first_name) || '').trim();
          const ln = String(findCol(raw, COL_MAP.last_name) || '').trim();
          fullName = [fn, ln].filter(Boolean).join(' ');
        }
        if (!fullName) { results.errors.push({ row: i + 2, error: `Fila ${i+2}: sin nombre` }); continue; }

        const cargo       = String(findCol(raw, COL_MAP.cargo) || '').trim() || null;
        const areaName    = String(findCol(raw, COL_MAP.area) || '').trim() || null;
        const email       = String(findCol(raw, COL_MAP.email) || '').trim().toLowerCase() || null;
        const leaderEmpId = String(findCol(raw, COL_MAP.leader) || '').trim().replace(/[.,]/g, '');
        const costCenter  = String(findCol(raw, COL_MAP.cost_center) || '').trim() || null;
        const bukId       = String(findCol(raw, COL_MAP.buk_id) || '').trim() || null;
        const sedeName    = String(findCol(raw, COL_MAP.sede) || '').trim() || null;

        let startDate = null;
        const sdRaw = findCol(raw, COL_MAP.start_date);
        if (sdRaw) {
          const d = sdRaw instanceof Date ? sdRaw : new Date(sdRaw);
          if (!isNaN(d)) startDate = d.toISOString().substring(0, 10);
        }

        const { area_id, sede_id } = await resolveRelations(areaName, sedeName, null, null);
        const leader_id = leaderMap[leaderEmpId] || findLeaderByName(leaderEmpId, leaderNameMap, leaderRows) || null;

        // Insertar o actualizar
        const existing = await db.query('SELECT id FROM users WHERE employee_id=$1', [empId]);

        if (existing.rows.length === 0) {
          // CREAR
          const hash = await bcrypt.hash(empId + 'K!', 10);
          await db.query(
            `INSERT INTO users (employee_id, full_name, email, cargo, area_id, sede_id,
               leader_id, start_date, buk_id, cost_center, password_hash, role)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'employee')`,
            [empId, fullName, email, cargo, area_id, sede_id, leader_id, startDate, bukId, costCenter, hash]
          );
          const newUserId = (await db.query('SELECT id FROM users WHERE employee_id=$1',[empId])).rows[0]?.id;
          leaderMap[empId] = newUserId;
          if (newUserId && fullName) { leaderNameMap[fullName.toLowerCase().trim()] = newUserId; leaderRows.push({ id: newUserId, employee_id: empId, full_name: fullName }); }
          results.created++;
        } else {
          // ACTUALIZAR
          await db.query(
            `UPDATE users SET full_name=$1, email=$2, cargo=$3, area_id=$4, sede_id=$5,
               leader_id=$6, start_date=$7, buk_id=$8, cost_center=$9, updated_at=NOW()
             WHERE employee_id=$10`,
            [fullName, email, cargo, area_id, sede_id, leader_id, startDate, bukId, costCenter, empId]
          );
          results.updated++;
        }
      } catch (rowErr) {
        results.errors.push({ row: i + 2, error: rowErr.message });
      }
    }

    // Registrar importación
    await db.query(
      `INSERT INTO buk_imports (id, filename, total_rows, created_rows, updated_rows, error_rows, errors, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [importId, req.file.originalname, rawRows.length,
       results.created, results.updated, results.errors.length,
       JSON.stringify(results.errors), req.user.id]
    ).catch(() => {});

    await auditLog(db, req.user, 'BUK_IMPORT', 'users', null, null,
      { file: req.file.originalname, created: results.created, updated: results.updated });

    res.json({
      ok: true,
      message: `✅ Importación completada: ${results.created} creados, ${results.updated} actualizados, ${results.errors.length} errores.`,
      results
    });

  } catch (err) {
    console.error('BUK import error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al procesar el archivo: ' + err.message });
  }
});

// GET /api/users/import/history
router.get('/import/history', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, u.full_name AS imported_by_name
       FROM buk_imports b LEFT JOIN users u ON u.id = b.imported_by
       ORDER BY b.created_at DESC LIMIT 20`
    );
    res.json({ ok: true, imports: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// DELETE /api/users/bulk-delete — borrar TODOS los colaboradores
// ─────────────────────────────────────────────────────────────
router.delete('/bulk-delete', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'CONFIRMAR_BORRADO') {
      return res.status(400).json({ ok: false, message: 'Debes enviar confirm: CONFIRMAR_BORRADO' });
    }
    const { rows: empRows } = await db.query("SELECT id FROM users WHERE role = 'employee'");
    const empIds = empRows.map(r => r.id);
    if (!empIds.length) return res.json({ ok: true, message: 'No habia colaboradores para borrar.', deleted: 0 });

    await db.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM corrections WHERE requester_id = ANY($1) OR target_user_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM payroll_summaries WHERE user_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM attendance_sessions WHERE user_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM attendances WHERE user_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM buk_imports WHERE imported_by = ANY($1)', [empIds]);
    await db.query('UPDATE users SET leader_id = NULL WHERE leader_id = ANY($1)', [empIds]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [empIds]);

    await auditLog(db, req.user, 'BULK_DELETE_EMPLOYEES', 'users', null, null,
      { deleted_count: empIds.length });
    res.json({ ok: true, message: empIds.length + ' colaboradores eliminados. Ahora puedes importar el archivo correcto.', deleted: empIds.length });
  } catch (err) {
    console.error('bulk-delete error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al borrar: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/users/:id — borrar un colaborador individual
// ─────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT full_name, role FROM users WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    if (rows[0].role === 'super_admin') return res.status(403).json({ ok: false, message: 'No se puede borrar un super admin.' });

    const ids = [req.params.id];
    await db.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]);
    await db.query('DELETE FROM corrections WHERE requester_id = ANY($1) OR target_user_id = ANY($1)', [ids]);
    await db.query('DELETE FROM payroll_summaries WHERE user_id = ANY($1)', [ids]);
    await db.query('DELETE FROM attendance_sessions WHERE user_id = ANY($1)', [ids]);
    await db.query('DELETE FROM attendances WHERE user_id = ANY($1)', [ids]);
    await db.query('UPDATE users SET leader_id = NULL WHERE leader_id = ANY($1)', [ids]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [ids]);

    await auditLog(db, req.user, 'USER_DELETED', 'user', req.params.id, { name: rows[0].full_name }, null);
    res.json({ ok: true, message: rows[0].full_name + ' eliminado correctamente.' });
  } catch (err) {
    console.error('delete user error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al borrar: ' + err.message });
  }
});


async function resolveRelations(areaName, sedeName, shiftName, leaderEmpId) {
  let area_id = null, sede_id = null, shift_id = null, leader_id = null;

  if (areaName) {
    const r = await db.query('SELECT id FROM areas WHERE name ILIKE $1 LIMIT 1', [areaName]);
    if (r.rows.length) {
      area_id = r.rows[0].id;
    } else {
      // Crear área si no existe
      const ins = await db.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [areaName]);
      area_id = ins.rows[0].id;
    }
  }

  if (sedeName) {
    const r = await db.query('SELECT id FROM sedes WHERE name ILIKE $1 LIMIT 1', [sedeName]);
    if (r.rows.length) sede_id = r.rows[0].id;
  }

  if (shiftName) {
    const r = await db.query('SELECT id FROM shifts WHERE name ILIKE $1 LIMIT 1', [shiftName]);
    if (r.rows.length) shift_id = r.rows[0].id;
  }

  if (leaderEmpId) {
    const r = await db.query('SELECT id FROM users WHERE employee_id=$1 LIMIT 1', [leaderEmpId]);
    if (r.rows.length) leader_id = r.rows[0].id;
  }

  return { area_id, sede_id, shift_id, leader_id };
}

async function auditLog(db, actor, action, entityType, entityId, before, after) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, payload_before, payload_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.id, actor.full_name, actor.role, action, entityType, entityId,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  ).catch(() => {});
}

module.exports = router;
