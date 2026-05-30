const jwt = require('jsonwebtoken');

/**
 * Middleware de autenticación JWT.
 * Agrega req.user = { id, role, employee_id, full_name }
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Token requerido.' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: 'Token inválido o expirado.' });
  }
}

/**
 * Middleware de roles. Uso: requireRole('admin','super_admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: 'No autenticado.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, message: 'Sin permisos para esta acción.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
