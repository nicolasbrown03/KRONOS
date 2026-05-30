const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/corrections — solicitar corrección
router.post('/', requireAuth, async (req, res) => {
  try {
    const { target_employee_id, session_date, type, new_value, reason } = req.body;
    if (!session_date || !type || !new_value || !reason) {
      return res.status(400).json({ ok: false, message: 'Faltan campos requeridos.' });
    }

    // Resolver usuario objetivo
    let targetId = req.user.id; // por defecto el mismo usuario
    if (target_employee_id && target_employee_id !== req.user.employee_id) {
      if (!['admin','super_admin','leader'].includes(req.user.role)) {
        return res.status(403).json({ ok: false, message: 'Solo puedes solicitar correcciones para ti mismo.' });
      }
      const { rows } = await db.query('SELECT id FROM users WHERE employee_id=$1', [target_employee_id]);
      if (!rows.length) return res.status(404).json({ ok: false, message: 'Colaborador no encontrado.' });
      targetId = rows[0].id;
    }

    // Obtener sesión del día para contexto
    const { rows: sessRows } = await db.query(
      `SELECT s.*, e.marked_at AS entry_time, x.marked_at AS exit_time
       FROM attendance_sessions s
       LEFT JOIN attendances e ON e.id = s.entry_id
       LEFT JOIN attendances x ON x.id = s.exit_id
       WHERE s.user_id=$1 AND s.session_date=$2`, [targetId, session_date]
    );
    const originalValue = sessRows[0] || null;

    const { rows } = await db.query(
      `INSERT INTO corrections (requester_id, target_user_id, session_date, type, original_value, new_value, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, created_at`,
      [req.user.id, targetId, session_date, type,
       JSON.stringify(originalValue), JSON.stringify(new_value), reason]
    );

    res.status(201).json({
      ok: true,
      message: '✅ Solicitud enviada. Tu líder la revisará pronto.',
      correction: rows[0]
    });
  } catch (err) {
    console.error('correction create error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al crear solicitud.' });
  }
});

