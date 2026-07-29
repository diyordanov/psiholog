/**
 * markerLayout.ts
 * Auto-layout за подписващи маркери в multi-signer flow (Ден 6 hotfix v3).
 *
 * Замества по-стария UI, в който owner-ът кликва ОТДЕЛНО позиция за всеки
 * участник (риск: фиксирана 200pt ширина × N участници лесно излиза извън
 * страницата). Вместо това owner-ът очертава ЕДНА обща зона (drag
 * правоъгълник) върху PDF thumbnail-а; computeAutoLayoutSlots() я разделя
 * на N равни хоризонтални слота (по един на участник), с ширина/височина
 * съобразени със самата зона — по дефиниция не могат да излязат извън нея.
 */

export interface MarkerZone {
  page: number;
  /** Произволен ъгъл на правоъгълника (в PDF points) — редът няма значение, нормализира се вътрешно. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MarkerSlot {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Минимални размери за четимост на 4-редовия текст в маркера (виж pdfSigner.ts). */
export const MIN_SLOT_WIDTH = 120;
export const MIN_SLOT_HEIGHT = 50;
/** Хоризонтална междина между слотовете, в PDF points. */
const SLOT_GAP = 8;

/**
 * Разделя правоъгълна зона на `count` равни хоризонтални слота (ляво→дясно).
 * Слотовете НИКОГА не излизат извън подадената зона — самата зона е
 * ограничена от owner-ския drag жест върху видимата страница, затова
 * резултатът по дефиниция остава в границите на страницата.
 */
export function computeAutoLayoutSlots(zone: MarkerZone, count: number): MarkerSlot[] {
  if (count < 1) return [];

  const left   = Math.min(zone.x1, zone.x2);
  const right  = Math.max(zone.x1, zone.x2);
  const bottom = Math.min(zone.y1, zone.y2);
  const top    = Math.max(zone.y1, zone.y2);

  const zoneWidth  = right - left;
  const zoneHeight = top - bottom;
  const totalGap   = SLOT_GAP * (count - 1);
  const slotWidthExact = (zoneWidth - totalGap) / count;

  // Закръгляме кумулативно (границите на слотовете, не независимо всяка
  // ширина) — независимото Math.round() на всеки слот поотделно може да
  // натрупа грешка от закръгляне и последният слот да "изтече" извън зоната
  // с 1pt (напр. 263.5 → 264 два пъти = +1pt отгоре при count=2).
  const slots: MarkerSlot[] = [];
  let cursor = left;
  for (let i = 0; i < count; i++) {
    const xStart = Math.round(cursor);
    const xEnd   = Math.round(cursor + slotWidthExact);
    slots.push({
      page: zone.page,
      x: xStart,
      y: Math.round(bottom),
      width: xEnd - xStart,
      height: Math.round(zoneHeight),
    });
    cursor += slotWidthExact + SLOT_GAP;
  }
  return slots;
}

/**
 * Валидира дали зоната е достатъчно голяма за `count` четими слота (виж
 * MIN_SLOT_WIDTH/MIN_SLOT_HEIGHT). Връща error текст или null (валидна).
 */
export function validateMarkerZone(zone: MarkerZone, count: number): string | null {
  const zoneWidth  = Math.abs(zone.x2 - zone.x1);
  const zoneHeight = Math.abs(zone.y2 - zone.y1);
  const totalGap   = SLOT_GAP * (count - 1);
  const slotWidth  = (zoneWidth - totalGap) / count;

  if (zoneHeight < MIN_SLOT_HEIGHT) {
    return `Зоната е твърде ниска — начертайте поне ${MIN_SLOT_HEIGHT}pt височина.`;
  }
  if (slotWidth < MIN_SLOT_WIDTH) {
    return `Зоната е твърде тясна за ${count} ${count === 1 ? 'подпис' : 'подписа'} — начертайте по-широка зона (нужни поне ${Math.round(MIN_SLOT_WIDTH * count + totalGap)}pt).`;
  }
  return null;
}
