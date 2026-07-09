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

/** Готовый ассет потока «по объектам»: результат ИИ-вырезания одной рамки. */
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
  /** Смещение обрезанного результата внутри исходной рамки rect (после trim), px. */
  offsetX?: number;
  offsetY?: number;
  /**
   * Ассет был кадрирован/повёрнут/ресайзнут в редакторе и сохранён:
   * привязка rect+offset к оригинальному листу потеряна, кисть
   * «Восстановить» при повторном открытии редактора блокируется.
   */
  restoreDisabled?: boolean;
}

export interface ColorRGB {
  r: number;
  g: number;
  b: number;
}