// GET /api/corrections — listar (pendientes para líder/admin)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`c.status=$${params.length}`); }

    // Líderes ven correcciones de su equipo
    if (req.user.role === 'leader') {
      params.push(req.user.id);
      conditions.push(`u_target.leader_id=$${params.length}`);
    }
    // Empleados ven solo las propias
    if (req.user.role === 'employee') {
      params.push(req.user.id);
      conditions.push(`c.requester_id=$${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), offset);

    const { rows } = await db.query(
      `SELECT c.*, u_req.full_name AS requester_name,
              u_target.full_name AS target_name, u_target.employee_id AS target_emp_id,
              a.name AS target_area, u_apr.full_name AS approver_name
       FROM corrections c
       JOIN users u_req    ON u_req.id    = c.requester_id
       JOIN users u_target ON u_target.id = c.target_user_id
       LEFT JOIN areas a   ON a.id = u_target.area_id
       LEFT JOIN users u_apr ON u_apr.id  = c.approver_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, corrections: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// PUT /api/corrections/:id/approve — líder aprueba
router.put('/:id/approve', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const { comment } = req.body;
    const { rows } = await db.query(
      `UPDATE corrections SET status='approved', approver_id=$1, approved_at=NOW(), approver_comment=$2
       WHERE id=$3 AND status='pending' RETURNING id, target_user_id, new_value, type, session_date`,
      [req.user.id, comment || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Solicitud no encontrada o ya procesada.' });

    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id)
       VALUES ($1,$2,$3,'CORRECTION_APPROVED','correction',$4)`,
      [req.user.id, req.user.full_name, req.user.role, rows[0].id]
    ).catch(() => {});

    res.json({ ok: true, message: '✅ Corrección aprobada. El admin la ejecutará.', correction: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// PUT /api/corrections/:id/reject
router.put('/:id/reject', requireAuth, requireRole('super_admin','admin','leader'), async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ ok: false, message: 'Debes indicar el motivo del rechazo.' });

    const { rows } = await db.query(
      `UPDATE corrections SET status='rejected', approver_id=$1, approved_at=NOW(), approver_comment=$2
       WHERE id=$3 AND status='pending' RETURNING id`,
      [req.user.id, comment, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'No encontrada o ya procesada.' });
    res.json({ ok: true, message: '❌ Solicitud rechazada.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error interno.' });
  }
});

// PUT /api/corrections/:id/execute — admin ejecuta la corrección
router.put('/:id/execute', requireAuth, requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { rows: corrRows } = await db.query(
      'SELECT * FROM corrections WHERE id=$1 AND status=$2',
      [req.params.id, 'approved']
    );
    if (!corrRows.length) return res.status(404).json({ ok: false, message: 'Corrección no aprobada o no encontrada.' });

    const corr = corrRows[0];
    const newVal = corr.new_value;

    // Aplicar según el tipo
    if (corr.type === 'missing_entry' || corr.type === 'time_fix') {
      const { entry_time, exit_time } = newVal;

      if (entry_time) {
        // Buscar o crear marcación de entrada
        const { rows: existEntry } = await db.query(
          `SELECT a.id FROM attendances a
           JOIN attendance_sessions s ON s.entry_id = a.id
           WHERE s.user_id=$1 AND s.session_date=$2`,
          [corr.target_user_id, corr.session_date]
        );

        if (existEntry.length) {
          await db.query(
            `UPDATE attendances SET marked_at=$1, status='corrected', source='admin',
             notes=$2 WHERE id=$3`,
            [new Date(entry_time), `Corrección ejecutada por ${req.user.full_name}`, existEntry[0].id]
          );
        } else {
          const { rows: newAtt } = await db.query(
            `INSERT INTO attendances (user_id, type, marked_at, source, status, notes)
             VALUES ($1,'entry',$2,'admin','corrected',$3) RETURNING id`,
            [corr.target_user_id, new Date(entry_time), `Corrección por ${req.user.full_name}`]
          );
          await db.query(
            `INSERT INTO attendance_sessions (user_id, session_date, entry_id, status)
             VALUES ($1,$2,$3,'open')
             ON CONFLICT (user_id, session_date) DO UPDATE SET entry_id=$3`,
            [corr.target_user_id, corr.session_date, newAtt[0].id]
          );
        }
      }

      if (exit_time) {
        const { rows: existExit } = await db.query(
          `SELECT a.id FROM attendances a
           JOIN attendance_sessions s ON s.exit_id = a.id
           WHERE s.user_id=$1 AND s.session_date=$2`,
          [corr.target_user_id, corr.session_date]
        );
        if (existExit.length) {
          await db.query(
            `UPDATE attendances SET marked_at=$1, status='corrected', source='admin' WHERE id=$2`,
            [new Date(exit_time), existExit[0].id]
          );
        } else {
          const { rows: newAtt } = await db.query(
            `INSERT INTO attendances (user_id, type, marked_at, source, status, notes)
             VALUES ($1,'exit',$2,'admin','corrected',$3) RETURNING id`,
            [corr.target_user_id, new Date(exit_time), `Corrección por ${req.user.full_name}`]
          );
          await db.query(
            `UPDATE attendance_sessions SET exit_id=$1, status='closed' WHERE user_id=$2 AND session_date=$3`,
            [newAtt[0].id, corr.target_user_id, corr.session_date]
          );
        }
      }
    }

    // Marcar como ejecutada
    await db.query(
      `UPDATE corrections SET status='executed', executed_by=$1, executed_at=NOW() WHERE id=$2`,
      [req.user.id, corr.id]
    );

    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, payload_after)
       VALUES ($1,$2,$3,'CORRECTION_EXECUTED','correction',$4,$5)`,
      [req.user.id, req.user.full_name, req.user.role, corr.id, JSON.stringify(newVal)]
    ).catch(() => {});

    res.json({ ok: true, message: '✅ Corrección ejecutada y registrada en auditoría.' });
  } catch (err) {
    console.error('correction execute error:', err.message);
    res.status(500).json({ ok: false, message: 'Error al ejecutar corrección.' });
  }
});

module.exports = router;
