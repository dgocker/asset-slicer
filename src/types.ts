/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Бинарная маска выделения в координатах rect (полное разрешение листа):
 * data[y * width + x] === 1 — пиксель принадлежит объекту.
 */
export interface SelectionMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Одно выделение на экране выбора объектов. Режимы «Авто»/«Вручную»/
 * «Прилипание» дают только rect; режим «Умное» добавляет попиксельную
 * маску контура компоненты (mask в координатах rect).
 */
export interface SelectionItem {
  rect: Rect;
  mask?: SelectionMask;
}

export interface Slice {
  id: string;
  rect: Rect;
  label: string;
}

/** Готовый ассет нового потока «по объектам»: результат ИИ-вырезания одной рамки. */
export interface ObjectAsset {
  id: string;
  label: string;
  rect: Rect;
  /** Итоговые PNG-байты (после обрезки прозрачных полей) — для скачивания. */
  blob: Blob | null;
  /** objectURL того же blob — для показа в галерее. */
  displayUrl: string | null;
  width: number;
  height: number;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
  /** Пометка о нестандартном пути обработки (например, вырез по цвету фона без ИИ). */
  note?: string;
  /** Индекс выделения в списке последнего прогона — для повтора с тем же контекстом. */
  selectionIndex?: number;
}

export interface ColorRGB {
  r: number;
  g: number;
  b: number;
}

export type SVGMode = 'silhouette' | 'color' | 'embedded';

export interface ProcessedAsset {
  id: string;
  name: string;
  rect: Rect;
  pngDataUrl: string;
  rasterDataUrl?: string;
  rasterFormat?: 'webp' | 'png';
  width: number;
  height: number;
  svgMode: SVGMode;
  svgCode: string;
  silhouetteSvg: string;
  colorSvg: string;
  embeddedSvg: string;
  dominantColor: string;
  tags: string[];
}

export interface AppState {
  originalImage: string | null; // DataURL of uploaded image
  imageWidth: number;
  imageHeight: number;
  transparentColor: ColorRGB | null;
  tolerance: number;
  mergeDistance: number;
  minSize: number;
  padding: number;
  slices: Slice[];
  selectedSliceId: string | null;
  processedAssets: ProcessedAsset[];
  isProcessing: boolean;
  brushMode: 'none' | 'erase' | 'restore';
  brushSize: number;
}
