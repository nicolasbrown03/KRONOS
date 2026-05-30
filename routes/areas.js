const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/areas
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, s.max_turns, s.min_hours_between, s.geo_required_override, s.exclude_from_attendance
       FROM areas a
       LEFT JOIN area_settings s ON s.area_id = a.id
       ORDER BY a.name`
    );
    res.json({ ok: true, areas: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al obtener areas.' });
  }
});

// POST /api/areas
router.post('/', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido.' });
    const { rows } = await db.query(
      'INSERT INTO areas (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name.trim()]
    );
    res.json({ ok: true, area: rows[0] || null, message: 'Area creada.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al crear area.' });
  }
});

// PUT /api/areas/:id/settings — configuracion avanzada del area
router.put('/:id/settings', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { max_turns, min_hours_between, geo_required_override, exclude_from_attendance } = req.body;
    const areaId = req.params.id;

    // Upsert en area_settings
    await db.query(
      `INSERT INTO area_settings (area_id, max_turns, min_hours_between, geo_required_override, exclude_from_attendance)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (area_id) DO UPDATE SET
         max_turns = EXCLUDED.max_turns,
         min_hours_between = EXCLUDED.min_hours_between,
         geo_required_override = EXCLUDED.geo_required_override,
         exclude_from_attendance = EXCLUDED.exclude_from_attendance,
         updated_at = NOW()`,
      [areaId,
       max_turns || 1,
       min_hours_between || 1,
       geo_required_override || false,
       exclude_from_attendance || false]
    );

    await db.query(
      `INSERT INTO audit_logs (actor_id,actor_name,actor_role,action,entity_type,entity_id,payload_after)
       VALUES ($1,$2,$3,'AREA_SETTINGS_UPDATED','area',$4,$5)`,
      [req.user.id, req.user.full_name, req.user.role, areaId,
       JSON.stringify({ max_turns, min_hours_between, geo_required_override, exclude_from_attendance })]
    ).catch(() => {});

    res.json({ ok: true, message: 'Configuracion del area actualizada.' });
  } catch (err) {
    console.error('area settings error:', err.message);
    res.status(500).json({ ok: false, message: 'Error actualizando configuracion.' });
  }
});

// GET /api/areas/excluded-roles — cargos excluidos de marcacion
router.get('/excluded-roles', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM excluded_roles ORDER BY cargo');
    res.json({ ok: true, roles: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al obtener cargos excluidos.' });
  }
});

// POST /api/areas/excluded-roles — agregar cargo excluido
router.post('/excluded-roles', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { cargo, reason } = req.body;
    if (!cargo) return res.status(400).json({ ok: false, message: 'Cargo requerido.' });
    await db.query(
      'INSERT INTO excluded_roles (cargo, reason) VALUES ($1,$2) ON CONFLICT (cargo) DO NOTHING',
      [cargo.trim(), reason || null]
    );
    // Actualizar requires_attendance = false para todos los usuarios con ese cargo
    const { rowCount } = await db.query(
      'UPDATE users SET requires_attendance=false WHERE LOWER(cargo)=LOWER($1)', [cargo]
    );
    res.json({ ok: true, message: `Cargo "${cargo}" excluido. ${rowCount} colaboradores actualizados.` });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al excluir cargo.' });
  }
});

// DELETE /api/areas/excluded-roles/:cargo — quitar exclusion
router.delete('/excluded-roles/:cargo', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const cargo = decodeURIComponent(req.params.cargo);
    await db.query('DELETE FROM excluded_roles WHERE LOWER(cargo)=LOWER($1)', [cargo]);
    await db.query('UPDATE users SET requires_attendance=true WHERE LOWER(cargo)=LOWER($1)', [cargo]);
    res.json({ ok: true, message: `Exclusion de "${cargo}" eliminada.` });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al quitar exclusion.' });
  }
});

module.exports = router;
