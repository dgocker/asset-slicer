/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Экран «Редактор ассета»: ручная доводка вырезанного ассета.
 * Кисти «Ластик»/«Восстановить» (пиксели оригинального листа), кадрирование,
 * поворот 90°, изменение размера с залоченной пропорцией и экспорт PNG/WebP
 * с живой оценкой веса файла. Мобайл-first: пинч-зум, пан, круглый курсор кисти.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eraser,
  Paintbrush,
  Hand,
  Crop,
  RotateCw,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  X,
  Save,
  Loader2,
} from 'lucide-react';

interface AssetEditorProps {
  asset: {
    id: string;
    label: string;
    rect: { x: number; y: number; width: number; height: number };
    blob: Blob;
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
    /** Привязка к оригинальному листу уже потеряна прошлым сохранением (кроп/поворот/ресайз). */
    restoreDisabled?: boolean;
  };
  /** dataURL полного листа — источник для кисти «Восстановление». */
  originalImageSrc: string;
  onSave: (
    id: string,
    result: { blob: Blob; displayUrl: string; width: number; height: number; transformed: boolean }
  ) => void;
  onClose: () => void;
}

type Tool = 'erase' | 'restore' | 'pan' | 'crop';

interface Snapshot {
  data: ImageData;
  transformed: boolean;
}

interface Pt {
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const UNDO_LIMIT = 15;
/** Минимум хранимых шагов undo — даже для гигантских холстов. */
const UNDO_MIN = 2;
/**
 * Бюджет памяти истории undo: снапшоты — полноразмерные ImageData
 * (12 МП лист ≈ 48 МБ штука), 15 штук уронили бы мобильный WebView по OOM,
 * поэтому фактический лимит масштабируется от размера холста.
 */
const UNDO_MEMORY_BUDGET_BYTES = 160 * 1024 * 1024;

/** CSS-шахматка под холстом (та же техника 4 linear-gradient, что в AssetGallery). */
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: '#27272a',
  backgroundImage:
    'linear-gradient(45deg, #3f3f46 25%, transparent 25%), linear-gradient(-45deg, #3f3f46 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #3f3f46 75%), linear-gradient(-45deg, transparent 75%, #3f3f46 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
};

const canvasToBlob = (canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));

/**
 * Качественный ресайз: даунскейл ступенчато (пополам за шаг до цели, затем финальный
 * штрих), апскейл — одним шагом с imageSmoothingQuality = 'high'.
 */
const renderResized = (src: HTMLCanvasElement, targetW: number, targetH: number): HTMLCanvasElement => {
  let cur = src;
  while (cur.width / 2 >= targetW && cur.height / 2 >= targetH) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.floor(cur.width / 2));
    half.height = Math.max(1, Math.floor(cur.height / 2));
    const hctx = half.getContext('2d')!;
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  if (cur.width === targetW && cur.height === targetH && cur !== src) return cur;
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, targetW, targetH);
  return out;
};

