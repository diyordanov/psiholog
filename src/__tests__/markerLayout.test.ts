import { describe, it, expect } from 'vitest';
import { computeAutoLayoutSlots, validateMarkerZone, MIN_SLOT_WIDTH, MIN_SLOT_HEIGHT } from '../lib/pdf/markerLayout';

describe('computeAutoLayoutSlots', () => {
  it('разделя зоната на N равни хоризонтални слота, ляво→дясно', () => {
    const slots = computeAutoLayoutSlots({ page: 0, x1: 0, y1: 0, x2: 400, y2: 60 }, 2);
    expect(slots).toHaveLength(2);
    expect(slots[0].x).toBeLessThan(slots[1].x);
    expect(slots[0].height).toBe(60);
    expect(slots[1].height).toBe(60);
  });

  it('слотовете никога не излизат извън зоната (сума ширини + gaps <= zone width)', () => {
    const zone = { page: 0, x1: 30, y1: 30, x2: 565, y2: 90 }; // ~A4 usable width
    for (const count of [1, 2, 3]) {
      const slots = computeAutoLayoutSlots(zone, count);
      const rightmost = slots[slots.length - 1].x + slots[slots.length - 1].width;
      expect(rightmost).toBeLessThanOrEqual(zone.x2);
      expect(slots[0].x).toBeGreaterThanOrEqual(zone.x1);
    }
  });

  it('нормализира произволен ъгъл на правоъгълника (x1>x2, y1>y2)', () => {
    const slots = computeAutoLayoutSlots({ page: 0, x1: 400, y1: 60, x2: 0, y2: 0 }, 1);
    expect(slots[0].x).toBe(0);
    expect(slots[0].y).toBe(0);
    expect(slots[0].width).toBe(400);
  });

  it('count=1 връща един слот, зает целия zone width', () => {
    const slots = computeAutoLayoutSlots({ page: 0, x1: 30, y1: 30, x2: 230, y2: 80 }, 1);
    expect(slots).toHaveLength(1);
    expect(slots[0].width).toBe(200);
  });

  it('count=0 връща празен масив', () => {
    expect(computeAutoLayoutSlots({ page: 0, x1: 0, y1: 0, x2: 100, y2: 50 }, 0)).toEqual([]);
  });
});

describe('validateMarkerZone', () => {
  it('приема достатъчно голяма зона', () => {
    expect(validateMarkerZone({ page: 0, x1: 30, y1: 30, x2: 565, y2: 90 }, 3)).toBeNull();
  });

  it('отхвърля твърде ниска зона', () => {
    const err = validateMarkerZone({ page: 0, x1: 30, y1: 30, x2: 400, y2: 30 + MIN_SLOT_HEIGHT - 1 }, 1);
    expect(err).toMatch(/височина/);
  });

  it('отхвърля твърде тясна зона за броя подписващи', () => {
    const err = validateMarkerZone({ page: 0, x1: 30, y1: 30, x2: 30 + MIN_SLOT_WIDTH * 3 - 10, y2: 90 }, 3);
    expect(err).toMatch(/тясна/);
  });
});
