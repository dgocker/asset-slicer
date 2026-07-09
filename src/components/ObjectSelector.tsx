/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Экран выбора объектов перед ИИ-обработкой: пользователь отмечает рамками
 * объекты на листе (авто / вручную / прилипание), затем каждый объект
 * обрабатывается отдельным кропом, либо весь лист целиком.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wand2,
  Wand,
  MousePointer2,
  Magnet,
  X,
  Loader2,
  Sparkles,
  RefreshCw,
  Layers,
  Trash2,
} from 'lucide-react';
import { Rect, SelectionItem, SelectionMask } from '../types';
import {
  buildForegroundMask,
  refineForegroundMask,
  detectComponentRects,
  foregroundBBoxInRect,
  floodFillComponentMask,
  dilateBinary,
  clampRectToBounds,
} from '../utils/objectDetect';

interface SelectionBox {
  id: string;
  rect: Rect;
  /** Попиксельная маска контура («умное» выделение), в координатах rect. */
  mask?: SelectionMask;
}

type SelectMode = 'auto' | 'manual' | 'snap' | 'smart';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type DragState =
  | { type: 'draw'; startX: number; startY: number }
  | { type: 'move'; boxId: string; startX: number; startY: number; orig: Rect }
  | { type: 'resize'; boxId: string; corner: Corner; orig: Rect }
  | { type: 'tap'; startX: number; startY: number };

interface DetectionMasks {
  closed: Uint8Array;
  grown: Uint8Array;
  width: number;
  height: number;
  /** Пикселей маски на пиксель изображения (<= 1). */
  scale: number;
}

interface ObjectSelectorProps {
  imageSrc: string;
  /**
   * Выделения, с которыми селектор открывается повторно (возврат из галереи).
   * Если заданы — автодетекция при открытии не запускается, чтобы не дублировать рамки.
   */
  initialSelections?: SelectionItem[] | null;
  onCancel: () => void;
  onProcessObjects: (
    selections: SelectionItem[],
    options: { excludeNested: boolean }
  ) => void;
  onProcessWholeSheet: () => void;
}

/**
 * Отрисовка «умного» выделения: полупрозрачная заливка компоненты + обводка
 * по граничным пикселям маски (граница дилатируется для видимой толщины).
 */
function SmartMaskOverlay({
  mask,
  selected,
}: {
  mask: SelectionMask;
  selected: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { data, width, height } = mask;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Граничные пиксели маски (fg с фоновым 4-соседом или на краю)
    const boundary = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        if (data[p] === 0) continue;
        if (
          x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          data[p - 1] === 0 || data[p + 1] === 0 ||
          data[p - width] === 0 || data[p + width] === 0
        ) {
          boundary[p] = 1;
        }
      }
    }
    // Толщина обводки пропорциональна размеру маски (в css она сжимается)
    const strokeR = Math.max(1, Math.round(Math.max(width, height) / 220));
    const stroke = dilateBinary(boundary, width, height, strokeR);

    // violet-400 (выбрано) / emerald-400 (обычное) — как у рамок
    // Только контурная линия СНАРУЖИ объекта — без заливки тела
    // (заливка сбивала с толку: выглядело, будто выделено «всё внутри»)
    const [r, g, b] = selected ? [167, 139, 250] : [52, 211, 153];
    const out = ctx.createImageData(width, height);
    for (let p = 0, i = 0; p < data.length; p++, i += 4) {
      if (stroke[p] === 1) {
        out.data[i] = r;
        out.data[i + 1] = g;
        out.data[i + 2] = b;
        out.data[i + 3] = 235;
      }
    }
    ctx.putImageData(out, 0, 0);
  }, [mask, selected]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

const AUTO_MIN_AREA_PX = 400; // минимальная площадь компоненты (в пикселях изображения)
const AUTO_PADDING_PX = 12; // паддинг вокруг найденного bbox
const SNAP_PADDING_PX = 4; // небольшой отступ после «прилипания»
const SMART_PADDING_PX = 4; // отступ рамки вокруг контура «умного» выделения
// «Воздух» вокруг контура умного выделения (полное разрешение, px):
// пользователь просил не «в облипочку», а с отступом пару миллиметров
const SMART_CONTOUR_BREATHE_PX = 10;
const DETECT_MAX_DIM = 1600; // даунскейл детекции для больших фото

