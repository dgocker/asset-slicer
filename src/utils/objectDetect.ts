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

/** Порог отличия пикселя от ЛОКАЛЬНОЙ модели фона (box-blur), см. buildForegroundMask. */
const LOCAL_BG_THRESHOLD = 18;

/** Максимум пикселей, по которым честно считается локальное размытие;
 *  бо́льшие изображения субсэмплируются (blur гладкий — потери нет). */
const LOCAL_BG_MAX_PIXELS = 1 << 21; // ~2 Мп

/**
 * Локальная модель фона: сепарабельный box-blur RGB-каналов через
 * кумулятивные суммы, O(n). Результат — Float32Array длиной w*h*3 (R,G,B).
 */
export function boxBlurRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(n * 3);
  const tmp = new Float32Array(n);
  const prefixRow = new Float64Array(width + 1);
  const prefixCol = new Float64Array(height + 1);

  for (let c = 0; c < 3; c++) {
    // Горизонтальный проход (скользящее среднее через префиксные суммы)
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let acc = 0;
      for (let x = 0; x < width; x++) {
        acc += data[(row + x) * 4 + c];
        prefixRow[x + 1] = acc;
      }
      for (let x = 0; x < width; x++) {
        const x0 = x - radius > 0 ? x - radius : 0;
        const x1 = x + radius < width - 1 ? x + radius : width - 1;
        tmp[row + x] = (prefixRow[x1 + 1] - prefixRow[x0]) / (x1 - x0 + 1);
      }
    }
    // Вертикальный проход
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let y = 0; y < height; y++) {
        acc += tmp[y * width + x];
        prefixCol[y + 1] = acc;
      }
      for (let y = 0; y < height; y++) {
        const y0 = y - radius > 0 ? y - radius : 0;
        const y1 = y + radius < height - 1 ? y + radius : height - 1;
        out[(y * width + x) * 3 + c] = (prefixCol[y1 + 1] - prefixCol[y0]) / (y1 - y0 + 1);
      }
    }
  }
  return out;
}

/**
 * Локальная модель фона изображения: box-blur радиусом
 * max(16, min(w,h)/10). Большие изображения субсэмплируются до ~2 Мп
 * (шаг step), чтобы не раздувать память; blur настолько гладкий, что
 * потери на субсэмпле пренебрежимы. Возвращает размытые каналы + step.
 */
function buildLocalBackground(img: ImageData): {
  blur: Float32Array;
  step: number;
  subW: number;
  subH: number;
} {
  const { data, width, height } = img;
  let step = 1;
  while (Math.ceil(width / step) * Math.ceil(height / step) > LOCAL_BG_MAX_PIXELS) step++;

  const subW = Math.ceil(width / step);
  const subH = Math.ceil(height / step);
  let subData: Uint8ClampedArray;
  if (step === 1) {
    subData = data;
  } else {
    subData = new Uint8ClampedArray(subW * subH * 4);
    for (let sy = 0; sy < subH; sy++) {
      const y = sy * step;
      for (let sx = 0; sx < subW; sx++) {
        const si = (sy * subW + sx) * 4;
        const i = (y * width + sx * step) * 4;
        subData[si] = data[i];
        subData[si + 1] = data[i + 1];
        subData[si + 2] = data[i + 2];
        subData[si + 3] = data[i + 3];
      }
    }
  }

  const radiusFull = Math.max(16, Math.round(Math.min(width, height) / 10));
  const radius = Math.max(1, Math.round(radiusFull / step));
  return { blur: boxBlurRGB(subData, subW, subH, radius), step, subW, subH };
}

/**
 * Строит бинарную fg-маску: пиксель считается объектом, если
 * (1) максимальная поканальная разница с ГЛОБАЛЬНЫМ цветом фона (медиана
 * периметра) превышает threshold И (2) разница с ЛОКАЛЬНОЙ моделью фона
 * (box-blur окрестности) превышает LOCAL_BG_THRESHOLD. Второй критерий
 * убирает «блобы» на градиентных фонах: гладкий градиент почти не
 * отличается от собственного размытия, а настоящий объект резко отличается
 * и от краевого цвета, и от локального фона.
 *
 * ПОБОЧКА: интерьер крупного однотонного объекта ≈ его локальному размытию,
 * поэтому маска может стать «кольцом» — вызывающий код обязан применять
 * заливку дыр (fillMaskHoles; refineForegroundMask делает это сам).
 *
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
  const { blur, step, subW, subH } = buildLocalBackground(img);

  for (let y = 0, p = 0; y < height; y++) {
    const sy = Math.min(subH - 1, (y / step) | 0);
    for (let x = 0; x < width; x++, p++) {
      const i = p * 4;
      if (data[i + 3] < 16) continue; // прозрачный = фон
      const dr = Math.abs(data[i] - bg.r);
      const dg = Math.abs(data[i + 1] - bg.g);
      const db = Math.abs(data[i + 2] - bg.b);
      const maxDiff = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      if (maxDiff <= threshold) continue;

      const bi = (sy * subW + Math.min(subW - 1, (x / step) | 0)) * 3;
      const lr = Math.abs(data[i] - blur[bi]);
      const lg = Math.abs(data[i + 1] - blur[bi + 1]);
      const lb = Math.abs(data[i + 2] - blur[bi + 2]);
      const maxLocal = lr > lg ? (lr > lb ? lr : lb) : (lg > lb ? lg : lb);
      if (maxLocal > LOCAL_BG_THRESHOLD) mask[p] = 1;
    }
  }
  return mask;
}

/**
 * Заливка дыр: flood-fill фоновых пикселей от границ изображения
 * (4-связность); фоновые области, НЕ достижимые от границ (замкнутые внутри
 * fg), переводятся в fg. Нужна после buildForegroundMask: локальный критерий
 * превращает интерьер крупных однотонных объектов в «кольцо».
 * Возвращает новую маску, вход не мутирует.
 */
