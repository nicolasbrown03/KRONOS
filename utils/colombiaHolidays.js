'use strict';

// Festivos Colombia 2026
const HOLIDAYS_2026 = new Set([
  '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03',
  '2026-05-01','2026-05-18','2026-06-08','2026-06-15','2026-06-29',
  '2026-07-20','2026-08-07','2026-08-17','2026-10-12',
  '2026-11-02','2026-11-16','2026-12-08','2026-12-25',
]);

const HOLIDAYS_2025 = new Set([
  '2025-01-01','2025-01-06','2025-03-24','2025-04-17','2025-04-18',
  '2025-05-01','2025-05-26','2025-06-16','2025-06-23','2025-06-30',
  '2025-07-20','2025-08-07','2025-08-18','2025-10-13',
  '2025-11-03','2025-11-17','2025-12-08','2025-12-25',
]);

function toDateString(date) {
  if (typeof date === 'string') return date.substring(0, 10);
  return date.toISOString().substring(0, 10);
}

function isHoliday(date) {
  const d = toDateString(date);
  const year = d.substring(0, 4);
  if (year === '2026') return HOLIDAYS_2026.has(d);
  if (year === '2025') return HOLIDAYS_2025.has(d);
  return false;
}

function isSunday(date) {
  return new Date(toDateString(date) + 'T12:00:00').getDay() === 0;
}

function isSundayOrHoliday(date) {
  return isSunday(date) || isHoliday(date);
}

// Ley 2101/2021 - jornada maxima semanal
function maxOrdinaryHoursPerWeek(referenceDate) {
  const d = new Date(toDateString(referenceDate) + 'T12:00:00');
  if (d >= new Date('2026-07-15')) return 42;
  if (d >= new Date('2025-07-15')) return 44;
  if (d >= new Date('2024-07-15')) return 46;
  if (d >= new Date('2023-07-15')) return 47;
  return 48;
}

function maxOrdinaryHoursPerDay(referenceDate) {
  const d = new Date(toDateString(referenceDate) + 'T12:00:00');
  return d >= new Date('2026-07-15') ? 7 : 8;
}

// Ley 2466/2025 - nocturno desde 7pm (vigente desde 25-dic-2025)
function isNightHour(datetime) {
  const h = datetime.getHours();
  if (datetime >= new Date('2025-12-25')) {
    return h >= 19 || h < 6;
  }
  return h >= 21 || h < 6;
}

// Ley 2466/2025 - recargo dominical/festivo progresivo
// Hasta jun-2025: 75% | jul25-jun26: 80% | jul26-jun27: 90% | jul27+: 100%
function getSundayHolidaySurcharge(referenceDate) {
  const d = referenceDate instanceof Date ? referenceDate : new Date(toDateString(referenceDate) + 'T12:00:00');
  if (d >= new Date('2027-07-01')) return 1.00;
  if (d >= new Date('2026-07-01')) return 0.90;
  if (d >= new Date('2025-07-01')) return 0.80;
  return 0.75;
}

function calculateHoursBreakdown(entryTime, exitTime, lunchMinutes) {
  lunchMinutes = lunchMinutes || 0;
  const result = {
    ordinary_day: 0, ordinary_night: 0,
    recargo_nocturno: 0, recargo_dominical: 0, recargo_festivo: 0,
    overtime_hed: 0, overtime_hen: 0, overtime_hedf: 0, overtime_hendf: 0,
    total_worked: 0, total_overtime: 0,
  };

  if (!entryTime || !exitTime || exitTime <= entryTime) return result;

  const maxOrdinary = maxOrdinaryHoursPerDay(entryTime);
  const totalMs = exitTime.getTime() - entryTime.getTime() - (lunchMinutes * 60000);
  if (totalMs <= 0) return result;

  result.total_worked = Math.round(totalMs / 3600000 * 100) / 100;

  let ordinaryAccumulated = 0;
  const STEP = 15;
  const stepMs = STEP * 60000;
  const current = new Date(entryTime.getTime());
  let remainingLunch = lunchMinutes * 60000;

  while (current < exitTime) {
    const sliceEnd = new Date(Math.min(current.getTime() + stepMs, exitTime.getTime()));
    let sliceMs = sliceEnd - current;

    if (remainingLunch > 0) {
      const deducted = Math.min(sliceMs, remainingLunch);
      remainingLunch -= deducted;
      sliceMs -= deducted;
    }

    if (sliceMs <= 0) { current.setTime(sliceEnd.getTime()); continue; }

    const sliceHours = sliceMs / 3600000;
    const night   = isNightHour(current);
    const sunday  = isSunday(current);
    const holiday = isHoliday(current);
    const isOrdinary = ordinaryAccumulated < maxOrdinary;

    if (isOrdinary) {
      ordinaryAccumulated += sliceHours;
      if (holiday)      result.recargo_festivo   += sliceHours;
      else if (sunday)  result.recargo_dominical += sliceHours;
      else if (night) { result.recargo_nocturno  += sliceHours; result.ordinary_night += sliceHours; }
      else              result.ordinary_day       += sliceHours;
    } else {
      result.total_overtime += sliceHours;
      if (holiday || sunday) {
        if (night) result.overtime_hendf += sliceHours;
        else       result.overtime_hedf  += sliceHours;
      } else {
        if (night) result.overtime_hen += sliceHours;
        else       result.overtime_hed += sliceHours;
      }
    }

    current.setTime(sliceEnd.getTime());
  }

  for (const key of Object.keys(result)) {
    result[key] = Math.round(result[key] * 100) / 100;
  }

  return result;
}

function calculateLateMinutes(markedAt, shiftStart, toleranceMin) {
  toleranceMin = toleranceMin || 5;
  const parts = shiftStart.split(':').map(Number);
  const scheduled = new Date(markedAt);
  scheduled.setHours(parts[0], parts[1], 0, 0);
  const limit = new Date(scheduled.getTime() + toleranceMin * 60000);
  if (markedAt <= limit) return 0;
  return Math.floor((markedAt - scheduled) / 60000);
}

module.exports = {
  isHoliday, isSunday, isSundayOrHoliday,
  maxOrdinaryHoursPerWeek, maxOrdinaryHoursPerDay,
  isNightHour, getSundayHolidaySurcharge,
  calculateHoursBreakdown, calculateLateMinutes,
  HOLIDAYS_2026,
};
