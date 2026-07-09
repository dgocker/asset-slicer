/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Утилиты автодетекции объектов на листе: оценка цвета фона,
 * fg-маска, бинарная морфология и связные компоненты.
 * Рассчитано на работу с масками 1-2 Мп (< 1с).
 */

import { Rect, ColorRGB } from '../types';

/**
 * Оценивает цвет фона как помедианный цвет пикселей рамки изображения
 * (полоса шириной 2px по периметру).
 */
export function estimateBackgroundColor(img: ImageData): ColorRGB {
  const { data, width, height } = img;
  const band = Math.max(1, Math.min(2, Math.floor(Math.min(width, height) / 2)));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };

  for (let y = 0; y < height; y++) {
    if (y < band || y >= height - band) {
      for (let x = 0; x < width; x++) push(x, y);
    } else {
      for (let x = 0; x < band; x++) push(x, y);
      for (let x = Math.max(band, width - band); x < width; x++) push(x, y);
    }
  }

  const median = (arr: number[]): number => {
    arr.sort((a, b) => a - b);
    return arr.length > 0 ? arr[arr.length >> 1] : 255;
  };

  return { r: median(rs), g: median(gs), b: median(bs) };
}

/**
 * Строит бинарную fg-маску: пиксель считается объектом, если
 * максимальная поканальная разница с цветом фона превышает threshold.
 * Полностью прозрачные пиксели считаются фоном.
 * Цвет фона можно передать явно (bgOverride) — например, оценку по
 * периметру всего листа для маски внутри отдельной рамки.
 */
export function buildForegroundMask(
  img: ImageData,
  threshold = 25,
  bgOverride?: ColorRGB,
): Uint8Array {
  const bg = bgOverride || estimateBackgroundColor(img);
  const { data, width, height } = img;
  const mask = new Uint8Array(width * height);

  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (data[i + 3] < 16) continue; // прозрачный = фон
    const dr = Math.abs(data[i] - bg.r);
    const dg = Math.abs(data[i + 1] - bg.g);
    const db = Math.abs(data[i + 2] - bg.b);
    const maxDiff = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    if (maxDiff > threshold) mask[p] = 1;
  }
  return mask;
}

/**
 * Бинарная дилатация квадратным ядром (2*radius+1)^2.
 * Сепарабельная реализация со скользящим окном — O(N) на проход.
 */
export function dilateBinary(
  src: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const tmp = new Uint8Array(width * height);

  // Горизонтальный проход
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    const initEnd = Math.min(radius, width - 1);
    for (let x = 0; x <= initEnd; x++) count += src[row + x];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      const addX = x + radius + 1;
      if (addX < width) count += src[row + addX];
      const remX = x - radius;
      if (remX >= 0) count -= src[row + remX];
    }
  }

  // Вертикальный проход
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let count = 0;
    const initEnd = Math.min(radius, height - 1);
    for (let y = 0; y <= initEnd; y++) count += tmp[y * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = count > 0 ? 1 : 0;
      const addY = y + radius + 1;
      if (addY < height) count += tmp[addY * width + x];
      const remY = y - radius;
      if (remY >= 0) count -= tmp[remY * width + x];
    }
  }
  return out;
}

/** Бинарная эрозия через инверсию + дилатацию (за границей — «объект»). */
export function erodeBinary(
  src: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) inv[i] = src[i] ? 0 : 1;
  const dilated = dilateBinary(inv, width, height, radius);
  for (let i = 0; i < dilated.length; i++) dilated[i] = dilated[i] ? 0 : 1;
  return dilated;
}

export interface RefinedMasks {
  /** После морфологического закрытия 5×5 — для «прилипания» рамок. */
  closed: Uint8Array;
  /** После закрытия + дилатации 9×9 (склейка частей объекта) — для компонент. */
  grown: Uint8Array;
}

/** Морфологическое закрытие 5×5 (dilate->erode), затем dilate 9×9. */
export function refineForegroundMask(
  fg: Uint8Array,
  width: number,
  height: number,
): RefinedMasks {
  const closed = erodeBinary(dilateBinary(fg, width, height, 2), width, height, 2);
  const grown = dilateBinary(closed, width, height, 4);
  return { closed, grown };
}

/**
 * Связные компоненты (BFS по Uint8Array, 4-связность).
 * Возвращает bbox компонент площадью >= minArea (в координатах маски, без паддинга).
 */
export function detectComponentRects(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
  maxComponents = 128,
): Rect[] {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const rects: Rect[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue;

    let qHead = 0;
    let qTail = 0;
    visited[start] = 1;
    queue[qTail++] = start;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const n = idx - 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
    }

    if (area >= minArea) {
      rects.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
      if (rects.length >= maxComponents) break;
    }
  }
  return rects;
}

/**
 * BBox fg-пикселей внутри прямоугольника (координаты маски).
 * Возвращает null, если внутри нет ни одного fg-пикселя.
 */
export function foregroundBBoxInRect(
  mask: Uint8Array,
  width: number,
  height: number,
  rect: Rect,
): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));

  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;

  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      if (mask[row + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Flood-fill связной компоненты (4-связность) от точки (seedX, seedY).
 * Возвращает бинарную маску компоненты (в размерах исходной маски) и её bbox,
 * либо null, если точка не принадлежит fg.
 */
export function floodFillComponentMask(
  mask: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): { data: Uint8Array; bbox: Rect } | null {
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const start = sy * width + sx;
  if (mask[start] === 0) return null;

  const component = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0;
  let qTail = 0;
  component[start] = 1;
  queue[qTail++] = start;

  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    if (x > 0) {
      const n = idx - 1;
      if (mask[n] === 1 && component[n] === 0) {
        component[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (x < width - 1) {
      const n = idx + 1;
      if (mask[n] === 1 && component[n] === 0) {
        component[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y > 0) {
      const n = idx - width;
      if (mask[n] === 1 && component[n] === 0) {
        component[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y < height - 1) {
      const n = idx + width;
      if (mask[n] === 1 && component[n] === 0) {
        component[n] = 1;
        queue[qTail++] = n;
      }
    }
  }

  return {
    data: component,
    bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/** Кламп прямоугольника в границы изображения W×H (целочисленный). */
export function clampRectToBounds(r: Rect, W: number, H: number): Rect {
  const x = Math.max(0, Math.min(Math.round(r.x), W - 1));
  const y = Math.max(0, Math.min(Math.round(r.y), H - 1));
  const width = Math.max(1, Math.min(Math.round(r.width), W - x));
  const height = Math.max(1, Math.min(Math.round(r.height), H - y));
  return { x, y, width, height };
}