export function fillMaskHoles(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const reached = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qTail = 0;

  const seed = (p: number) => {
    if (mask[p] === 0 && reached[p] === 0) {
      reached[p] = 1;
      queue[qTail++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  let qHead = 0;
  while (qHead < qTail) {
    const p = queue[qHead++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0 && mask[p - 1] === 0 && reached[p - 1] === 0) { reached[p - 1] = 1; queue[qTail++] = p - 1; }
    if (x < width - 1 && mask[p + 1] === 0 && reached[p + 1] === 0) { reached[p + 1] = 1; queue[qTail++] = p + 1; }
    if (y > 0 && mask[p - width] === 0 && reached[p - width] === 0) { reached[p - width] = 1; queue[qTail++] = p - width; }
    if (y < height - 1 && mask[p + width] === 0 && reached[p + width] === 0) { reached[p + width] = 1; queue[qTail++] = p + width; }
  }

  const out = new Uint8Array(mask);
  for (let p = 0; p < out.length; p++) {
    if (out[p] === 0 && reached[p] === 0) out[p] = 1;
  }
  return out;
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

/** Морфологическое закрытие 5×5 (dilate->erode) + заливка дыр, затем dilate 9×9.
 *  Заливка дыр обязательна: локальный критерий buildForegroundMask оставляет
 *  от крупных однотонных объектов «кольцо» — интерьер восстанавливается здесь. */
export function refineForegroundMask(
  fg: Uint8Array,
  width: number,
  height: number,
): RefinedMasks {
  const closedRaw = erodeBinary(dilateBinary(fg, width, height, 2), width, height, 2);
  const closed = fillMaskHoles(closedRaw, width, height);
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
 * BBox ГЛАВНОГО объекта внутри прямоугольника (координаты маски).
 * «Прилипание» должно липнуть к основному объекту, а не к сумме всего
 * не-фона в окне: перемычки теней между соседями и мелкие блёстки
 * растягивали bbox мимо объекта. Морфологическое размыкание (эрозия r=2)
 * рвёт тонкие мостики и стирает мелочь, берётся крупнейшая связная
 * компонента, восстановленная дилатацией в пределах исходной маски.
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
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return null;

  const sub = new Uint8Array(rw * rh);
  let any = false;
  for (let y = 0; y < rh; y++) {
    const row = (y0 + y) * width;
    for (let x = 0; x < rw; x++) {
      if (mask[row + x0 + x] === 1) {
        sub[y * rw + x] = 1;
        any = true;
      }
    }
  }
  if (!any) return null;

  const eroded = erodeBinary(sub, rw, rh, 2);
  let target = sub;
  let hasEroded = false;
  for (let p = 0; p < eroded.length; p++) if (eroded[p] === 1) { hasEroded = true; break; }
  if (hasEroded) {
    const labels = new Int32Array(rw * rh);
    const queue = new Int32Array(rw * rh);
    let bestLabel = 0, bestArea = 0, n = 0;
    for (let start = 0; start < rw * rh; start++) {
      if (eroded[start] !== 1 || labels[start] !== 0) continue;
      n++;
      labels[start] = n;
      let qh = 0, qt = 0, area = 0;
      queue[qt++] = start;
      while (qh < qt) {
        const p = queue[qh++];
        area++;
        const px = p % rw, py = (p / rw) | 0;
        if (px > 0 && eroded[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = n; queue[qt++] = p - 1; }
        if (px < rw - 1 && eroded[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = n; queue[qt++] = p + 1; }
        if (py > 0 && eroded[p - rw] === 1 && labels[p - rw] === 0) { labels[p - rw] = n; queue[qt++] = p - rw; }
        if (py < rh - 1 && eroded[p + rw] === 1 && labels[p + rw] === 0) { labels[p + rw] = n; queue[qt++] = p + rw; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = n; }
    }
    const main = new Uint8Array(rw * rh);
    for (let p = 0; p < rw * rh; p++) if (labels[p] === bestLabel) main[p] = 1;
    const restored = dilateBinary(main, rw, rh, 3);
    const combined = new Uint8Array(rw * rh);
    let cnt = 0;
    for (let p = 0; p < rw * rh; p++) if (restored[p] === 1 && sub[p] === 1) { combined[p] = 1; cnt++; }
    if (cnt > 0) target = combined;
  }

  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < rh; y++) {
    const row = y * rw;
    for (let x = 0; x < rw; x++) {
      if (target[row + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: x0 + minX, y: y0 + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
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