const AssetEditor: React.FC<AssetEditorProps> = ({ asset, originalImageSrc, onSave, onClose }) => {
  // ---------- DOM / рабочие холсты ----------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  /** Рабочий холст в натуральном разрешении ассета — кисти и трансформации мутируют его. */
  const workRef = useRef<HTMLCanvasElement | null>(null);
  /** Заранее вырезанный фрагмент оригинального листа размером с ассет — источник «Восстановления». */
  const origFragRef = useRef<HTMLCanvasElement | null>(null);

  // ---------- Вид (зум/пан) ----------
  const viewRef = useRef({ scale: 1, x: 0, y: 0 });
  const fittedRef = useRef(false);
  const [zoomPct, setZoomPct] = useState(100);

  // ---------- Указатели / жесты ----------
  const pointersRef = useRef(new Map<number, Pt>());
  const strokeRef = useRef<{ last: Pt } | null>(null);
  const cropDragRef = useRef<{ sx: number; sy: number } | null>(null);
  const cropRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // ---------- Состояние редактора ----------
  const [ready, setReady] = useState(false);
  const [origReady, setOrigReady] = useState(false);
  const [tool, setTool] = useState<Tool>('erase');
  const toolRef = useRef<Tool>('erase');
  const [brushSize, setBrushSize] = useState(24);
  const brushSizeRef = useRef(24);
  // Если прошлое сохранение уже сломало привязку к листу (кроп/поворот/ресайз),
  // «Восстановить» заблокировано с самого открытия — иначе кисть рисовала бы
  // смещённые/чужие пиксели оригинала по устаревшим rect+offset.
  const [transformed, setTransformed] = useState(!!asset.restoreDisabled);
  const transformedRef = useRef(!!asset.restoreDisabled);
  const dirtyRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [hasCrop, setHasCrop] = useState(false);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  /** Инкремент после каждой правки холста — триггер пересчёта веса файла. */
  const [revision, setRevision] = useState(0);

  // ---------- Размер и экспорт ----------
  const [natural, setNatural] = useState({ w: asset.width, h: asset.height });
  const [exportW, setExportW] = useState(String(asset.width));
  const [exportH, setExportH] = useState(String(asset.height));
  const [format, setFormat] = useState<'png' | 'webp'>('png');
  const [quality, setQuality] = useState(85);
  const [estBytes, setEstBytes] = useState<number | null>(null);
  const [estBusy, setEstBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);

  // ---------- Отрисовка видимого холста ----------
  const redraw = useCallback(() => {
    const cvs = viewCanvasRef.current;
    const work = workRef.current;
    if (!cvs || !work) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const v = viewRef.current;
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x, dpr * v.y);
    ctx.imageSmoothingEnabled = v.scale < 3;
    ctx.drawImage(work, 0, 0);

    // Рамка кадрирования: затемнение снаружи + фиолетовый контур
    const cr = cropRectRef.current;
    if (toolRef.current === 'crop' && cr && cr.w > 0 && cr.h > 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(9, 9, 11, 0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, work.width, work.height);
      ctx.rect(cr.x, cr.y, cr.w, cr.h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2 / v.scale;
      ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
      ctx.restore();
    }
  }, []);

  const fitView = useCallback(() => {
    const cont = containerRef.current;
    const work = workRef.current;
    if (!cont || !work || cont.clientWidth === 0) return;
    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    const scale = clamp(Math.min(cw / work.width, ch / work.height) * 0.92, MIN_SCALE, MAX_SCALE);
    viewRef.current = {
      scale,
      x: (cw - work.width * scale) / 2,
      y: (ch - work.height * scale) / 2,
    };
    setZoomPct(Math.round(scale * 100));
    redraw();
  }, [redraw]);

  // ---------- Загрузка ассета и фрагмента оригинала ----------
  useEffect(() => {
    let cancelled = false;

    const url = URL.createObjectURL(asset.blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (cancelled) return;
      const work = document.createElement('canvas');
      work.width = img.naturalWidth;
      work.height = img.naturalHeight;
      work.getContext('2d')!.drawImage(img, 0, 0);
      workRef.current = work;
      setNatural({ w: work.width, h: work.height });
      setExportW(String(work.width));
      setExportH(String(work.height));
      setReady(true);
      if (!fittedRef.current) {
        fittedRef.current = true;
        fitView();
      }
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;

    // Фрагмент оригинала: пиксель ассета (px, py) ↔ оригинал (rect.x + offsetX + px, rect.y + offsetY + py)
    const orig = new Image();
    orig.onload = () => {
      if (cancelled) return;
      const frag = document.createElement('canvas');
      frag.width = asset.width;
      frag.height = asset.height;
      frag.getContext('2d')!.drawImage(
        orig,
        asset.rect.x + (asset.offsetX ?? 0),
        asset.rect.y + (asset.offsetY ?? 0),
        asset.width,
        asset.height,
        0,
        0,
        asset.width,
        asset.height,
      );
      origFragRef.current = frag;
      setOrigReady(true);
    };
    orig.src = originalImageSrc;

    return () => {
      cancelled = true;
    };
    // Ассет фиксирован на время жизни редактора
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Размер видимого холста под контейнер ----------
  useEffect(() => {
    const cont = containerRef.current;
    const cvs = viewCanvasRef.current;
    if (!cont || !cvs) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      cvs.width = Math.max(1, Math.round(cont.clientWidth * dpr));
      cvs.height = Math.max(1, Math.round(cont.clientHeight * dpr));
      cvs.style.width = `${cont.clientWidth}px`;
      cvs.style.height = `${cont.clientHeight}px`;
      if (!fittedRef.current && workRef.current) {
        fittedRef.current = true;
        fitView();
      } else {
        redraw();
      }
    });
    ro.observe(cont);
    return () => ro.disconnect();
  }, [fitView, redraw]);

  // ---------- Зум колесом (non-passive, чтобы preventDefault работал) ----------
  const zoomAt = useCallback(
    (point: Pt, factor: number) => {
      const v = viewRef.current;
      const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const ix = (point.x - v.x) / v.scale;
      const iy = (point.y - v.y) / v.scale;
      v.x = point.x - ix * ns;
      v.y = point.y - iy * ns;
      v.scale = ns;
      setZoomPct(Math.round(ns * 100));
      redraw();
    },
    [redraw],
  );

  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cont.getBoundingClientRect();
      zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    cont.addEventListener('wheel', onWheel, { passive: false });
    return () => cont.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Смена инструмента: сбрасываем незавершённое кадрирование
  useEffect(() => {
    if (tool !== 'crop') {
      cropRectRef.current = null;
      cropDragRef.current = null;
      setHasCrop(false);
      redraw();
    }
  }, [tool, redraw]);

  // ---------- Undo / Redo ----------
  const refreshHistoryFlags = () => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  };

  const takeSnapshot = (): Snapshot | null => {
    const work = workRef.current;
    if (!work) return null;
    return {
      data: work.getContext('2d')!.getImageData(0, 0, work.width, work.height),
      transformed: transformedRef.current,
    };
  };

  const pushUndo = () => {
    const snap = takeSnapshot();
    if (!snap) return;
    const list = undoRef.current;
    list.push(snap);
    // Жёсткий потолок по числу шагов + бюджет памяти (см. UNDO_MEMORY_BUDGET_BYTES)
    while (list.length > UNDO_LIMIT) list.shift();
    let totalBytes = list.reduce((acc, s) => acc + s.data.data.byteLength, 0);
    while (list.length > UNDO_MIN && totalBytes > UNDO_MEMORY_BUDGET_BYTES) {
      totalBytes -= list.shift()!.data.data.byteLength;
    }
    redoRef.current = [];
    refreshHistoryFlags();
  };

  const applySnapshot = (snap: Snapshot) => {
    const work = workRef.current;
    if (!work) return;
    const dimsChanged = work.width !== snap.data.width || work.height !== snap.data.height;
    work.width = snap.data.width;
    work.height = snap.data.height;
    work.getContext('2d')!.putImageData(snap.data, 0, 0);
    transformedRef.current = snap.transformed;
    setTransformed(snap.transformed);
    if (dimsChanged) {
      setNatural({ w: work.width, h: work.height });
      setExportW(String(work.width));
      setExportH(String(work.height));
      fitView();
    }
    dirtyRef.current = true;
    setRevision((r) => r + 1);
    redraw();
  };

  const handleUndo = () => {
    const snap = undoRef.current.pop();
    if (!snap) return;
    const cur = takeSnapshot();
    if (cur) redoRef.current.push(cur);
    applySnapshot(snap);
    refreshHistoryFlags();
  };

  const handleRedo = () => {
    const snap = redoRef.current.pop();
    if (!snap) return;
    const cur = takeSnapshot();
    if (cur) undoRef.current.push(cur);
    applySnapshot(snap);
    refreshHistoryFlags();
  };

  // ---------- Кисти ----------
  const stampSegment = (a: Pt, b: Pt) => {
    const work = workRef.current;
    if (!work) return;
    const ctx = work.getContext('2d')!;
    const r = Math.max(0.5, brushSizeRef.current / 2);

    if (toolRef.current === 'erase') {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = r * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // «Восстановить»: клип из кружков вдоль отрезка, очистка и подстановка пикселей оригинала
    const frag = origFragRef.current;
    if (!frag) return;
    ctx.save();
    ctx.beginPath();
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(d / Math.max(1, r * 0.4)));
    for (let i = 0; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.clip();
    const minX = Math.floor(Math.min(a.x, b.x) - r - 1);
    const minY = Math.floor(Math.min(a.y, b.y) - r - 1);
    const bw = Math.ceil(Math.abs(b.x - a.x) + r * 2 + 2);
    const bh = Math.ceil(Math.abs(b.y - a.y) + r * 2 + 2);
    ctx.clearRect(minX, minY, bw, bh);
    ctx.drawImage(frag, 0, 0);
    ctx.restore();
  };

  // ---------- Координаты ----------
  const getPos = (e: React.PointerEvent): Pt => {
    const rect = (viewCanvasRef.current ?? e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const toImage = (p: Pt): Pt => {
    const v = viewRef.current;
    return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
  };

  const updateCursorPreview = (p: Pt | null) => {
    const cur = cursorRef.current;
    if (!cur) return;
    const isBrush = toolRef.current === 'erase' || toolRef.current === 'restore';
    if (!p || !isBrush) {
      cur.style.display = 'none';
      return;
    }
    const size = brushSizeRef.current * viewRef.current.scale;
    cur.style.display = 'block';
    cur.style.width = `${size}px`;
    cur.style.height = `${size}px`;
    cur.style.left = `${p.x - size / 2}px`;
    cur.style.top = `${p.y - size / 2}px`;
  };

  // ---------- Жесты ----------
  const commitEdit = () => {
    dirtyRef.current = true;
    setRevision((r) => r + 1);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = getPos(e);
    pointersRef.current.set(e.pointerId, pos);

    if (pointersRef.current.size === 2) {
      // Второй палец: любой инструмент уступает пинчу/пану
      if (strokeRef.current) {
        strokeRef.current = null;
        commitEdit();
      }
      cropDragRef.current = null;
      updateCursorPreview(null);
      return;
    }
    if (pointersRef.current.size > 2) return;

    const t = toolRef.current;
    if (t === 'pan') return; // движение обрабатывается в pointermove
    if (t === 'crop') {
      const img = toImage(pos);
      const work = workRef.current!;
      cropDragRef.current = {
        sx: clamp(img.x, 0, work.width),
        sy: clamp(img.y, 0, work.height),
      };
      cropRectRef.current = { x: cropDragRef.current.sx, y: cropDragRef.current.sy, w: 0, h: 0 };
      setHasCrop(false);
      redraw();
      return;
    }
    if (t === 'restore' && (!origReady || transformedRef.current)) return;
    // Кисть
    pushUndo();
    const img = toImage(pos);
    strokeRef.current = { last: img };
    stampSegment(img, img);
    redraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pos = getPos(e);
    const ptrs = pointersRef.current;

    if (!ptrs.has(e.pointerId)) {
      updateCursorPreview(pos);
      return;
    }

    if (ptrs.size === 2) {
      // Пинч-зум + пан двумя пальцами
      const prevThis = ptrs.get(e.pointerId)!;
      let other: Pt | null = null;
      ptrs.forEach((p, id) => {
        if (id !== e.pointerId) other = p;
      });
      if (other) {
        const o = other as Pt;
        const oldMid = { x: (prevThis.x + o.x) / 2, y: (prevThis.y + o.y) / 2 };
        const oldDist = Math.hypot(prevThis.x - o.x, prevThis.y - o.y) || 1;
        const newMid = { x: (pos.x + o.x) / 2, y: (pos.y + o.y) / 2 };
        const newDist = Math.hypot(pos.x - o.x, pos.y - o.y) || 1;
        const v = viewRef.current;
        const ns = clamp(v.scale * (newDist / oldDist), MIN_SCALE, MAX_SCALE);
        const ix = (oldMid.x - v.x) / v.scale;
        const iy = (oldMid.y - v.y) / v.scale;
        v.scale = ns;
        v.x = newMid.x - ix * ns;
        v.y = newMid.y - iy * ns;
        setZoomPct(Math.round(ns * 100));
        redraw();
      }
      ptrs.set(e.pointerId, pos);
      return;
    }

    const prev = ptrs.get(e.pointerId)!;
    ptrs.set(e.pointerId, pos);
    updateCursorPreview(pos);
    const t = toolRef.current;

    if (t === 'pan') {
      const v = viewRef.current;
      v.x += pos.x - prev.x;
      v.y += pos.y - prev.y;
      redraw();
      return;
    }

    if (t === 'crop' && cropDragRef.current) {
      const img = toImage(pos);
      const work = workRef.current!;
      const x2 = clamp(img.x, 0, work.width);
      const y2 = clamp(img.y, 0, work.height);
      const { sx, sy } = cropDragRef.current;
      cropRectRef.current = {
        x: Math.min(sx, x2),
        y: Math.min(sy, y2),
        w: Math.abs(x2 - sx),
        h: Math.abs(y2 - sy),
      };
      redraw();
      return;
    }

    if (strokeRef.current) {
      const img = toImage(pos);
      stampSegment(strokeRef.current.last, img);
      strokeRef.current.last = img;
      redraw();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (strokeRef.current) {
      strokeRef.current = null;
      commitEdit();
    }
    if (cropDragRef.current) {
      cropDragRef.current = null;
      const cr = cropRectRef.current;
      if (cr && cr.w >= 2 && cr.h >= 2) {
        setHasCrop(true);
      } else {
        cropRectRef.current = null;
        setHasCrop(false);
        redraw();
      }
    }
  };

  const handlePointerLeave = () => updateCursorPreview(null);

  // ---------- Трансформации ----------
  const markTransformed = () => {
    transformedRef.current = true;
    setTransformed(true);
    if (toolRef.current === 'restore') setTool('erase');
  };

  const syncDims = () => {
    const work = workRef.current!;
    setNatural({ w: work.width, h: work.height });
    setExportW(String(work.width));
    setExportH(String(work.height));
  };

  const handleRotate = () => {
    const work = workRef.current;
    if (!work) return;
    pushUndo();
    const tmp = document.createElement('canvas');
    tmp.width = work.height;
    tmp.height = work.width;
    const tctx = tmp.getContext('2d')!;
    tctx.translate(tmp.width, 0);
    tctx.rotate(Math.PI / 2);
    tctx.drawImage(work, 0, 0);
    work.width = tmp.width;
    work.height = tmp.height;
    work.getContext('2d')!.drawImage(tmp, 0, 0);
    markTransformed();
    syncDims();
    commitEdit();
    fitView();
  };

  const handleApplyCrop = () => {
    const work = workRef.current;
    const cr = cropRectRef.current;
    if (!work || !cr || cr.w < 2 || cr.h < 2) return;
    pushUndo();
    const x = Math.max(0, Math.round(cr.x));
    const y = Math.max(0, Math.round(cr.y));
    const w = Math.max(1, Math.min(Math.round(cr.w), work.width - x));
    const h = Math.max(1, Math.min(Math.round(cr.h), work.height - y));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.drawImage(work, x, y, w, h, 0, 0, w, h);
    work.width = w;
    work.height = h;
    work.getContext('2d')!.drawImage(tmp, 0, 0);
    cropRectRef.current = null;
    setHasCrop(false);
    markTransformed();
    syncDims();
    commitEdit();
    setTool('erase');
    fitView();
  };

  const handleResetCrop = () => {
    cropRectRef.current = null;
    setHasCrop(false);
    redraw();
  };

  // ---------- Размер (пропорция всегда залочена) ----------
  const handleWidthChange = (value: string) => {
    setExportW(value);
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0 && natural.w > 0) {
      setExportH(String(Math.max(1, Math.round((n * natural.h) / natural.w))));
    }
  };

  const handleHeightChange = (value: string) => {
    setExportH(value);
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0 && natural.h > 0) {
      setExportW(String(Math.max(1, Math.round((n * natural.w) / natural.h))));
    }
  };

  const applyFactor = (f: number) => {
    setExportW(String(Math.max(1, Math.round(natural.w * f))));
    setExportH(String(Math.max(1, Math.round(natural.h * f))));
  };

  const targetDims = (): { w: number; h: number } => {
    const wIn = parseInt(exportW, 10);
    const hIn = parseInt(exportH, 10);
    const wOk = Number.isFinite(wIn) && wIn > 0;
    const hOk = Number.isFinite(hIn) && hIn > 0;
    // Пропорция залочена и здесь: пустое/невалидное поле ВЫВОДИТСЯ из валидного,
    // а не подменяется natural-значением (иначе стёртая ширина при введённой
    // высоте давала бы искажённый экспорт вида natural.w × h).
    let w: number;
    let h: number;
    if (wOk && hOk) {
      w = wIn;
      h = hIn;
    } else if (wOk && natural.w > 0) {
      w = wIn;
      h = Math.max(1, Math.round((wIn * natural.h) / natural.w));
    } else if (hOk && natural.h > 0) {
      h = hIn;
      w = Math.max(1, Math.round((hIn * natural.w) / natural.h));
    } else {
      w = natural.w;
      h = natural.h;
    }
    return { w: Math.min(w, 16384), h: Math.min(h, 16384) };
  };

  // ---------- Живая оценка веса (дебаунс 300 мс) ----------
  useEffect(() => {
    if (!ready) return;
    setEstBusy(true);
    let alive = true;
    const timer = window.setTimeout(async () => {
      const work = workRef.current;
      if (!work || !alive) return;
      const { w, h } = targetDims();
      const out = renderResized(work, w, h);
      const mime = format === 'webp' ? 'image/webp' : 'image/png';
      const blob = await canvasToBlob(out, mime, format === 'webp' ? quality / 100 : undefined);
      if (!alive) return;
      setEstBytes(blob ? blob.size : null);
      setEstBusy(false);
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // targetDims зависит от exportW/exportH/natural — они в списке
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, revision, format, quality, exportW, exportH, natural.w, natural.h]);

  // ---------- Сохранение / отмена ----------
  const handleSave = async () => {
    const work = workRef.current;
    if (!work || saving) return;
    setSaving(true);
    try {
      const { w, h } = targetDims();
      const out = renderResized(work, w, h);
      const mime = format === 'webp' ? 'image/webp' : 'image/png';
      const blob = await canvasToBlob(out, mime, format === 'webp' ? quality / 100 : undefined);
      if (!blob) {
        setSaving(false);
        return;
      }
      // Ресайз при экспорте тоже ломает 1:1-соответствие пикселей оригиналу,
      // поэтому наравне с кропом/поворотом помечает результат как transformed.
      onSave(asset.id, {
        blob,
        displayUrl: URL.createObjectURL(blob),
        width: w,
        height: h,
        transformed: transformedRef.current || w !== natural.w || h !== natural.h,
      });
    } catch {
      setSaving(false);
    }
  };

  const handleClose = () => {
    const settingsChanged =
      format !== 'png' || exportW !== String(natural.w) || exportH !== String(natural.h);
    if ((dirtyRef.current || settingsChanged) && !window.confirm('Выйти без сохранения?')) return;
    onClose();
  };

  const { w: tw, h: th } = targetDims();
  const isBrushTool = tool === 'erase' || tool === 'restore';

  const toolBtnCls = (active: boolean, disabled = false) =>
    `flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-xl text-[10px] font-semibold transition-all cursor-pointer active:scale-95 border ${
      disabled
        ? 'bg-zinc-900/40 border-zinc-800/60 text-zinc-600 cursor-not-allowed'
        : active
          ? 'bg-violet-600/20 border-violet-500/50 text-violet-300 shadow-[0_0_12px_rgba(124,58,237,0.15)]'
          : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
    }`;

  const numInputCls =
    'w-full text-xs font-mono font-semibold text-zinc-100 bg-zinc-900/60 focus:bg-zinc-900 border border-zinc-800 focus:border-violet-500/50 rounded-xl px-3 py-2 outline-none transition-all';

  const sliderCls =
    'w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-violet-500';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950 animate-in fade-in duration-200">
      {/* Шапка */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-950/95 shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-zinc-100 tracking-tight truncate">Редактор ассета</h2>
          <p className="text-[10px] text-zinc-500 font-mono truncate">
            {asset.label} · {natural.w} × {natural.h} px
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="shrink-0 bg-zinc-900/80 hover:bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white p-2 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer"
          title="Закрыть редактор"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Холст */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden select-none"
        style={{ ...CHECKERBOARD_STYLE, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        <canvas ref={viewCanvasRef} className="absolute inset-0" />

        {/* Круглый курсор-превью кисти */}
        <div
          ref={cursorRef}
          className="absolute rounded-full border-2 border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)] pointer-events-none z-10"
          style={{ display: 'none' }}
        />

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60 z-20">
            <div className="flex flex-col items-center gap-2 text-violet-300">
              <Loader2 className="w-7 h-7 animate-spin" />
              <span className="text-[11px] font-semibold">Загрузка ассета...</span>
            </div>
          </div>
        )}

        {/* Зум-кнопки */}
        <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-10">
          <button
            type="button"
            onClick={() => {
              const c = containerRef.current;
              if (c) zoomAt({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 1.25);
            }}
            className="bg-zinc-950/80 backdrop-blur-md border border-zinc-800 text-zinc-300 hover:text-white p-2 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer"
            title="Приблизить"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const c = containerRef.current;
              if (c) zoomAt({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 1 / 1.25);
            }}
            className="bg-zinc-950/80 backdrop-blur-md border border-zinc-800 text-zinc-300 hover:text-white p-2 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer"
            title="Отдалить"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const c = containerRef.current;
              if (c) zoomAt({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 1 / viewRef.current.scale);
            }}
            className="bg-zinc-950/80 backdrop-blur-md border border-zinc-800 text-zinc-300 hover:text-white px-1.5 py-2 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer text-[10px] font-mono font-bold"
            title="Масштаб 100%"
          >
            1:1
          </button>
          <span className="text-center text-[10px] font-mono font-bold text-zinc-400 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 rounded-xl px-1 py-1">
            {zoomPct}%
          </span>
        </div>

        {/* Кнопки кадрирования */}
        {tool === 'crop' && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 z-10">
            {hasCrop ? (
              <>
                <button
                  type="button"
                  onClick={handleApplyCrop}
                  className="py-2 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer active:scale-95"
                >
                  Применить кадр
                </button>
                <button
                  type="button"
                  onClick={handleResetCrop}
                  className="py-2 px-4 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 text-zinc-300 hover:text-white rounded-xl text-xs font-semibold transition-all shadow-md cursor-pointer active:scale-95"
                >
                  Сброс
                </button>
              </>
            ) : (
              <span className="text-[11px] font-semibold text-zinc-300 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 rounded-xl px-3 py-2 shadow-md">
                Перетащите, чтобы выделить область
              </span>
            )}
          </div>
        )}
      </div>

      {/* Панель управления */}
      <div className="shrink-0 max-h-[45vh] overflow-y-auto bg-zinc-950 border-t border-zinc-800 px-4 pt-3 pb-2 flex flex-col gap-3.5">
        {/* Инструменты */}
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1.5 block">
            Инструменты
          </label>
          <div className="grid grid-cols-7 gap-1.5">
            <button type="button" onClick={() => setTool('erase')} className={toolBtnCls(tool === 'erase')} title="Ластик">
              <Eraser className="w-4 h-4" />
              Ластик
            </button>
            <button
              type="button"
              onClick={() => {
                if (!transformed && origReady) setTool('restore');
              }}
              disabled={transformed || !origReady}
              className={toolBtnCls(tool === 'restore', transformed || !origReady)}
              title="Восстановить пиксели оригинала"
            >
              <Paintbrush className="w-4 h-4" />
              Восст.
            </button>
            <button type="button" onClick={() => setTool('pan')} className={toolBtnCls(tool === 'pan')} title="Перемещение по холсту">
              <Hand className="w-4 h-4" />
              Рука
            </button>
            <button type="button" onClick={() => setTool('crop')} className={toolBtnCls(tool === 'crop')} title="Кадрировать">
              <Crop className="w-4 h-4" />
              Кадр
            </button>
            <button
              type="button"
              onClick={handleRotate}
              disabled={!ready}
              className={toolBtnCls(false, !ready)}
              title="Повернуть на 90° по часовой"
            >
              <RotateCw className="w-4 h-4" />
              90°
            </button>
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo}
              className={toolBtnCls(false, !canUndo)}
              title="Отменить (undo)"
            >
              <Undo2 className="w-4 h-4" />
              Назад
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={!canRedo}
              className={toolBtnCls(false, !canRedo)}
              title="Повторить (redo)"
            >
              <Redo2 className="w-4 h-4" />
              Вперёд
            </button>
          </div>
          {transformed && (
            <p className="text-[10px] text-zinc-500 leading-normal mt-1.5">
              «Восстановить» отключено: после кадрирования, поворота или изменения размера соответствие пикселей оригинальному листу потеряно.
            </p>
          )}
        </div>

        {/* Размер кисти */}
        {isBrushTool && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Размер кисти</label>
              <span className="text-[10px] font-mono font-bold text-violet-300">{brushSize} px</span>
            </div>
            <input
              type="range"
              min="2"
              max="160"
              value={brushSize}
              onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
              className={sliderCls}
            />
          </div>
        )}

        {/* Размер */}
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1.5 block">Размер</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={exportW}
              onChange={(e) => handleWidthChange(e.target.value)}
              className={numInputCls}
              title="Ширина, px"
            />
            <span className="text-zinc-500 text-xs font-bold shrink-0">×</span>
            <input
              type="number"
              min={1}
              value={exportH}
              onChange={(e) => handleHeightChange(e.target.value)}
              className={numInputCls}
              title="Высота, px (пропорция залочена)"
            />
          </div>
          <div className="grid grid-cols-6 gap-1.5 mt-2">
            {[0.25, 0.5, 0.75, 1, 1.5, 2].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => applyFactor(f)}
                className="py-1.5 px-1 rounded-lg text-[10px] font-mono font-bold bg-zinc-900/60 border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 transition-all cursor-pointer active:scale-95"
              >
                ×{f}
              </button>
            ))}
          </div>
        </div>

        {/* Формат */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Формат</label>
            <span className="text-[10px] font-mono font-bold text-zinc-400 flex items-center gap-1.5">
              {estBusy ? (
                <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
              ) : estBytes !== null ? (
                <>≈ {formatBytes(estBytes)} · {tw} × {th} px</>
              ) : null}
            </span>
          </div>
          <div className="flex gap-1 bg-zinc-900/60 border border-zinc-800 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setFormat('png')}
              className={`flex-1 py-1.5 px-2 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                format === 'png' ? 'bg-violet-600 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => setFormat('webp')}
              className={`flex-1 py-1.5 px-2 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                format === 'webp' ? 'bg-violet-600 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              WebP
            </button>
          </div>
          {format === 'webp' && (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-bold text-zinc-500">Качество</span>
                <span className="text-[10px] font-mono font-bold text-violet-300">{quality}</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                value={quality}
                onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                className={sliderCls}
              />
            </div>
          )}
        </div>

        {/* Нижние кнопки */}
        <div className="flex gap-2 pt-2 pb-1 border-t border-zinc-800/80 sticky bottom-0 bg-zinc-950">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 py-2.5 px-4 bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!ready || saving}
            className="flex-[2] flex items-center justify-center gap-1.5 py-2.5 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-xl text-xs font-bold transition-all shadow-[0_4px_12px_rgba(124,58,237,0.25)] cursor-pointer active:scale-95 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssetEditor;
