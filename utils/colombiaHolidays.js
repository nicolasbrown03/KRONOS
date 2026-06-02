/**
 * KRONOS 3.0 — Motor de festivos y recargos Colombia
 *
 * Ley 2101 de 2021 — Reducción de jornada laboral:
 *   Desde 15/07/2023: 47 h/semana
 *   Desde 15/07/2024: 46 h/semana
 *   Desde 15/07/2025: 44 h/semana  ← VIGENTE mayo 2026
 *   Desde 15/07/2026: 42 h/semana
 *
 * Recargos (CST + Ley 789/2002 + Ley 2466/2025):
 *
 *   ANTES del 25-dic-2025:
 *     Nocturno ordinario (9pm-6am):   +35%
 *     Dominical/festivo:              +75%
 *
 *   DESDE el 25-dic-2025 (Ley 2466 Reforma Laboral):
 *     Nocturno ordinario (7pm-6am):   +35%
 *     Dominical/festivo:              +100%
 *
 *   Siempre:
 *     HED:   +25% | HEN:   +75%
 *     HEDF: +100% | HENDF: +150%
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// FESTIVOS COLOMBIA 2026
// Ley Emiliani (Ley 51/1983): festivos que se trasladan al lunes
// ─────────────────────────────────────────────────────────────
const HOLIDAYS_2026 = new Set([
  '2026-01-01', // Año Nuevo (jueves)
  '2026-01-12', // Reyes Magos → lunes (orig. 6 ene)
  '2026-03-23', // San José → lunes (orig. 19 mar)
  '2026-04-02', // Jueves Santo
  '2026-04-03', // Viernes Santo
  '2026-05-01', // Día del Trabajo (viernes)
  '2026-05-18', // Ascensión del Señor → lunes (orig. 14 may)
  '2026-06-08', // Corpus Christi → lunes (orig. 4 jun)
  '2026-06-15', // Sagrado Corazón → lunes (orig. 12 jun)
  '2026-06-29', // San Pedro y San Pablo (lunes — cae en lunes)
  '2026-07-20', // Día de la Independencia (lunes)
  '2026-08-07', // Batalla de Boyacá (viernes)
  '2026-08-17', // Asunción de la Virgen → lunes (orig. 15 ago)
  '2026-10-12', // Día de la Raza → lunes (orig. 12 oct)
  '2026-11-02', // Todos los Santos → lunes (orig. 1 nov)
  '2026-11-16', // Independencia de Cartagena → lunes (orig. 11 nov)
  '2026-12-08', // Inmaculada Concepción (martes)
  '2026-12-25', // Navidad (viernes)
]);

// ─────────────────────────────────────────────────────────────
// FESTIVOS 2025 (para períodos que crucen el año)
// ─────────────────────────────────────────────────────────────
const HOLIDAYS_2025 = new Set([
  '2025-01-01','2025-01-06','2025-03-24','2025-04-17','2025-04-18',
  '2025-05-01','2025-05-26','2025-06-16','2025-06-23','2025-06-30',
  '2025-07-20','2025-08-07','2025-08-18','2025-10-13',
  '2025-11-03','2025-11-17','2025-12-08','2025-12-25',
]);

/**
 * Retorna true si la fecha es festivo en Colombia.
 * @param {Date|string} date
 */
function isHoliday(date) {
  const d = toDateString(date);
  const year = d.substring(0, 4);
  if (year === '2026') return HOLIDAYS_2026.has(d);
  if (year === '2025') return HOLIDAYS_2025.has(d);
  return false; // Para otros años, agregar aquí
}

/**
 * Retorna true si la fecha es domingo.
 * @param {Date|string} date
 */
function isSunday(date) {
  return new Date(toDateString(date) + 'T12:00:00').getDay() === 0;
}

/**
 * Retorna true si la fecha es festivo O domingo.
 */
function isSundayOrHoliday(date) {
  return isSunday(date) || isHoliday(date);
}

/**
 * Jornada máxima ordinaria semanal según Ley 2101/2021.
 *
 * Escala de reducción:
 *   Desde 15/07/2023: 47 h/semana
 *   Desde 15/07/2024: 46 h/semana
 *   Desde 15/07/2025: 44 h/semana  ← VIGENTE hoy (mayo 2026)
 *   Desde 15/07/2026: 42 h/semana
 *
 * @param {Date|string} referenceDate
 */
function maxOrdinaryHoursPerWeek(referenceDate) {
  const d = new Date(toDateString(referenceDate) + 'T12:00:00');
  if (d >= new Date('2026-07-15T00:00:00')) return 42;
  if (d >= new Date('2025-07-15T00:00:00')) return 44;
  if (d >= new Date('2024-07-15T00:00:00')) return 46;
  if (d >= new Date('2023-07-15T00:00:00')) return 47;
  return 48; // antes de la ley
}

/**
 * Hora máxima ordinaria DIARIA.
 * El CST fija 8h/día. La reducción de Ley 2101 opera a nivel semanal.
 * Para el cálculo de horas extras diarias usamos 8h como tope ordinario,
 * pero el consolidado semanal aplica el límite semanal vigente.
 *
 * Desde 15/07/2026 (42h / 6 días hábiles = 7h/día):
 */
function maxOrdinaryHoursPerDay(referenceDate) {
  const d = new Date(toDateString(referenceDate) + 'T12:00:00');
  return d >= new Date('2026-07-15T00:00:00') ? 7 : 8;
}

/**
 * Determina si una hora esta en periodo nocturno.
 *
 * Ley 2466 de 2025 (Reforma Laboral):
 *   Vigente desde 25 dic 2025: jornada nocturna 7pm (19:00) - 6am
 *   Antes: 9pm (21:00) - 6am
 *
 * @param {Date} datetime
 */