export default function ObjectSelector({
  imageSrc,
  initialSelections,
  onCancel,
  onProcessObjects,
  onProcessWholeSheet,
}: ObjectSelectorProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [boxes, setBoxes] = useState<SelectionBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<SelectMode>('auto');
  const [isDetecting, setIsDetecting] = useState(true);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  // Фича «Исключать вложенные рамки» (в обработке вложенные объекты
  // вырезаются из результата родительской рамки по контуру)
  const [excludeNested, setExcludeNested] = useState(false);
  // Подрежим «Умного» выделения: точный контур или обычная рамка по bbox
  const [smartVariant, setSmartVariant] = useState<'contour' | 'rect'>('contour');
  const smartVariantRef = useRef(smartVariant);
  useEffect(() => {
    smartVariantRef.current = smartVariant;
  }, [smartVariant]);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const masksRef = useRef<DetectionMasks | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftRectRef = useRef<Rect | null>(null);
  const boxCounterRef = useRef(0);
  // Читаем initialSelections через ref, чтобы эффект загрузки не перезапускался
  // при изменении пропа (важен только момент открытия селектора)
  const initialSelectionsRef = useRef<SelectionItem[] | null | undefined>(initialSelections);
  initialSelectionsRef.current = initialSelections;

  const makeBoxId = (prefix: string) =>
    `${prefix}-${Date.now()}-${++boxCounterRef.current}`;

  /** Запускает автодетекцию объектов по fg-маске (с паддингом и клампом). */
  const runAutoDetect = useCallback((replaceAuto = true) => {
    const masks = masksRef.current;
    const img = imageRef.current;
    if (!masks || !img) return;
    setIsDetecting(true);

    // Отдаём кадр браузеру, чтобы спиннер успел отрисоваться
    window.setTimeout(() => {
      try {
        const s = masks.scale;
        const minArea = Math.max(16, Math.round(AUTO_MIN_AREA_PX * s * s));
        const found = detectComponentRects(
          masks.grown,
          masks.width,
          masks.height,
          minArea,
        );
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const rects = found.map((r) =>
          clampRectToBounds(
            {
              x: r.x / s - AUTO_PADDING_PX,
              y: r.y / s - AUTO_PADDING_PX,
              width: r.width / s + AUTO_PADDING_PX * 2,
              height: r.height / s + AUTO_PADDING_PX * 2,
            },
            W,
            H,
          ),
        );
        setBoxes((prev) => {
          const manual = replaceAuto
            ? prev.filter((b) => !b.id.startsWith('auto'))
            : prev;
          const autoBoxes = rects.map((rect) => ({
            id: makeBoxId('auto'),
            rect,
          }));
          return [...autoBoxes, ...manual];
        });
        setSelectedId(null);
      } catch (e) {
        console.warn('Auto object detection failed:', e);
      } finally {
        setIsDetecting(false);
      }
    }, 30);
  }, []);

  // Загрузка изображения и построение fg-масок
  useEffect(() => {
    let active = true;
    setImage(null);
    setBoxes([]);
    setSelectedId(null);
    masksRef.current = null;
    setIsDetecting(true);

    const img = new Image();
    img.onload = () => {
      if (!active) return;
      imageRef.current = img;
      setImage(img);

      // Возврат из галереи: восстанавливаем сохранённые выделения
      // (в т.ч. контурные маски «умного» режима) как пользовательские
      const preset =
        initialSelectionsRef.current && initialSelectionsRef.current.length > 0
          ? initialSelectionsRef.current
          : null;
      if (preset) {
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        setBoxes(
          preset.map((s) => {
            const rect = clampRectToBounds({ ...s.rect }, W, H);
            const mask =
              s.mask && s.mask.width === rect.width && s.mask.height === rect.height
                ? s.mask
                : undefined;
            return {
              id: makeBoxId(mask ? 'smart' : 'user'),
              rect,
              mask,
            };
          }),
        );
      }

      // Строим маски асинхронно, чтобы не блокировать первый рендер
      window.setTimeout(() => {
        if (!active) return;
        try {
          const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
          const scale = Math.min(1, DETECT_MAX_DIM / maxDim);
          const mw = Math.max(1, Math.round(img.naturalWidth * scale));
          const mh = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = mw;
          canvas.height = mh;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('Canvas 2D context unavailable');
          ctx.drawImage(img, 0, 0, mw, mh);
          const imgData = ctx.getImageData(0, 0, mw, mh);

          const fg = buildForegroundMask(imgData, 25);
          const { closed, grown } = refineForegroundMask(fg, mw, mh);
          masksRef.current = {
            closed,
            grown,
            width: mw,
            height: mh,
            scale: mw / img.naturalWidth,
          };
        } catch (e) {
          console.warn('Failed to build detection masks:', e);
          setIsDetecting(false);
          return;
        }
        if (!active) return;
        // При восстановленных рамках автодетекцию не запускаем — иначе дубли
        if (preset) {
          setIsDetecting(false);
        } else {
          runAutoDetect();
        }
      }, 30);
    };
    img.onerror = () => {
      if (!active) return;
      setIsDetecting(false);
    };
    img.src = imageSrc;

    return () => {
      active = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [imageSrc, runAutoDetect]);

  const deleteBox = useCallback((id: string) => {
    setBoxes((prev) => prev.filter((b) => b.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }, []);

  // Удаление выбранной рамки клавишами Delete/Backspace
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selectedId) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteBox(selectedId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, deleteBox]);

  /** Переводит координаты указателя в пиксели изображения. */
  const getImageCoords = (clientX: number, clientY: number) => {
    const overlay = overlayRef.current;
    const img = imageRef.current;
    if (!overlay || !img) return null;
    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * img.naturalWidth;
    const y = ((clientY - rect.top) / rect.height) * img.naturalHeight;
    return {
      x: Math.max(0, Math.min(img.naturalWidth, x)),
      y: Math.max(0, Math.min(img.naturalHeight, y)),
      cssScale: img.naturalWidth / rect.width,
    };
  };

  const normRect = (x1: number, y1: number, x2: number, y2: number): Rect => ({
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  });

  /**
   * «Умный» тап: flood-fill связной fg-компоненты от точки тапа
   * (по grown-маске автодетекции, контур уточняется closed-маской),
   * маска компоненты масштабируется к полному разрешению (nearest).
   * Повторный тап по уже выделенной компоненте снимает выделение.
   */
  const handleSmartTap = useCallback((ptX: number, ptY: number) => {
    const img = imageRef.current;
    if (!img) return;

    // 1. Тап по уже выделенной компоненте — снятие выделения
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (!b.mask) continue;
      const lx = Math.floor(ptX - b.rect.x);
      const ly = Math.floor(ptY - b.rect.y);
      if (
        lx >= 0 && ly >= 0 && lx < b.mask.width && ly < b.mask.height &&
        b.mask.data[ly * b.mask.width + lx] === 1
      ) {
        deleteBox(b.id);
        return;
      }
    }

    const masks = masksRef.current;
    if (!masks) return;
    const s = masks.scale;
    const mx = Math.max(0, Math.min(masks.width - 1, Math.floor(ptX * s)));
    const my = Math.max(0, Math.min(masks.height - 1, Math.floor(ptY * s)));

    // 2. Flood-fill по той же маске, что и автодетекция компонент (grown)
    const comp = floodFillComponentMask(masks.grown, masks.width, masks.height, mx, my);
    if (!comp) return; // тап по фону — ничего не делаем

    // 3. Уточняем контур closed-маской (без «раздутых» краёв grown);
    //    если пересечение пусто — используем саму компоненту
    const refined = new Uint8Array(comp.data.length);
    let refinedCount = 0;
    const bx0 = comp.bbox.x;
    const by0 = comp.bbox.y;
    const bx1 = comp.bbox.x + comp.bbox.width;
    const by1 = comp.bbox.y + comp.bbox.height;
    let minX = bx1, minY = by1, maxX = bx0 - 1, maxY = by0 - 1;
    for (let y = by0; y < by1; y++) {
      const row = y * masks.width;
      for (let x = bx0; x < bx1; x++) {
        const p = row + x;
        if (comp.data[p] === 1 && masks.closed[p] === 1) {
          refined[p] = 1;
          refinedCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const tightMask = refinedCount > 0 ? refined : comp.data;
    const tightBBox: Rect =
      refinedCount > 0
        ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : comp.bbox;

    const W = img.naturalWidth;
    const H = img.naturalHeight;

    // Подрежим «Рамкой»: обычная прямоугольная рамка по bbox компоненты,
    // без маски контура (двигается/ресайзится как нарисованная вручную)
    if (smartVariantRef.current === 'rect') {
      const rectOnly = clampRectToBounds(
        {
          x: tightBBox.x / s - AUTO_PADDING_PX,
          y: tightBBox.y / s - AUTO_PADDING_PX,
          width: tightBBox.width / s + AUTO_PADDING_PX * 2,
          height: tightBBox.height / s + AUTO_PADDING_PX * 2,
        },
        W,
        H,
      );
      const rid = makeBoxId('user');
      setBoxes((prev) => [...prev, { id: rid, rect: rectOnly }]);
      setSelectedId(rid);
      return;
    }

    // Подрежим «Контур»: «воздух» вокруг контура — дилатация на даунскейле
    // (SMART_CONTOUR_BREATHE_PX в полном разрешении)
    const breatheR = Math.max(1, Math.round(SMART_CONTOUR_BREATHE_PX * s));
    const smallMask = dilateBinary(tightMask, masks.width, masks.height, breatheR);
    const smallBBox: Rect = {
      x: Math.max(0, tightBBox.x - breatheR),
      y: Math.max(0, tightBBox.y - breatheR),
      width: Math.min(masks.width - Math.max(0, tightBBox.x - breatheR), tightBBox.width + breatheR * 2),
      height: Math.min(masks.height - Math.max(0, tightBBox.y - breatheR), tightBBox.height + breatheR * 2),
    };

    // 4. Рамка вокруг контура (полное разрешение, с небольшим паддингом)
    const rect = clampRectToBounds(
      {
        x: smallBBox.x / s - SMART_PADDING_PX,
        y: smallBBox.y / s - SMART_PADDING_PX,
        width: smallBBox.width / s + SMART_PADDING_PX * 2,
        height: smallBBox.height / s + SMART_PADDING_PX * 2,
      },
      W,
      H,
    );

    // 5. Маска компоненты в координатах rect, полное разрешение (nearest)
    const data = new Uint8Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y++) {
      const sy = Math.max(0, Math.min(masks.height - 1, Math.floor((rect.y + y + 0.5) * s)));
      const srow = sy * masks.width;
      const drow = y * rect.width;
      for (let x = 0; x < rect.width; x++) {
        const sx = Math.max(0, Math.min(masks.width - 1, Math.floor((rect.x + x + 0.5) * s)));
        data[drow + x] = smallMask[srow + sx];
      }
    }

    const id = makeBoxId('smart');
    setBoxes((prev) => [
      ...prev,
      { id, rect, mask: { data, width: rect.width, height: rect.height } },
    ]);
    setSelectedId(id);
  }, [boxes, deleteBox]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const img = imageRef.current;
    if (!img) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const pt = getImageCoords(e.clientX, e.clientY);
    if (!pt) return;

    // Режим «Умное»: только тапы (обрабатываются на pointerUp),
    // перемещение/ресайз/рисование рамок отключены
    if (mode === 'smart') {
      dragRef.current = { type: 'tap', startX: pt.x, startY: pt.y };
      return;
    }

    // 1. Углы выбранной рамки (ресайз) — контурные выделения не ресайзятся
    const selected = boxes.find((b) => b.id === selectedId && !b.mask);
    if (selected) {
      const threshold = 14 * pt.cssScale; // ~14 css px
      const r = selected.rect;
      const corners: Array<{ corner: Corner; x: number; y: number }> = [
        { corner: 'nw', x: r.x, y: r.y },
        { corner: 'ne', x: r.x + r.width, y: r.y },
        { corner: 'sw', x: r.x, y: r.y + r.height },
        { corner: 'se', x: r.x + r.width, y: r.y + r.height },
      ];
      for (const c of corners) {
        if (Math.abs(pt.x - c.x) <= threshold && Math.abs(pt.y - c.y) <= threshold) {
          dragRef.current = {
            type: 'resize',
            boxId: selected.id,
            corner: c.corner,
            orig: { ...r },
          };
          return;
        }
      }
    }

    // 2. Тело рамки (перемещение) — сверху вниз по z-порядку
    for (let i = boxes.length - 1; i >= 0; i--) {
      const r = boxes[i].rect;
      if (
        pt.x >= r.x &&
        pt.x <= r.x + r.width &&
        pt.y >= r.y &&
        pt.y <= r.y + r.height
      ) {
        setSelectedId(boxes[i].id);
        // Контурное выделение («умное») привязано к пикселям изображения —
        // его нельзя перемещать, только выбрать или удалить
        if (boxes[i].mask) return;
        dragRef.current = {
          type: 'move',
          boxId: boxes[i].id,
          startX: pt.x,
          startY: pt.y,
          orig: { ...r },
        };
        return;
      }
    }

    // 3. Пустое место — рисуем новую рамку
    setSelectedId(null);
    dragRef.current = { type: 'draw', startX: pt.x, startY: pt.y };
    const draft = { x: pt.x, y: pt.y, width: 0, height: 0 };
    draftRectRef.current = draft;
    setDraftRect(draft);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const img = imageRef.current;
    if (!drag || !img) return;
    e.preventDefault();

    const pt = getImageCoords(e.clientX, e.clientY);
    if (!pt) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;

    if (drag.type === 'tap') {
      return; // «умный» тап обрабатывается на pointerUp
    }

    if (drag.type === 'draw') {
      const draft = normRect(drag.startX, drag.startY, pt.x, pt.y);
      draftRectRef.current = draft;
      setDraftRect(draft);
    } else if (drag.type === 'move') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      const nx = Math.max(0, Math.min(W - drag.orig.width, drag.orig.x + dx));
      const ny = Math.max(0, Math.min(H - drag.orig.height, drag.orig.y + dy));
      setBoxes((prev) =>
        prev.map((b) =>
          b.id === drag.boxId
            ? { ...b, rect: { ...b.rect, x: Math.round(nx), y: Math.round(ny) } }
            : b,
        ),
      );
    } else {
      // resize: якорь — противоположный угол
      const o = drag.orig;
      const anchorX = drag.corner === 'nw' || drag.corner === 'sw' ? o.x + o.width : o.x;
      const anchorY = drag.corner === 'nw' || drag.corner === 'ne' ? o.y + o.height : o.y;
      let next = normRect(anchorX, anchorY, pt.x, pt.y);
      next = {
        ...next,
        width: Math.max(4, next.width),
        height: Math.max(4, next.height),
      };
      const clamped = clampRectToBounds(next, W, H);
      setBoxes((prev) =>
        prev.map((b) => (b.id === drag.boxId ? { ...b, rect: clamped } : b)),
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const img = imageRef.current;
    if (!drag || !img) return;
    e.preventDefault();

    if (drag.type === 'tap') {
      // Считаем тапом, если палец почти не сдвинулся (~10 css px)
      const pt = getImageCoords(e.clientX, e.clientY);
      if (!pt) return;
      const threshold = 10 * pt.cssScale;
      if (
        Math.abs(pt.x - drag.startX) <= threshold &&
        Math.abs(pt.y - drag.startY) <= threshold
      ) {
        handleSmartTap(drag.startX, drag.startY);
      }
      return;
    }

    if (drag.type !== 'draw') return;

    const draft = draftRectRef.current;
    draftRectRef.current = null;
    setDraftRect(null);
    if (!draft || draft.width < 6 || draft.height < 6) {
      return; // Простой клик — снятие выделения уже произошло
    }

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    let finalRect = clampRectToBounds(draft, W, H);

    // Режим «Прилипание»: сжимаем грубую рамку к bbox fg-пикселей внутри неё
    if (mode === 'snap') {
      const masks = masksRef.current;
      if (masks) {
        const s = masks.scale;
        const bbox = foregroundBBoxInRect(masks.closed, masks.width, masks.height, {
          x: finalRect.x * s,
          y: finalRect.y * s,
          width: finalRect.width * s,
          height: finalRect.height * s,
        });
        if (bbox) {
          finalRect = clampRectToBounds(
            {
              x: bbox.x / s - SNAP_PADDING_PX,
              y: bbox.y / s - SNAP_PADDING_PX,
              width: bbox.width / s + SNAP_PADDING_PX * 2,
              height: bbox.height / s + SNAP_PADDING_PX * 2,
            },
            W,
            H,
          );
        }
        // Если внутри пусто — рамка остаётся как нарисована
      }
    }

    const id = makeBoxId('user');
    setBoxes((prev) => [...prev, { id, rect: finalRect }]);
    setSelectedId(id);
  };

  const handlePointerCancel = () => {
    dragRef.current = null;
    draftRectRef.current = null;
    setDraftRect(null);
  };

  const W = image?.naturalWidth || 1;
  const H = image?.naturalHeight || 1;
  const pct = (v: number) => `${v * 100}%`;

  const modeButtons: Array<{
    key: SelectMode;
    label: string;
    icon: React.ReactNode;
  }> = [
    { key: 'auto', label: 'Авто', icon: <Wand2 className="w-3.5 h-3.5" /> },
    { key: 'manual', label: 'Вручную', icon: <MousePointer2 className="w-3.5 h-3.5" /> },
    { key: 'snap', label: 'Прилипание', icon: <Magnet className="w-3.5 h-3.5" /> },
    { key: 'smart', label: 'Умное', icon: <Wand className="w-3.5 h-3.5" /> },
  ];

  const modeHint =
    mode === 'auto'
      ? 'Объекты найдены автоматически. Удалите лишние рамки крестиком или добавьте свои перетаскиванием.'
      : mode === 'manual'
        ? 'Нарисуйте рамку перетаскиванием. Перемещайте её за тело, меняйте размер за углы.'
        : mode === 'snap'
          ? 'Нарисуйте грубую рамку вокруг объекта — она автоматически прилипнет к его границам.'
          : 'Коснитесь объекта — он выделится точно по контуру. Повторное касание снимает выделение, касание фона ничего не делает.';

  return (
    <div className="w-full flex flex-col gap-5 mt-2 max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Panel */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-3xl p-4 sm:p-6 flex flex-col gap-5 relative shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-extrabold text-zinc-100 text-base sm:text-lg flex items-center gap-2.5 tracking-tight">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center shadow-md">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              Выбор объектов для ИИ-вырезания
            </h3>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed max-w-xl">
              Каждый отмеченный объект будет вырезан нейросетью отдельным кропом —
              это заметно повышает качество краёв.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="shrink-0 bg-zinc-950/80 hover:bg-zinc-950 hover:text-white backdrop-blur-md border border-zinc-800 text-zinc-400 p-2 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer"
            title="Отмена — загрузить другое изображение"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher & Tools */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid grid-cols-4 gap-1 bg-zinc-950/60 border border-zinc-800 rounded-xl p-1">
            {modeButtons.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  mode === m.key
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'auto' && (
            <button
              onClick={() => runAutoDetect(true)}
              disabled={isDetecting || !masksRef.current}
              className="flex items-center gap-1.5 py-2 px-3.5 bg-zinc-950/60 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95 disabled:opacity-50"
            >
              {isDetecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-violet-400" />
              )}
              Найти объекты снова
            </button>
          )}

          {boxes.length > 0 && (
            <button
              onClick={() => {
                setBoxes([]);
                setSelectedId(null);
              }}
              className="flex items-center gap-1.5 py-2 px-3.5 bg-red-950/15 hover:bg-red-950/30 border border-red-900/30 hover:border-red-800/40 rounded-xl text-xs font-semibold text-red-400 transition-all cursor-pointer active:scale-95"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Очистить всё
            </button>
          )}

          <div className="ml-auto flex items-center gap-2 bg-zinc-950/60 border border-zinc-800/60 rounded-full px-4 py-1.5 text-xs shadow-inner">
            <span className="text-zinc-400 font-medium">Рамок:</span>
            <span className="text-emerald-400 font-bold font-mono">{boxes.length}</span>
          </div>
        </div>

        <p className="text-[11px] text-zinc-400 leading-relaxed -mt-2">{modeHint}</p>

        {/* Подрежим «Умного» выделения: контур или рамка */}
        {mode === 'smart' && (
          <div className="flex items-center gap-2 -mt-1">
            <span className="text-[11px] text-zinc-500 font-medium">Выделять:</span>
            {([
              { key: 'contour', label: 'По контуру' },
              { key: 'rect', label: 'Рамкой' },
            ] as const).map(v => (
              <button
                key={v.key}
                onClick={() => setSmartVariant(v.key)}
                aria-pressed={smartVariant === v.key}
                className={`py-1.5 px-3 rounded-full text-[11px] font-semibold border transition-all cursor-pointer active:scale-95 ${
                  smartVariant === v.key
                    ? 'bg-violet-600/20 border-violet-500/50 text-violet-300'
                    : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}

        {/* Image + overlay */}
        <div className="w-full flex items-center justify-center bg-zinc-950/50 border border-zinc-800/60 rounded-2xl p-4 min-h-[300px] relative overflow-hidden">
          {!image ? (
            <div className="flex flex-col items-center gap-3 text-zinc-400 py-16">
              <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
              <span className="text-xs font-semibold">Загрузка изображения...</span>
            </div>
          ) : (
            <div
              className="relative inline-block max-w-full select-none"
              style={{ touchAction: 'none' }}
            >
              <img
                src={imageSrc}
                alt="Лист с объектами"
                draggable={false}
                className="block max-w-full max-h-[480px] w-auto h-auto border border-zinc-800 shadow-2xl select-none pointer-events-none"
              />

              {/* Interaction overlay */}
              <div
                ref={overlayRef}
                className="absolute inset-0 cursor-crosshair"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
              >
                {boxes.map((box, idx) => {
                  const isSelected = box.id === selectedId;
                  const r = box.rect;
                  return (
                    <div
                      key={box.id}
                      className={`absolute pointer-events-none rounded-[3px] ${
                        box.mask
                          ? isSelected
                            ? 'z-20'
                            : 'z-10'
                          : isSelected
                            ? 'border-2 border-violet-400 bg-violet-500/10 shadow-[0_0_12px_rgba(167,139,250,0.35)] z-20'
                            : 'border-2 border-emerald-400/90 bg-emerald-400/5 z-10'
                      }`}
                      style={{
                        left: pct(r.x / W),
                        top: pct(r.y / H),
                        width: pct(r.width / W),
                        height: pct(r.height / H),
                      }}
                    >
                      {/* Контурная подсветка «умного» выделения */}
                      {box.mask && (
                        <SmartMaskOverlay mask={box.mask} selected={isSelected} />
                      )}

                      {/* Number badge */}
                      <span
                        className={`absolute -top-2.5 -left-2.5 min-w-5 h-5 px-1 rounded-full text-[10px] font-extrabold font-mono flex items-center justify-center text-white shadow-md ${
                          isSelected ? 'bg-violet-500' : 'bg-emerald-500'
                        }`}
                      >
                        {idx + 1}
                      </span>

                      {/* Delete cross */}
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteBox(box.id);
                        }}
                        className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full bg-red-500 hover:bg-red-400 text-white flex items-center justify-center shadow-md transition-all active:scale-90 cursor-pointer pointer-events-auto"
                        title="Удалить рамку"
                      >
                        <X className="w-3 h-3" />
                      </button>

                      {/* Corner resize handles (visual, hit-test is in overlay) */}
                      {isSelected && !box.mask && (
                        <>
                          <span className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-white border-2 border-violet-500 rounded-sm shadow" />
                          <span className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-white border-2 border-violet-500 rounded-sm shadow" />
                          <span className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-white border-2 border-violet-500 rounded-sm shadow" />
                          <span className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-white border-2 border-violet-500 rounded-sm shadow" />
                        </>
                      )}
                    </div>
                  );
                })}

                {/* Draft rect while drawing */}
                {draftRect && draftRect.width > 0 && draftRect.height > 0 && (
                  <div
                    className="absolute border-2 border-dashed border-emerald-400 bg-emerald-400/10 rounded-[3px] pointer-events-none z-30"
                    style={{
                      left: pct(draftRect.x / W),
                      top: pct(draftRect.y / H),
                      width: pct(draftRect.width / W),
                      height: pct(draftRect.height / H),
                    }}
                  />
                )}
              </div>

              {/* Detecting overlay badge */}
              {isDetecting && (
                <div className="absolute top-3 left-3 z-30 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 px-3 py-1.5 rounded-full flex items-center gap-2 text-xs font-semibold text-zinc-300 pointer-events-none">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                  Поиск объектов...
                </div>
              )}
            </div>
          )}
        </div>

        {/* Exclude nested selections toggle */}
        <div className="flex items-center justify-between gap-3 bg-zinc-950/40 border border-zinc-800/70 rounded-2xl px-4 py-3">
          <div className="flex flex-col gap-0.5 pr-2">
            <span className="text-xs font-bold text-zinc-200">
              Исключать вложенные рамки
            </span>
            <p className="text-[10.5px] text-zinc-400 leading-relaxed">
              Объекты, попавшие внутрь другой рамки, будут вырезаны из её результата по контуру.
            </p>
          </div>
          <button
            onClick={() => setExcludeNested((v) => !v)}
            type="button"
            aria-pressed={excludeNested}
            className={`w-11 h-6.5 flex items-center rounded-full p-1 transition-all duration-300 shrink-0 cursor-pointer ${
              excludeNested
                ? 'bg-violet-600 shadow-[0_0_10px_rgba(124,58,237,0.3)] justify-end'
                : 'bg-zinc-800 justify-start'
            }`}
            title="Исключать вложенные рамки из результата родительской"
          >
            <span className="w-4.5 h-4.5 rounded-full bg-white shadow-md transition-all duration-300" />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-3 pt-1">
          <button
            onClick={() =>
              onProcessObjects(
                boxes.map((b) => ({ rect: { ...b.rect }, mask: b.mask })),
                { excludeNested },
              )
            }
            disabled={boxes.length === 0 || !image}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 px-6 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-2xl font-bold text-sm transition-all duration-300 shadow-[0_4px_12px_rgba(124,58,237,0.25)] hover:shadow-[0_4px_20px_rgba(124,58,237,0.4)] active:scale-[0.98] cursor-pointer disabled:cursor-not-allowed"
          >
            <Sparkles className="w-4 h-4" />
            Обработать ({boxes.length})
          </button>
          <button
            onClick={onProcessWholeSheet}
            disabled={!image}
            className="flex items-center justify-center gap-2 py-3.5 px-6 bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white rounded-2xl font-bold text-sm transition-all duration-300 shadow-md active:scale-[0.98] cursor-pointer disabled:opacity-50"
          >
            <Layers className="w-4 h-4" />
            Весь лист (без нарезки)
          </button>
        </div>
      </div>
    </div>
  );
}