function isNightHour(datetime) {
  const h = datetime.getHours();
  const ley2466 = new Date('2025-12-25T00:00:00');
  if (datetime >= ley2466) {
    return h >= 19 || h < 6; // desde 7pm - Ley 2466/2025
  }
  return h >= 21 || h < 6; // 9pm - ley anterior
}

/**
 * Porcentaje de recargo dominical/festivo segun la fecha.
 * Ley 2466 de 2025: desde 25 dic 2025 el recargo es 100% (antes 75%).
 * @param {Date} referenceDate
 * @returns {number} factor (0.75 o 1.0)
 */
function getSundayHolidaySurcharge(referenceDate) {
  const d = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  return d >= new Date('2025-12-25T00:00:00') ? 1.0 : 0.75;
}

/**
 * Calcula el desglose de horas trabajadas en una jornada.
 * Clasifica cada hora en:
 *   - ordinary_day, ordinary_night, ordinary_sunday, ordinary_holiday
 *   - overtime_hed, overtime_hen, overtime_hedf, overtime_hendf
 *
 * @param {Date} entryTime   - Hora de entrada
 * @param {Date} exitTime    - Hora de salida
 * @param {number} lunchMinutes - Minutos de almuerzo (se restan)
 * @returns {object} Desglose de horas por tipo
 */
function calculateHoursBreakdown(entryTime, exitTime, lunchMinutes = 0) {
  const result = {
    ordinary_day:       0,
    ordinary_night:     0,
    recargo_nocturno:   0,  // horas ordinarias nocturnas
    recargo_dominical:  0,  // horas ordinarias en domingo
    recargo_festivo:    0,  // horas ordinarias en festivo
    overtime_hed:       0,  // hora extra diurna
    overtime_hen:       0,  // hora extra nocturna
    overtime_hedf:      0,  // hora extra diurna dom/festivo
    overtime_hendf:     0,  // hora extra nocturna dom/festivo
    total_worked:       0,
    total_overtime:     0,
  };

  if (!entryTime || !exitTime || exitTime <= entryTime) return result;

  const maxOrdinary = maxOrdinaryHoursPerDay(entryTime);
  const totalMs = exitTime.getTime() - entryTime.getTime() - (lunchMinutes * 60000);
  if (totalMs <= 0) return result;

  const totalHours = totalMs / 3600000;
  result.total_worked = Math.round(totalHours * 100) / 100;

  // Iterar hora a hora para clasificar correctamente
  let ordinaryAccumulated = 0;
  const STEP = 15; // minutos por iteración (mayor precisión)
  const stepMs = STEP * 60000;
  const current = new Date(entryTime.getTime());
  let remainingLunch = lunchMinutes * 60000;

  while (current < exitTime) {
    const sliceEnd = new Date(Math.min(current.getTime() + stepMs, exitTime.getTime()));
    let sliceMs = sliceEnd - current;

    // Descontar almuerzo
    if (remainingLunch > 0) {
      const deducted = Math.min(sliceMs, remainingLunch);
      remainingLunch -= deducted;
      sliceMs -= deducted;
    }

    if (sliceMs <= 0) { current.setTime(sliceEnd.getTime()); continue; }

    const sliceHours = sliceMs / 3600000;
    const night  = isNightHour(current);
    const sunday = isSunday(current);
    const holiday= isHoliday(current);

    const isOrdinary = ordinaryAccumulated < maxOrdinary;

    if (isOrdinary) {
      ordinaryAccumulated += sliceHours;
      if (holiday) {
        result.recargo_festivo += sliceHours;
      } else if (sunday) {
        result.recargo_dominical += sliceHours;
      } else if (night) {
        result.recargo_nocturno += sliceHours;
        result.ordinary_night += sliceHours;
      } else {
        result.ordinary_day += sliceHours;
      }
    } else {
      // Hora extra
      result.total_overtime += sliceHours;
      if (holiday || sunday) {
        if (night) result.overtime_hendf += sliceHours;
        else       result.overtime_hedf  += sliceHours;
      } else {
        if (night) result.overtime_hen += sliceHours;
        else       result.overtime_hed  += sliceHours;
      }
    }

    current.setTime(sliceEnd.getTime());
  }

  // Redondear a 2 decimales
  for (const key of Object.keys(result)) {
    result[key] = Math.round(result[key] * 100) / 100;
  }

  return result;
}

/**
 * Calcula tardanza en minutos.
 * @param {Date} markedAt     - Hora real de llegada
 * @param {string} shiftStart - Hora de inicio del turno 'HH:MM'
 * @param {number} toleranceMin - Minutos de tolerancia
 * @returns {number} Minutos de tardanza (0 si llegó a tiempo)
 */
function calculateLateMinutes(markedAt, shiftStart, toleranceMin = 5) {
  const [h, m] = shiftStart.split(':').map(Number);
  const scheduled = new Date(markedAt);
  scheduled.setHours(h, m, 0, 0);
  const limit = new Date(scheduled.getTime() + toleranceMin * 60000);

  if (markedAt <= limit) return 0;
  return Math.floor((markedAt - scheduled) / 60000);
}

// ─────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────
function toDateString(date) {
  if (typeof date === 'string') return date.substring(0, 10);
  return date.toISOString().substring(0, 10);
}

module.exports = {
  isHoliday,
  isSunday,
  isSundayOrHoliday,
  maxOrdinaryHoursPerWeek,
  maxOrdinaryHoursPerDay,
  isNightHour,
  getSundayHolidaySurcharge,
  calculateHoursBreakdown,
  calculateLateMinutes,
  HOLIDAYS_2026,
};
