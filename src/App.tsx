/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import {
  Layers,
  Scissors,
  Sparkles,
  ChevronRight,
  Info,
  Smartphone,
  FolderDown,
  FileImage,
  Loader2,
  Settings,
  X,
  Trash2
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import JSZip from 'jszip';
import { Slice, ProcessedAsset, ColorRGB, Rect, ObjectAsset, SelectionItem, SelectionMask } from './types';
import ImageUploader from './components/ImageUploader';
import Workspace from './components/Workspace';
import AssetCard from './components/AssetCard';
import ObjectSelector from './components/ObjectSelector';
import AssetGallery from './components/AssetGallery';
import { BackgroundRemoval } from './plugins/backgroundRemoval';
import {
  clampRectToBounds,
  estimateBackgroundColor,
  buildForegroundMask,
  dilateBinary,
} from './utils/objectDetect';

// Модель по умолчанию: BiRefNet_lite fp16 (ONNX opset 17), raw-режим по объектам
const BIREFNET_MODEL_URL = 'https://78.17.74.156:8443/static/birefnet_lite_fp16.onnx';
const BIREFNET_MODEL_SHA256 = '311cfd8088ee71224ba0687b00dfad1ed28fc05aae0ce64e87965cc3d4b29d6a';
const BIREFNET_MODEL_SIZE_BYTES = 114538787;
// Пресет «Качество»: BiRefNet base fp16 (Swin-Large) — сильнее на мелких/бледных
// объектах, но тяжелее и медленнее; для мощных телефонов (8+ ГБ ОЗУ)
const BIREFNET_BASE_MODEL_URL = 'https://78.17.74.156:8443/static/birefnet_base_fp16.onnx';
const BIREFNET_BASE_MODEL_SHA256 = '323232ec73a04ac4d0ef8c325a75aa8d69ed7062235a7cf9941769fae4c9709f';
const BIREFNET_BASE_MODEL_SIZE_BYTES = 489666838;

/** SHA-256 известен только для наших моделей — для них включаем проверку. */
const getSha256ForUrl = (url: string): string | undefined =>
  url === BIREFNET_MODEL_URL ? BIREFNET_MODEL_SHA256
  : url === BIREFNET_BASE_MODEL_URL ? BIREFNET_BASE_MODEL_SHA256
  : undefined;

const formatMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

interface SavedModel {
  name: string;
  url: string;
  sizeLabel: string;
  isPreset: boolean;
  description: string;
}

const DEFAULT_PRESETS: SavedModel[] = [
  {
    name: 'BiRefNet-lite fp16 (Рекомендуется)',
    url: BIREFNET_MODEL_URL,
    sizeLabel: '109 МБ',
    isPreset: true,
    description: 'Точная модель для вырезания объектов по отдельности. Скачивается с докачкой и проверкой контрольной суммы.'
  },
  {
    name: 'BiRefNet base fp16 (Качество)',
    url: BIREFNET_BASE_MODEL_URL,
    sizeLabel: '467 МБ',
    isPreset: true,
    description: 'Полный Swin-Large: берёт мелкие и бледные объекты, которые lite пропускает. В 4–6 раз медленнее и требует много памяти — для мощных телефонов (8+ ГБ ОЗУ). Докачка и проверка суммы включены.'
  },
  {
    name: 'RMBG-1.4 (Bria AI)',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
    sizeLabel: '43 МБ',
    isPreset: true,
    description: 'Рекомендуется. Премиум качество, отлично определяет мелкие детали, волосы и сложные границы.'
  },
  {
    name: 'U2Netp (Lightweight)',
    url: 'https://huggingface.co/nicjac/u2netp-onnx/resolve/main/u2netp.onnx',
    sizeLabel: '4.4 МБ',
    isPreset: true,
    description: 'Суперлегкая модель. Мгновенно скачивается, работает быстро и потребляет минимум оперативной памяти.'
  }
];

const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      img.onload = null;
      img.onerror = null;
      resolve(img);
    };
    img.onerror = (err) => {
      img.onload = null;
      img.onerror = null;
      reject(err);
    };
    img.src = url;
  });
};

/** Экраны приложения (стейт-машина основного потока). */
type AppView = 'upload' | 'selecting' | 'processing' | 'gallery' | 'legacy-workspace';

const TRIM_ALPHA_THRESHOLD = 8;
const TRIM_MARGIN_PX = 2;

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );

/** Результат обработки одной рамки/выделения (готовый ассет). */
interface RectProcessResult {
  blob: Blob;
  displayUrl: string;
  width: number;
  height: number;
  /** Смещение обрезанного результата внутри исходной рамки (после trim). */
  offsetX: number;
  offsetY: number;
  /** Пометка нестандартного пути (фолбэк «по цвету фона»). */
  note?: string;
}

/** Декодирует PNG-blob результата ИИ в canvas точного размера W×H. */
async function blobToSizedCanvas(
  rawBlob: Blob,
  targetW: number,
  targetH: number
): Promise<HTMLCanvasElement> {
  const srcUrl = URL.createObjectURL(rawBlob);
  let img: HTMLImageElement;
  try {
    img = await loadImage(srcUrl);
  } finally {
    try { URL.revokeObjectURL(srcUrl); } catch (e) {}
  }

  const W = Math.max(1, Math.round(targetW));
  const H = Math.max(1, Math.round(targetH));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, W, H);
  return canvas;
}

/**
 * Обрезает прозрачные поля у canvas: bbox непрозрачных пикселей (alpha > 8)
 * + margin 2px → перекроп. Возвращает null, если непрозрачных пикселей нет
 * (пустой результат — решение об ошибке/фолбэке принимает вызывающий код).
 */
async function trimCanvasTransparent(
  canvas: HTMLCanvasElement
): Promise<{ blob: Blob; displayUrl: string; width: number; height: number; offsetX: number; offsetY: number } | null> {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const data = ctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const rowOffset = y * W;
    for (let x = 0; x < W; x++) {
      if (data[(rowOffset + x) * 4 + 3] > TRIM_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  minX = Math.max(0, minX - TRIM_MARGIN_PX);
  minY = Math.max(0, minY - TRIM_MARGIN_PX);
  maxX = Math.min(W - 1, maxX + TRIM_MARGIN_PX);
  maxY = Math.min(H - 1, maxY + TRIM_MARGIN_PX);
  const outW = maxX - minX + 1;
  const outH = maxY - minY + 1;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d');
  if (!outCtx) throw new Error('Canvas 2D context unavailable');
  outCtx.drawImage(canvas, minX, minY, outW, outH, 0, 0, outW, outH);

  const blob = await canvasToBlob(out);
  return { blob, displayUrl: URL.createObjectURL(blob), width: outW, height: outH, offsetX: minX, offsetY: minY };
}

/** Кроп области rect (целочисленной) из изображения 1:1 в новый canvas. */
function cropToCanvas(img: HTMLImageElement, rect: Rect): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(
    img,
    rect.x, rect.y, rect.width, rect.height,
    0, 0, canvas.width, canvas.height
  );
  return canvas;
}

/** Расширяет рамку в scale раз от центра с клампом в границы листа W×H. */
function expandRectFromCenter(rect: Rect, scale: number, W: number, H: number): Rect {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const w = rect.width * scale;
  const h = rect.height * scale;
  return clampRectToBounds({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, W, H);
}

/** Объединяющий bbox набора рамок + паддинг, с клампом в границы листа. */
function unionRectOf(rects: Rect[], pad: number, W: number, H: number): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return clampRectToBounds(
    { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 },
    W, H
  );
}

/** Полная копия canvas (кэш ИИ-результатов не должен зависеть от мутаций). */
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx) ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * Чистка fg-маски цветового фолбэка: (1) остаются крупнейшая связная
 * компонента и компоненты ≥25% её площади либо задевающие центральную треть
 * рамки (отсекает чужие куски соседних объектов по углам); (2) заливка
 * внутренних «дыр» — пикселей фона, не достижимых от границ рамки (убирает
 * крапинки внутри белых/полупрозрачных объектов типа алмаза).
 */
function cleanColorFallbackMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const areas: number[] = [0];
  const touchesCenter: boolean[] = [false];
  const cx0 = w / 3, cx1 = (2 * w) / 3, cy0 = h / 3, cy1 = (2 * h) / 3;
  let nLabels = 0;
  for (let start = 0; start < w * h; start++) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;
    nLabels++;
    labels[start] = nLabels;
    areas.push(0);
    touchesCenter.push(false);
    let qh = 0, qt = 0;
    queue[qt++] = start;
    while (qh < qt) {
      const p = queue[qh++];
      areas[nLabels]++;
      const px = p % w, py = (p / w) | 0;
      if (px >= cx0 && px <= cx1 && py >= cy0 && py <= cy1) touchesCenter[nLabels] = true;
      if (px > 0 && mask[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = nLabels; queue[qt++] = p - 1; }
      if (px < w - 1 && mask[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = nLabels; queue[qt++] = p + 1; }
      if (py > 0 && mask[p - w] === 1 && labels[p - w] === 0) { labels[p - w] = nLabels; queue[qt++] = p - w; }
      if (py < h - 1 && mask[p + w] === 1 && labels[p + w] === 0) { labels[p + w] = nLabels; queue[qt++] = p + w; }
    }
  }
  if (nLabels === 0) return mask;
  let maxArea = 0;
  for (let l = 1; l <= nLabels; l++) if (areas[l] > maxArea) maxArea = areas[l];
  const keep: boolean[] = [false];
  for (let l = 1; l <= nLabels; l++) keep.push(areas[l] === maxArea || areas[l] >= 0.25 * maxArea || touchesCenter[l]);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (labels[p] > 0 && keep[labels[p]]) out[p] = 1;

  // Заливка дыр: BFS фона от границ; не достигнутый фон = дыра → в маску
  const reach = new Uint8Array(w * h);
  let qh = 0, qt = 0;
  for (let x = 0; x < w; x++) {
    const t = x, b = (h - 1) * w + x;
    if (out[t] === 0 && reach[t] === 0) { reach[t] = 1; queue[qt++] = t; }
    if (out[b] === 0 && reach[b] === 0) { reach[b] = 1; queue[qt++] = b; }
  }
  for (let y = 0; y < h; y++) {
    const l = y * w, r = y * w + w - 1;
    if (out[l] === 0 && reach[l] === 0) { reach[l] = 1; queue[qt++] = l; }
    if (out[r] === 0 && reach[r] === 0) { reach[r] = 1; queue[qt++] = r; }
  }
  while (qh < qt) {
    const p = queue[qh++];
    const px = p % w, py = (p / w) | 0;
    if (px > 0 && out[p - 1] === 0 && reach[p - 1] === 0) { reach[p - 1] = 1; queue[qt++] = p - 1; }
    if (px < w - 1 && out[p + 1] === 0 && reach[p + 1] === 0) { reach[p + 1] = 1; queue[qt++] = p + 1; }
    if (py > 0 && out[p - w] === 0 && reach[p - w] === 0) { reach[p - w] = 1; queue[qt++] = p - w; }
    if (py < h - 1 && out[p + w] === 0 && reach[p + w] === 0) { reach[p + w] = 1; queue[qt++] = p + w; }
  }
  for (let p = 0; p < w * h; p++) if (out[p] === 0 && reach[p] === 0) out[p] = 1;
  return out;
}

/** Площадь пересечения двух прямоугольников. */
function rectIntersectionArea(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ix * iy;
}

/** Кэш оценки цвета фона листа (медиана периметра) по загруженному изображению. */
const sheetBgCache = new WeakMap<HTMLImageElement, ColorRGB>();

/**
 * Оценивает цвет фона листа медианой пикселей периметра (как в автодетекции).
 * Для экономии памяти лист даунскейлится до 1024px — медиана практически не меняется.
 */
function getSheetBackgroundColor(img: HTMLImageElement): ColorRGB {
  const cached = sheetBgCache.get(img);
  if (cached) return cached;
  const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, 1024 / maxDim);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  const bg = estimateBackgroundColor(ctx.getImageData(0, 0, w, h));
  sheetBgCache.set(img, bg);
  return bg;
}

/**
 * Fg-маска области rect в ПОЛНОМ разрешении по цвету фона листа
 * (maxChannelDiff > 25 — тот же критерий, что в автодетекции).
 */
function foregroundMaskForRect(
  img: HTMLImageElement,
  rect: Rect,
  sheetBg: ColorRGB
): SelectionMask {
  const canvas = cropToCanvas(img, rect);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: buildForegroundMask(imgData, 25, sheetBg),
    width: canvas.width,
    height: canvas.height,
  };
}

/** Обнуляет альфу ImageData вне маски (маска в тех же координатах). */
function intersectAlphaWithMask(imgData: ImageData, mask: SelectionMask): void {
  const w = Math.min(imgData.width, mask.width);
  const h = Math.min(imgData.height, mask.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask.data[y * mask.width + x] === 0) {
        imgData.data[(y * imgData.width + x) * 4 + 3] = 0;
      }
    }
  }
  // Пиксели за пределами маски (если она меньше) тоже гасим
  for (let y = 0; y < imgData.height; y++) {
    for (let x = 0; x < imgData.width; x++) {
      if (y >= h || x >= w) {
        imgData.data[(y * imgData.width + x) * 4 + 3] = 0;
      }
    }
  }
}

/**
 * Обнуляет альфу ImageData (система координат рамки rectA) на пикселях
 * маски removal (система координат rectB): координатный сдвиг B → A.
 */
function subtractMaskAlpha(
  imgData: ImageData,
  rectA: Rect,
  rectB: Rect,
  removal: SelectionMask
): void {
  const offX = Math.round(rectB.x - rectA.x);
  const offY = Math.round(rectB.y - rectA.y);
  for (let by = 0; by < removal.height; by++) {
    const ay = by + offY;
    if (ay < 0 || ay >= imgData.height) continue;
    for (let bx = 0; bx < removal.width; bx++) {
      if (removal.data[by * removal.width + bx] === 0) continue;
      const ax = bx + offX;
      if (ax < 0 || ax >= imgData.width) continue;
      imgData.data[(ay * imgData.width + ax) * 4 + 3] = 0;
    }
  }
}

const revokeAssetUrls = (list: ObjectAsset[]) => {
  list.forEach(a => {
    if (a.displayUrl) {
      try { URL.revokeObjectURL(a.displayUrl); } catch (e) {}
    }
  });
};

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [originalImageSrc, setOriginalImageSrc] = useState<string | null>(null);
  const [slices, setSlices] = useState<Slice[]>([]);
  const processedImageDataRef = useRef<ImageData | null>(null);
  const originalImageDataRef = useRef<ImageData | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [keyColor, setKeyColor] = useState<ColorRGB | null>(null);
  const [assets, setAssets] = useState<{ [id: string]: ProcessedAsset }>({});
  const [isZipping, setIsZipping] = useState(false);
  const [useAIBgRemoval, setUseAIBgRemoval] = useState(true);
  const [aiProgress, setAiProgress] = useState<string>('Инициализация...');
  const [aiPercent, setAiPercent] = useState<number>(0);

  // Стейт-машина экранов основного потока
  const [view, setView] = useState<AppView>('upload');
  const [initialSlices, setInitialSlices] = useState<Slice[] | null>(null);
  const pendingFileRef = useRef<File | null>(null);

  // Новый поток «по объектам»: готовые ассеты галереи + сохранённые выделения
  // (для возврата из галереи на экран выбора объектов и для повтора одного объекта)
  const [objectAssets, setObjectAssets] = useState<ObjectAsset[]>([]);
  const [savedSelections, setSavedSelections] = useState<SelectionItem[] | null>(null);
  const savedSelectionsRef = useRef<SelectionItem[] | null>(null);
  // Опция «Исключать вложенные рамки» последнего прогона — для retry с тем же контекстом
  const lastExcludeNestedRef = useRef(false);
  const objectAssetsRef = useRef<ObjectAsset[]>([]);
  useEffect(() => {
    objectAssetsRef.current = objectAssets;
  }, [objectAssets]);

  // Идёт ли обработка каких-то объектов галереи (пакетная или повтор одного)
  const isGalleryProcessing = objectAssets.some(
    a => a.status === 'pending' || a.status === 'processing'
  );

  // Прогресс скачивания модели в байтах (событие modelDownloadProgress)
  const [modelFetchInfo, setModelFetchInfo] = useState<{
    loaded: number;
    total: number;
    resumed: boolean;
  } | null>(null);

  const imageLoadRequestIdRef = useRef<number>(0);
  const activeBlobUrlsRef = useRef<string[]>([]);

  const registerBlobUrl = (url: string) => {
    if (url && url.startsWith('blob:')) {
      activeBlobUrlsRef.current.push(url);
    }
    return url;
  };

  const revokeAllBlobs = () => {
    activeBlobUrlsRef.current.forEach(url => {
      try { URL.revokeObjectURL(url); } catch (e) {}
    });
    activeBlobUrlsRef.current = [];
  };

  /** Освобождает objectURL-ы ассетов галереи и очищает их стейт (утечки!). */
  const clearObjectAssets = useCallback(() => {
    revokeAssetUrls(objectAssetsRef.current);
    objectAssetsRef.current = [];
    setObjectAssets([]);
  }, []);

  useEffect(() => {
    return () => {
      revokeAllBlobs();
      revokeAssetUrls(objectAssetsRef.current);
      objectAssetsRef.current = [];
    };
  }, []);
  
  // Native and AI Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [localModel, setLocalModel] = useState<string>(() => {
    return localStorage.getItem('localModel') || 'isnet_quint8';
  });
  const [modelDownloadUrl, setModelDownloadUrl] = useState<string>(() => {
    return localStorage.getItem('modelDownloadUrl') || (window.location.origin + '/assets/background-removal-data/');
  });
  const [customModelUrl, setCustomModelUrl] = useState<string>(() => {
    // Пользовательское значение из настроек не перетираем, дефолт — BiRefNet-lite
    return localStorage.getItem('customModelUrl') || BIREFNET_MODEL_URL;
  });
  const [exportFolder, setExportFolder] = useState<string>(() => {
    return localStorage.getItem('exportFolder') || 'Download';
  });
  const [modelDownloadProgress, setModelDownloadProgress] = useState<number | null>(null);
  const [isModelDownloading, setIsModelDownloading] = useState(false);

  const [modelsList, setModelsList] = useState<SavedModel[]>(() => {
    const saved = localStorage.getItem('user_models_list');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return DEFAULT_PRESETS;
  });

  const [newModelName, setNewModelName] = useState('');
  const [newModelUrl, setNewModelUrl] = useState('');

  const [isCustomModelCached, setIsCustomModelCached] = useState(false);
  const [cacheStatuses, setCacheStatuses] = useState<{ [url: string]: boolean }>({});

  const checkCustomModelCacheStatus = useCallback(async (urlToCheck?: string, listToCheck?: SavedModel[]) => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const currentList = listToCheck || modelsList;
      const urls = currentList.map(m => m.url);
      const activeUrl = urlToCheck || customModelUrl;
      if (!urls.includes(activeUrl)) {
        urls.push(activeUrl);
      }
      const newStatuses: { [url: string]: boolean } = {};
      for (const u of urls) {
        if (!u) continue;
        const res = await BackgroundRemoval.isModelCached({ url: u });
        newStatuses[u] = res.isCached;
      }
      setCacheStatuses(newStatuses);
      setIsCustomModelCached(newStatuses[activeUrl] || false);
    } catch (e) {
      console.warn('Failed to check model cache status:', e);
    }
  }, [customModelUrl, modelsList]);

  const clearCustomModelCache = async () => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const res = await BackgroundRemoval.clearCachedModels();
      setIsCustomModelCached(false);
      alert(`Кэш очищен. Удалено файлов моделей: ${res.deletedCount}`);
    } catch (e) {
      alert('Ошибка при очистке кэша: ' + String(e));
    }
  };

  useEffect(() => {
    if (isSettingsOpen) {
      checkCustomModelCacheStatus();
    }
  }, [isSettingsOpen, customModelUrl, checkCustomModelCacheStatus]);

  /**
   * Гарантирует, что нативная модель скачана и закэширована.
   * При первом использовании ИИ показывает прогресс «Загрузка модели… X / Y МБ»
   * (с пометкой «докачка» при возобновлении прерванной загрузки).
   */
  const ensureModelReady = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return;

    try {
      const res = await BackgroundRemoval.isModelCached({ url: customModelUrl });
      if (res.isCached) return;
    } catch (e) {
      console.warn('isModelCached check failed:', e);
    }

    const totalFallback = customModelUrl === BIREFNET_MODEL_URL ? BIREFNET_MODEL_SIZE_BYTES : customModelUrl === BIREFNET_BASE_MODEL_URL ? BIREFNET_BASE_MODEL_SIZE_BYTES : 0;
    setAiProgress('Загрузка модели ИИ...');
    setAiPercent(0);

    const listener = await BackgroundRemoval.addListener(
      'modelDownloadProgress',
      (info) => {
        if (!info || typeof info.loaded !== 'number') return;
        const total = info.total > 0 ? info.total : totalFallback;
        setModelFetchInfo({ loaded: info.loaded, total, resumed: !!info.resumed });
        if (total > 0) {
          setAiProgress(
            `Загрузка модели… ${formatMb(info.loaded)} / ${formatMb(total)} МБ${info.resumed ? ' (докачка)' : ''}`
          );
          setAiPercent(Math.max(0, Math.min(100, Math.round((info.loaded / total) * 100))));
        } else {
          setAiProgress(`Загрузка модели… ${formatMb(info.loaded)} МБ${info.resumed ? ' (докачка)' : ''}`);
        }
      }
    );
    // Легаси-событие с процентами — как фолбэк для старых версий плагина
    const legacyListener = await BackgroundRemoval.addListener(
      'downloadProgress',
      (info) => {
        if (info && typeof info.percent === 'number') {
          setAiPercent(Math.max(0, Math.min(100, Math.round(info.percent))));
        }
      }
    );

    try {
      await BackgroundRemoval.preloadModel({
        url: customModelUrl,
        sha256: getSha256ForUrl(customModelUrl),
      });
      checkCustomModelCacheStatus();
    } finally {
      listener.remove();
      legacyListener.remove();
      setModelFetchInfo(null);
    }
  }, [customModelUrl, checkCustomModelCacheStatus]);

  /**
   * Отмена с экрана 'processing': инкремент requestId инвалидирует все
   * зависшие await-ы (загрузка модели, нативный removeBackground), после чего
   * пользователь возвращается к выбору объектов (или к загрузке файла).
   * Без этой кнопки зависший нативный промис оставлял экран навсегда.
   */
  const handleCancelProcessing = useCallback(() => {
    imageLoadRequestIdRef.current++;
    setAiPercent(0);
    setModelFetchInfo(null);
    setView(originalImageSrc ? 'selecting' : 'upload');
  }, [originalImageSrc]);

  /** Загрузка нового файла: показываем экран выбора объектов (если включён ИИ). */
  const handleImageSelected = useCallback(async (file: File) => {
    imageLoadRequestIdRef.current++;

    // Освобождаем ассеты предыдущей галереи ДО revokeAllBlobs (их URL там тоже учтены)
    clearObjectAssets();
    setSavedSelections(null);
    savedSelectionsRef.current = null;

    // Revoke previous blob URLs to prevent memory leaks in WebView
    revokeAllBlobs();

    const dataUrl = registerBlobUrl(URL.createObjectURL(file));
    setOriginalImageSrc(dataUrl);
    setInitialSlices(null);
    setAssets({});

    if (!useAIBgRemoval) {
      pendingFileRef.current = null;
      setImageSrc(dataUrl);
      setAiPercent(0);
      setView('legacy-workspace');
      return;
    }

    // Перед ИИ-обработкой пользователь выбирает объекты на листе
    pendingFileRef.current = file;
    setImageSrc(null);
    setAiPercent(0);
    setView('selecting');
  }, [useAIBgRemoval, clearObjectAssets]);

  /** Старый путь: ИИ-обработка целого листа одним изображением. */
  const processWholeSheet = useCallback(async () => {
    const file = pendingFileRef.current;
    const dataUrl = originalImageSrc;
    if (!file || !dataUrl) return;

    const requestId = ++imageLoadRequestIdRef.current;
    setView('processing');
    setAiProgress('Инициализация ИИ...');
    setAiPercent(10);

    try {
      if (Capacitor.isNativePlatform()) {
        await ensureModelReady();
        if (requestId !== imageLoadRequestIdRef.current) return;

        setAiProgress('Конвертация изображения...');
        setAiPercent(20);
        const fileToDataURL = (f: File): Promise<string> => {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              reader.onload = null;
              reader.onerror = null;
              resolve(reader.result as string);
            };
            reader.onerror = (err) => {
              reader.onload = null;
              reader.onerror = null;
              reject(err);
            };
            reader.readAsDataURL(f);
          });
        };
        const fileOrBase64 = await fileToDataURL(file);

        if (requestId !== imageLoadRequestIdRef.current) return;

        setAiProgress('Обработка на устройстве...');
        setAiPercent(60);

        const result = await BackgroundRemoval.removeBackground({ image: fileOrBase64, url: customModelUrl });

        if (requestId !== imageLoadRequestIdRef.current) return;

        setAiProgress('Завершение...');
        setAiPercent(90);

        const transparentUrl = Capacitor.convertFileSrc(result.uri);
        setImageSrc(transparentUrl);
        setAiPercent(100);
      } else {
        const { removeBackground } = await import('@imgly/background-removal');
        
        const resultBlob = await removeBackground(file, {
          model: localModel as any,
          publicPath: modelDownloadUrl,
          progress: (key, current, total) => {
            if (requestId !== imageLoadRequestIdRef.current) return;
            let percent = 0;
            if (total && !isNaN(total) && total > 0) {
              percent = Math.round((current / total) * 100);
            } else if (current > 0) {
              percent = Math.min(95, Math.round(current / (1024 * 1024)));
            }
            const displayPercent = Math.min(100, Math.max(0, percent));
            setAiProgress(`Загрузка ИИ: ${displayPercent}%`);
            setAiPercent(displayPercent);
          }
        });
        
        if (requestId !== imageLoadRequestIdRef.current) return;
        
        const transparentUrl = registerBlobUrl(URL.createObjectURL(resultBlob));
        setImageSrc(transparentUrl);
        setAiPercent(100);
      }
    } catch (error: any) {
      if (requestId !== imageLoadRequestIdRef.current) return;
      console.error("Local AI Background Removal failed:", error);
      const errMsg = error?.message || String(error);
      if (errMsg.includes("Model not preloaded")) {
        alert("Модель ИИ не загружена. Пожалуйста, откройте настройки и скачайте модель.");
      } else {
        alert("Локальное удаление фона не удалось: " + errMsg);
      }
      setImageSrc(dataUrl);
    } finally {
      if (requestId === imageLoadRequestIdRef.current) {
        setAiPercent(0);
        setAssets({});
        // И успех, и фолбэк из catch показывают легаси-Workspace
        setView('legacy-workspace');
      }
    }
  }, [originalImageSrc, localModel, modelDownloadUrl, customModelUrl, ensureModelReady]);

  /**
   * Кэш ИИ-результата по РЕГИОНУ (bbox всех выделений, ступень 2.5 фолбэка):
   * салиентная модель может «не видеть» объект в маленьком кропе (белый алмаз
   * на белом), но в составе композиции вырезает его. Регион вместо целого листа:
   * большие белые поля листа «съедают» масштаб и модель теряет мелкие объекты.
   */
  const regionAICacheRef = useRef<{ key: string; region: Rect; canvas: HTMLCanvasElement } | null>(null);
  /**
   * Кэш успешных ИИ-результатов текущего прогона (ступень 2.4): если рамка B
   * вложена в уже обработанную рамку A — объект B вырезается из готового
   * результата A (кейс пользователя: алмаз идеален в ассете короны, но
   * невидим моделью в собственном кропе).
   */
  const aiResultCacheRef = useRef<Array<{ rect: Rect; canvas: HTMLCanvasElement }>>([]);

  /** Прогоняет ИИ-удаление фона по canvas (native raw / imgly web) → PNG-blob. */
  const runAIOnCanvas = useCallback(async (cropCanvas: HTMLCanvasElement): Promise<Blob> => {
    if (Capacitor.isNativePlatform()) {
      const cropDataUrl = cropCanvas.toDataURL('image/png');
      const result = await BackgroundRemoval.removeBackground({
        image: cropDataUrl,
        url: customModelUrl,
        raw: true,
      });
      const response = await fetch(Capacitor.convertFileSrc(result.uri));
      if (!response.ok) {
        throw new Error(`Не удалось прочитать результат ИИ (HTTP ${response.status})`);
      }
      return response.blob();
    }
    const cropBlob = await canvasToBlob(cropCanvas);
    const { removeBackground } = await import('@imgly/background-removal');
    return removeBackground(cropBlob, {
      model: localModel as any,
      publicPath: modelDownloadUrl,
    });
  }, [customModelUrl, localModel, modelDownloadUrl]);

  /** ИИ по региону (bbox всех выделений) с кэшем (см. regionAICacheRef). */
  const getRegionAICanvas = useCallback(async (
    img: HTMLImageElement,
    region: Rect
  ): Promise<{ region: Rect; canvas: HTMLCanvasElement }> => {
    const key = `${img.src.length}:${img.src.slice(0, 64)}|${region.x},${region.y},${region.width},${region.height}`;
    const cached = regionAICacheRef.current;
    if (cached && cached.key === key) return { region: cached.region, canvas: cached.canvas };
    const crop = cropToCanvas(img, region);
    const rawBlob = await runAIOnCanvas(crop);
    const canvas = await blobToSizedCanvas(rawBlob, crop.width, crop.height);
    regionAICacheRef.current = { key, region, canvas };
    return { region, canvas };
  }, [runAIOnCanvas]);

  /**
   * Общий конвейер обработки ОДНОГО выделения (используется и пакетным
   * прогоном, и повтором из галереи):
   *
   * 1. Кроп рамки → ИИ → (для «умного» выделения альфа ∩ маска контура,
   *    дилатированная на 2px) → вычитание вложенных выделений → trim.
   * 2. Пусто? Ретрай с контекстом: рамка ×1.6 от центра → ИИ по расширенному
   *    кропу → вырезка области исходной рамки (координатный сдвиг) → шаг 1.
   * 3. Снова пусто? Вырез БЕЗ ИИ по цвету фона листа (fg-маска в полном
   *    разрешении; для «умного» выделения альфа = его маска) с пометкой note.
   * 4. Всё пусто → прежняя ошибка «ИИ вернул пустой результат».
   */
  const processOneSelection = useCallback(async (
    img: HTMLImageElement,
    selection: SelectionItem,
    allSelections: SelectionItem[]
  ): Promise<RectProcessResult> => {
    const rect = selection.rect;
    const sheetBg = getSheetBackgroundColor(img);

    // Маска «умного» выделения, дилатированная на 2px (не режем антиалиасинг ИИ)
    const dilatedSelfMask: SelectionMask | null =
      selection.mask &&
      selection.mask.width === Math.round(rect.width) &&
      selection.mask.height === Math.round(rect.height)
        ? {
            data: dilateBinary(selection.mask.data, selection.mask.width, selection.mask.height, 2),
            width: selection.mask.width,
            height: selection.mask.height,
          }
        : null;

    /** Пост-обработка результата в координатах rect: маска контура ∩, trim.
     *  (Вычитание вложенных объектов делается пост-проходом в processObjects —
     *  по ГОТОВОЙ альфе вложенного объекта, а не по хрупкой маске цвета.) */
    const finalizeCanvas = async (
      canvas: HTMLCanvasElement,
      applySelfMask: boolean
    ) => {
      if (applySelfMask && dilatedSelfMask) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        intersectAlphaWithMask(imgData, dilatedSelfMask);
        ctx.putImageData(imgData, 0, 0);
      }
      return trimCanvasTransparent(canvas);
    };

    /** Вырезка области rect из ИИ-канваса, покрывающего srcRect. */
    const cutRectFrom = (srcCanvas: HTMLCanvasElement, srcRect: Rect): HTMLCanvasElement => {
      const sub = document.createElement('canvas');
      sub.width = Math.max(1, Math.round(rect.width));
      sub.height = Math.max(1, Math.round(rect.height));
      const subCtx = sub.getContext('2d', { willReadFrequently: true });
      if (!subCtx) throw new Error('Canvas 2D context unavailable');
      subCtx.drawImage(
        srcCanvas,
        rect.x - srcRect.x, rect.y - srcRect.y, sub.width, sub.height,
        0, 0, sub.width, sub.height
      );
      return sub;
    };

    // --- Шаг 1: ИИ по исходной рамке ---
    const cropCanvas = cropToCanvas(img, rect);
    const rawBlob = await runAIOnCanvas(cropCanvas);
    const aiCanvas = await blobToSizedCanvas(rawBlob, cropCanvas.width, cropCanvas.height);
    // Чистый ИИ-результат — в кэш прогона (ступень 2.4 для вложенных рамок);
    // клон, т.к. finalize мутирует канвас маской «умного» выделения
    aiResultCacheRef.current.push({ rect, canvas: cloneCanvas(aiCanvas) });
    if (aiResultCacheRef.current.length > 8) aiResultCacheRef.current.shift();
    let result = await finalizeCanvas(aiCanvas, true);
    if (result) return result;

    // --- Шаг 2: ретрай с контекстом — рамка ×1.6 от центра ---
    const expanded = expandRectFromCenter(rect, 1.6, img.naturalWidth, img.naturalHeight);
    if (expanded.width > rect.width || expanded.height > rect.height) {
      const expCrop = cropToCanvas(img, expanded);
      const expRaw = await runAIOnCanvas(expCrop);
      const expCanvas = await blobToSizedCanvas(expRaw, expCrop.width, expCrop.height);
      result = await finalizeCanvas(cutRectFrom(expCanvas, expanded), true);
      if (result) return result;
    }

    // --- Шаг 2.4: объект из ГОТОВОГО ИИ-результата охватывающей рамки ---
    // (кейс: алмаз невидим моделью в своём кропе, но идеально вырезан в
    // составе рамки короны, обработанной раньше)
    const rectArea = rect.width * rect.height;
    for (const entry of aiResultCacheRef.current) {
      if (entry.rect === rect) continue;
      if (rectIntersectionArea(entry.rect, rect) < 0.98 * rectArea) continue;
      result = await finalizeCanvas(cutRectFrom(entry.canvas, entry.rect), true);
      if (result) return result;
    }

    // --- Шаг 2.5: ИИ по региону всех выделений (кэш) — модель видит объект в
    // композиции; регион вместо целого листа, чтобы поля не съедали масштаб ---
    try {
      const region = unionRectOf(
        allSelections.map(s => s.rect),
        24,
        img.naturalWidth,
        img.naturalHeight
      );
      const { region: srcRect, canvas: regionCanvas } = await getRegionAICanvas(img, region);
      result = await finalizeCanvas(cutRectFrom(regionCanvas, srcRect), true);
      if (result) return result;
    } catch (e) {
      // регион слишком большой / ИИ упал — тихо падаем на цветовой фолбэк
      console.warn('Region AI fallback failed:', e);
    }

    // --- Шаг 3: вырез БЕЗ ИИ по цвету фона листа ---
    const colorCanvas = cropToCanvas(img, rect);
    const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
    if (!colorCtx) throw new Error('Canvas 2D context unavailable');
    const colorData = colorCtx.getImageData(0, 0, colorCanvas.width, colorCanvas.height);
    // Для «умного» выделения альфа = маска контура ∩ fg-по-цвету (маска теперь
    // паддирована «на пару мм» — без пересечения в ассет попало бы кольцо фона);
    // если пересечение пусто (нестандартный фон) — сама маска; иначе fg-по-цвету
    let fallbackMask: SelectionMask;
    if (
      selection.mask &&
      selection.mask.width === colorCanvas.width &&
      selection.mask.height === colorCanvas.height
    ) {
      const fgColor = foregroundMaskForRect(img, rect, sheetBg);
      const combined = new Uint8Array(selection.mask.data.length);
      let combinedCount = 0;
      for (let p = 0; p < combined.length; p++) {
        if (selection.mask.data[p] === 1 && fgColor.data[p] === 1) {
          combined[p] = 1;
          combinedCount++;
        }
      }
      fallbackMask = combinedCount > 0
        ? { data: combined, width: selection.mask.width, height: selection.mask.height }
        : selection.mask;
    } else {
      // Чистка: крупнейшие компоненты (без чужих кусков по углам) + заливка дыр
      const rawFg = foregroundMaskForRect(img, rect, sheetBg);
      fallbackMask = {
        data: cleanColorFallbackMask(rawFg.data, rawFg.width, rawFg.height),
        width: rawFg.width,
        height: rawFg.height,
      };
    }
    let hasFg = false;
    for (let p = 0; p < fallbackMask.data.length; p++) {
      if (fallbackMask.data[p] === 1) {
        hasFg = true;
        break;
      }
    }
    if (hasFg) {
      intersectAlphaWithMask(colorData, fallbackMask);
      colorCtx.putImageData(colorData, 0, 0);
      const colorResult = await trimCanvasTransparent(colorCanvas);
      if (colorResult) {
        return { ...colorResult, note: 'ИИ не нашёл объект — вырезано по цвету фона' };
      }
    }

    // --- Шаг 4: всё пусто ---
    throw new Error('ИИ вернул пустой результат');
  }, [runAIOnCanvas, getRegionAICanvas]);

  /**
   * Новый основной поток «по объектам»: каждая рамка вырезается отдельным
   * кропом и сразу становится готовым ассетом галереи. Никакого композита
   * и повторной нарезки. Ошибка одного объекта не роняет остальные —
   * его карточка получает статус error с кнопкой «Повторить».
   */
  const processObjects = useCallback(async (
    selections: SelectionItem[],
    options: { excludeNested: boolean }
  ) => {
    const dataUrl = originalImageSrc;
    if (!dataUrl || selections.length === 0) return;

    const requestId = ++imageLoadRequestIdRef.current;
    setView('processing');
    setAiProgress('Подготовка...');
    setAiPercent(0);

    try {
      if (Capacitor.isNativePlatform()) {
        await ensureModelReady();
        if (requestId !== imageLoadRequestIdRef.current) return;
      }

      const img = await loadImage(dataUrl);
      if (requestId !== imageLoadRequestIdRef.current) return;

      const W = img.naturalWidth;
      const H = img.naturalHeight;

      // Кламп рамок; маска «умного» выделения сохраняется, только если её
      // размеры совпали с рамкой после клампа (иначе координаты бы поплыли)
      const clampedSelections: SelectionItem[] = selections.map(s => {
        const rect = clampRectToBounds(s.rect, W, H);
        const mask =
          s.mask && s.mask.width === rect.width && s.mask.height === rect.height
            ? s.mask
            : undefined;
        return { rect, mask };
      });
      // Выделения сохраняем: кнопка «К выбору объектов» вернёт их в селектор,
      // а retry одного объекта использует их как контекст вложенности
      setSavedSelections(clampedSelections);
      savedSelectionsRef.current = clampedSelections;
      lastExcludeNestedRef.current = options.excludeNested;

      const stamp = Date.now();
      const pendingAssets: ObjectAsset[] = clampedSelections.map((sel, i) => ({
        id: `obj-${stamp}-${i}`,
        label: `Объект ${i + 1}`,
        rect: sel.rect,
        blob: null,
        displayUrl: null,
        width: Math.round(sel.rect.width),
        height: Math.round(sel.rect.height),
        status: 'pending',
        selectionIndex: i,
      }));

      // Заменяем ассеты предыдущего прогона (с revoke их objectURL-ов)
      revokeAssetUrls(objectAssetsRef.current);
      objectAssetsRef.current = pendingAssets;
      setObjectAssets(pendingAssets);
      // Галерея открывается сразу: карточки наполняются по мере обработки
      setView('gallery');

      // Кэши ИИ-результатов — на один прогон (retry переиспользует последние)
      aiResultCacheRef.current = [];
      regionAICacheRef.current = null;
      const runResults: (RectProcessResult | null)[] = clampedSelections.map(() => null);

      for (let i = 0; i < clampedSelections.length; i++) {
        if (requestId !== imageLoadRequestIdRef.current) return;
        const assetId = pendingAssets[i].id;

        setAiProgress(`Объект ${i + 1} из ${clampedSelections.length}`);
        setAiPercent(Math.round((i / clampedSelections.length) * 100));
        setObjectAssets(prev => prev.map(a =>
          a.id === assetId ? { ...a, status: 'processing' as const } : a
        ));

        try {
          const res = await processOneSelection(img, clampedSelections[i], clampedSelections);
          if (requestId !== imageLoadRequestIdRef.current) {
            try { URL.revokeObjectURL(res.displayUrl); } catch (e) {}
            return;
          }
          runResults[i] = res;
          setObjectAssets(prev => prev.map(a =>
            a.id === assetId
              ? {
                  ...a,
                  blob: res.blob,
                  displayUrl: res.displayUrl,
                  width: res.width,
                  height: res.height,
                  status: 'done' as const,
                  error: undefined,
                  note: res.note,
                }
              : a
          ));
        } catch (err: any) {
          console.error(`Object ${i + 1} processing failed:`, err);
          if (requestId !== imageLoadRequestIdRef.current) return;
          setObjectAssets(prev => prev.map(a =>
            a.id === assetId
              ? { ...a, status: 'error' as const, error: err?.message || String(err) }
              : a
          ));
        }
      }

      if (requestId !== imageLoadRequestIdRef.current) return;

      // Пост-проход «Исключать вложенные»: по ГОТОВОЙ альфе вложенного объекта
      // (маска цвета для белого-на-белом пуста — реальная альфа надёжнее)
      if (options.excludeNested) {
        setAiProgress('Исключение вложенных объектов...');
        for (let a = 0; a < clampedSelections.length; a++) {
          const resA = runResults[a];
          if (!resA) continue;
          const rectA = clampedSelections[a].rect;
          const aArea = rectA.width * rectA.height;
          const innerIdx: number[] = [];
          for (let b = 0; b < clampedSelections.length; b++) {
            if (b === a || !runResults[b]) continue;
            const rb = clampedSelections[b].rect;
            const bArea = rb.width * rb.height;
            // «Вложенный» = БОЛЬШАЯ ЧАСТЬ (>50%) внутри родителя И заметно меньше
            // его по площади (рамка алмаза у пользователя торчит из рамки короны
            // на ~треть — пороги 90%/70% это молча пропускали; guard по размеру
            // не даёт двум соседним крупным рамкам грызть друг друга)
            if (
              bArea > 0 &&
              bArea <= 0.6 * aArea &&
              rectIntersectionArea(rectA, rb) >= 0.5 * bArea
            ) innerIdx.push(b);
          }
          if (innerIdx.length === 0) continue;

          try {
            const aCanvas = await blobToSizedCanvas(resA.blob, resA.width, resA.height);
            const aCtx = aCanvas.getContext('2d', { willReadFrequently: true });
            if (!aCtx) continue;
            const aData = aCtx.getImageData(0, 0, aCanvas.width, aCanvas.height);
            let changed = false;
            for (const b of innerIdx) {
              const resB = runResults[b]!;
              const rectB = clampedSelections[b].rect;
              const bCanvas = await blobToSizedCanvas(resB.blob, resB.width, resB.height);
              const bCtx = bCanvas.getContext('2d', { willReadFrequently: true });
              if (!bCtx) continue;
              const bData = bCtx.getImageData(0, 0, bCanvas.width, bCanvas.height).data;
              const bw = bCanvas.width, bh = bCanvas.height;
              const bMask = new Uint8Array(bw * bh);
              for (let p = 0; p < bMask.length; p++) if (bData[p * 4 + 3] > 32) bMask[p] = 1;
              const bDilated = dilateBinary(bMask, bw, bh, 2);
              // Смещение результата B относительно результата A (учёт trim-offset обоих)
              const dx = Math.round(rectB.x + resB.offsetX - (rectA.x + resA.offsetX));
              const dy = Math.round(rectB.y + resB.offsetY - (rectA.y + resA.offsetY));
              for (let y = 0; y < bh; y++) {
                const ay = y + dy;
                if (ay < 0 || ay >= aCanvas.height) continue;
                for (let x = 0; x < bw; x++) {
                  if (bDilated[y * bw + x] !== 1) continue;
                  const ax = x + dx;
                  if (ax < 0 || ax >= aCanvas.width) continue;
                  aData.data[(ay * aCanvas.width + ax) * 4 + 3] = 0;
                  changed = true;
                }
              }
            }
            if (!changed) continue;
            aCtx.putImageData(aData, 0, 0);
            const trimmed = await trimCanvasTransparent(aCanvas);
            if (requestId !== imageLoadRequestIdRef.current) {
              if (trimmed) try { URL.revokeObjectURL(trimmed.displayUrl); } catch (e) {}
              return;
            }
            // Если после вычитания ничего не осталось — оставляем как было
            if (!trimmed) continue;
            const assetId = pendingAssets[a].id;
            try { URL.revokeObjectURL(resA.displayUrl); } catch (e) {}
            runResults[a] = {
              ...trimmed,
              offsetX: resA.offsetX + trimmed.offsetX,
              offsetY: resA.offsetY + trimmed.offsetY,
              note: resA.note,
            };
            setObjectAssets(prev => prev.map(x =>
              x.id === assetId
                ? { ...x, blob: trimmed.blob, displayUrl: trimmed.displayUrl, width: trimmed.width, height: trimmed.height }
                : x
            ));
          } catch (e) {
            console.warn('Nested exclusion post-pass failed for object', a + 1, e);
          }
        }
      }

      if (requestId !== imageLoadRequestIdRef.current) return;
      setAiPercent(100);
    } catch (error: any) {
      if (requestId !== imageLoadRequestIdRef.current) return;
      console.error('Per-object AI processing failed:', error);
      const errMsg = error?.message || String(error);
      if (errMsg.includes('Model not preloaded')) {
        alert('Модель ИИ не загружена. Пожалуйста, откройте настройки и скачайте модель.');
      } else {
        alert('Обработка объектов не удалась: ' + errMsg);
      }
      // Возвращаемся на экран выбора объектов
      setView('selecting');
    } finally {
      if (requestId === imageLoadRequestIdRef.current) {
        setAiPercent(0);
      }
    }
  }, [originalImageSrc, ensureModelReady, processOneSelection]);

  /** Повторный ИИ-прогон одной упавшей рамки из галереи. */
  const retryObjectAsset = useCallback(async (assetId: string) => {
    const dataUrl = originalImageSrc;
    if (!dataUrl) return;
    const target = objectAssetsRef.current.find(a => a.id === assetId);
    if (!target || target.status === 'processing') return;

    const requestId = imageLoadRequestIdRef.current;
    const oldDisplayUrl = target.displayUrl;
    setAiProgress(`Повторная обработка: ${target.label}`);
    setAiPercent(0);
    setObjectAssets(prev => prev.map(a =>
      a.id === assetId
        ? { ...a, status: 'processing' as const, error: undefined }
        : a
    ));

    try {
      if (Capacitor.isNativePlatform()) {
        await ensureModelReady();
        if (requestId !== imageLoadRequestIdRef.current) return;
      }

      const img = await loadImage(dataUrl);
      if (requestId !== imageLoadRequestIdRef.current) return;

      // Повтор идёт через общий конвейер с контекстом последнего прогона
      // (маска «умного» выделения и вычитание вложенных сохраняются)
      const allSelections = savedSelectionsRef.current || [];
      const selfIndex =
        target.selectionIndex !== undefined &&
        allSelections[target.selectionIndex] &&
        allSelections[target.selectionIndex].rect.x === target.rect.x &&
        allSelections[target.selectionIndex].rect.y === target.rect.y
          ? target.selectionIndex
          : -1;
      const selection: SelectionItem =
        selfIndex >= 0 ? allSelections[selfIndex] : { rect: target.rect };

      // Кэш прошлого прогона переиспользуется: retry вложенной рамки берёт
      // объект из готового результата охватывающей (ступень 2.4)
      const res = await processOneSelection(
        img,
        selection,
        allSelections.length > 0 ? allSelections : [selection]
      );
      if (requestId !== imageLoadRequestIdRef.current) {
        try { URL.revokeObjectURL(res.displayUrl); } catch (e) {}
        return;
      }

      if (oldDisplayUrl) {
        try { URL.revokeObjectURL(oldDisplayUrl); } catch (e) {}
      }
      setObjectAssets(prev => prev.map(a =>
        a.id === assetId
          ? {
              ...a,
              blob: res.blob,
              displayUrl: res.displayUrl,
              width: res.width,
              height: res.height,
              status: 'done' as const,
              error: undefined,
              note: res.note,
            }
          : a
      ));
      setAiPercent(100);
    } catch (err: any) {
      if (requestId !== imageLoadRequestIdRef.current) return;
      console.error('Object retry failed:', err);
      setObjectAssets(prev => prev.map(a =>
        a.id === assetId
          ? { ...a, status: 'error' as const, error: err?.message || String(err) }
          : a
      ));
    }
  }, [originalImageSrc, ensureModelReady, processOneSelection]);

  /** Переименование ассета в галерее (имя файла при скачивании). */
  const renameObjectAsset = useCallback((assetId: string, label: string) => {
    setObjectAssets(prev => prev.map(a => (a.id === assetId ? { ...a, label } : a)));
  }, []);

  /** «← К выбору объектов»: назад в селектор с сохранёнными рамками. */
  const handleBackToSelector = useCallback(() => {
    clearObjectAssets();
    setView('selecting');
  }, [clearObjectAssets]);

  /** «Открыть в редакторе»: легаси-Workspace с оригинальным листом. */
  const handleOpenInEditor = useCallback(() => {
    if (!originalImageSrc) return;
    clearObjectAssets();
    setInitialSlices(null);
    setImageSrc(originalImageSrc);
    setView('legacy-workspace');
  }, [originalImageSrc, clearObjectAssets]);

  const handleSlicesUpdated = useCallback((newSlices: Slice[], imgData: ImageData, origData?: ImageData, kColor?: ColorRGB) => {
    setSlices(newSlices);
    processedImageDataRef.current = imgData;
    if (origData) {
      originalImageDataRef.current = origData;
    }
    if (kColor) {
      setKeyColor(kColor);
    } else {
      setKeyColor(null);
    }
    setDataVersion(v => v + 1);
  }, []);

  const handleAssetUpdated = useCallback((asset: ProcessedAsset) => {
    setAssets(prev => ({
      ...prev,
      [asset.id]: asset
    }));
  }, []);

  const handleReset = useCallback(() => {
    imageLoadRequestIdRef.current++;
    clearObjectAssets();
    setSavedSelections(null);
    savedSelectionsRef.current = null;
    revokeAllBlobs();
    pendingFileRef.current = null;
    setInitialSlices(null);
    setImageSrc(null);
    setOriginalImageSrc(null);
    setSlices([]);
    processedImageDataRef.current = null;
    originalImageDataRef.current = null;
    setKeyColor(null);
    setAssets({});
    setDataVersion(0);
    setView('upload');
  }, [clearObjectAssets]);

  // Triggers zipping and downloading all active assets in a single structured file
  const handleDownloadAll = async () => {
    const activeAssets = (Object.values(assets) as ProcessedAsset[]).filter(asset =>
      slices.some(s => s.id === asset.id)
    );
    if (activeAssets.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();

      const nameCounts: Record<string, number> = {};
      activeAssets.forEach(asset => {
        // Sanitize name: remove path traversal, filesystem wildcards, replace slashes
        let safeName = asset.name.replace(/[\/\\?%*:|"<>\s]+/g, '_').trim();
        if (!safeName || safeName === '_') {
          safeName = 'asset';
        }
        
        // Prevent naming collisions
        if (nameCounts[safeName] !== undefined) {
          nameCounts[safeName]++;
          safeName = `${safeName}_${nameCounts[safeName]}`;
        } else {
          nameCounts[safeName] = 1;
        }

        // 1. Add SVG files to root
        zip.file(`${safeName}.svg`, asset.svgCode);

        // 2. Add compressed/configured raster files to a format-named subfolder
        const rasterUrl = asset.rasterDataUrl || asset.pngDataUrl;
        const format = asset.rasterFormat || 'png';
        if (rasterUrl && rasterUrl.includes(',')) {
          const base64Content = rasterUrl.split(',')[1];
          zip.file(`${format}/${safeName}.${format}`, base64Content, { base64: true });
        }
      });

      const zipFilename = `sliced_assets_${Date.now()}.zip`;
      const { downloadBinaryFile } = await import('./utils/downloadHelper');

      if (Capacitor.isNativePlatform()) {
        const base64Content = await zip.generateAsync({ type: 'base64' });
        await downloadBinaryFile(zipFilename, base64Content);
      } else {
        const content = await zip.generateAsync({ type: 'blob' });
        await downloadBinaryFile(zipFilename, '', content);
      }
    } catch (err) {
      console.error('Failed to create ZIP archive:', err);
      alert('Ошибка создания ZIP-архива: ' + String(err));
    } finally {
      setIsZipping(false);
    }
  };

  const preloadLocalModel = async () => {
    setIsModelDownloading(true);
    setModelDownloadProgress(0);
    setModelFetchInfo(null);
    let progressListener: { remove: () => void } | null = null;
    let legacyListener: { remove: () => void } | null = null;
    try {
      if (Capacitor.isNativePlatform()) {
        const totalFallback = customModelUrl === BIREFNET_MODEL_URL ? BIREFNET_MODEL_SIZE_BYTES : customModelUrl === BIREFNET_BASE_MODEL_URL ? BIREFNET_BASE_MODEL_SIZE_BYTES : 0;
        progressListener = await BackgroundRemoval.addListener(
          'modelDownloadProgress',
          (info) => {
            if (!info || typeof info.loaded !== 'number') return;
            const total = info.total > 0 ? info.total : totalFallback;
            setModelFetchInfo({ loaded: info.loaded, total, resumed: !!info.resumed });
            if (total > 0) {
              setModelDownloadProgress(
                Math.max(0, Math.min(100, Math.round((info.loaded / total) * 100)))
              );
            }
          }
        );
        // Легаси-событие с процентами — как фолбэк для старых версий плагина
        legacyListener = await BackgroundRemoval.addListener(
          'downloadProgress',
          (info) => {
            if (info && typeof info.percent === 'number') {
              setModelDownloadProgress(info.percent);
            }
          }
        );

        await BackgroundRemoval.preloadModel({
          url: customModelUrl,
          sha256: getSha256ForUrl(customModelUrl),
        });
        await checkCustomModelCacheStatus();
        setIsModelDownloading(false);
        setModelDownloadProgress(null);
        alert('Модель ИИ успешно загружена и кэширована!');
      } else {
        const { preload } = await import('@imgly/background-removal');
        await preload({
          model: localModel as any,
          publicPath: modelDownloadUrl,
          progress: (key, current, total) => {
            let percent = 0;
            if (total && !isNaN(total) && total > 0) {
              percent = Math.round((current / total) * 100);
            } else if (current > 0) {
              percent = Math.min(95, Math.round(current / (1024 * 1024)));
            }
            const displayPercent = Math.min(100, Math.max(0, percent));
            setModelDownloadProgress(displayPercent);
          }
        });
        alert('Модель ИИ успешно загружена и кэширована!');
        setIsModelDownloading(false);
        setModelDownloadProgress(null);
      }
    } catch (err) {
      console.error('Failed to preload local model:', err);
      alert('Ошибка при загрузке модели: ' + String((err as any).message || err));
      setIsModelDownloading(false);
      setModelDownloadProgress(null);
    } finally {
      if (progressListener) {
        progressListener.remove();
      }
      if (legacyListener) {
        legacyListener.remove();
      }
      setModelFetchInfo(null);
    }
  };

  const activeAssetsCount = slices.filter(s => !!assets[s.id]).length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-violet-500/30 selection:text-violet-250">

      {/* Premium Header */}
      <header className="w-full bg-zinc-900/65 border-b border-zinc-800/80 sticky top-0 z-40 backdrop-blur-xl shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Scissors className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-extrabold text-zinc-100 text-sm sm:text-base leading-tight tracking-tight">
                Нарезка и Векторизация
              </h1>
              <p className="text-[10px] text-zinc-400 font-semibold tracking-wider uppercase">
                Asset Slicer & SVG Vectorizer
              </p>
            </div>
          </div>

          {/* Actions & Stats */}
          <div className="flex items-center gap-3">
            {imageSrc && (
              <div className="flex items-center gap-2 bg-zinc-950/60 border border-zinc-800/60 rounded-full px-4 py-1.5 text-xs shadow-inner">
                <Smartphone className="w-3.5 h-3.5 text-violet-400" />
                <span className="text-zinc-400 font-medium hidden sm:inline">Готово для телефона:</span>
                <span className="text-emerald-400 font-bold font-mono">{slices.length} объектов</span>
              </div>
            )}
            
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 border border-zinc-800/50 hover:border-zinc-700/80 rounded-2xl transition-all duration-300 shadow-md active:scale-95 cursor-pointer"
              title="Настройки ИИ и скачивания"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">

          {view === 'processing' ? (
            <div className="flex-1 flex flex-col items-center justify-center py-20 animate-in fade-in duration-300">
              <div className="relative mb-8">
                {/* Glowing ring effects */}
                <div className="absolute inset-0 bg-violet-500/20 rounded-3xl blur-xl animate-pulse" />
                <div className="w-20 h-20 bg-zinc-900 border border-zinc-800 rounded-3xl flex items-center justify-center shadow-2xl relative animate-bounce duration-1000">
                  <Sparkles className="w-10 h-10 text-violet-400 animate-pulse" />
                </div>
              </div>
              
              <h3 className="font-extrabold text-white text-xl sm:text-2xl mb-1.5 flex items-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
                {aiProgress}
              </h3>
              
              {/* Percentage Indicator */}
              <span className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-emerald-400 font-mono tracking-tight mb-4">
                {aiPercent}%
              </span>

              {/* Progress Bar */}
              <div className="w-72 bg-zinc-950 border border-zinc-850 rounded-full h-3.5 p-0.5 overflow-hidden mb-6 shadow-inner relative">
                <div
                  className="h-full bg-gradient-to-r from-violet-600 via-fuchsia-500 to-emerald-500 transition-all duration-550 ease-out rounded-full shadow-[0_0_12px_rgba(167,139,250,0.4)]"
                  style={{ width: `${aiPercent}%` }}
                />
              </div>
              <p className="text-zinc-400 text-sm max-w-xs text-center leading-relaxed">
                {modelFetchInfo
                  ? 'Модель ИИ скачивается на устройство. Прерванная загрузка продолжится с того же места (докачка).'
                  : 'Локальная нейросеть вырезает фон прямо в вашем браузере. Это абсолютно безопасно и работает офлайн.'}
              </p>
              <button
                onClick={handleCancelProcessing}
                className="mt-6 flex items-center gap-1.5 py-2.5 px-5 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95"
                title="Прервать обработку и вернуться назад"
              >
                <X className="w-3.5 h-3.5" />
                Отменить
              </button>
            </div>
          ) : view === 'selecting' && originalImageSrc ? (
            /* Object Selection State (before AI processing) */
            <ObjectSelector
              imageSrc={originalImageSrc}
              initialSelections={savedSelections}
              onCancel={handleReset}
              onProcessObjects={processObjects}
              onProcessWholeSheet={processWholeSheet}
            />
          ) : view === 'gallery' ? (
            /* Gallery of ready-made per-object assets (new main flow) */
            <AssetGallery
              assets={objectAssets}
              isProcessing={isGalleryProcessing}
              progressText={aiProgress}
              progressPercent={aiPercent}
              onRetry={retryObjectAsset}
              onRename={renameObjectAsset}
              onBackToSelector={handleBackToSelector}
              onOpenInEditor={handleOpenInEditor}
            />
          ) : view !== 'legacy-workspace' || !imageSrc ? (
            /* Upload State */
            <div
              key="uploader-view"
              className="flex-1 flex flex-col items-center justify-center py-8 lg:py-16 animate-in fade-in slide-in-from-bottom-4 duration-500"
            >
              {/* Introduction Text Block */}
              <div className="text-center max-w-2xl mb-10">
                <div className="inline-flex items-center gap-2 bg-zinc-900/80 border border-zinc-800 text-violet-400 font-semibold text-xs rounded-full px-4 py-2 mb-5 shadow-lg shadow-black/10">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400 animate-pulse" />
                  Оптимизировано для мобильных телефонов
                </div>
                <h2 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight px-4 bg-clip-text bg-gradient-to-b from-white to-zinc-300">
                  Вырезайте ассеты, удаляйте фон и конвертируйте в SVG за секунды
                </h2>
                <p className="text-zinc-400 text-sm sm:text-base mt-3.5 px-6 leading-relaxed max-w-xl mx-auto">
                  Загрузите любое изображение, логотип или коллаж графики. Приложение автоматически разделит его на прозрачные, аккуратно кадрированные векторные файлы.
                </p>
              </div>

              {/* Uploader Card */}
              <ImageUploader
                onImageSelected={handleImageSelected}
                useAIBgRemoval={useAIBgRemoval}
                onUseAIBgRemovalChange={setUseAIBgRemoval}
                localModel={localModel}
                onOpenSettings={() => setIsSettingsOpen(true)}
              />

              {/* Explanatory visual step-by-step footer */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl w-full mt-14 pt-8 border-t border-zinc-900">
                <div className="flex items-start gap-3 bg-zinc-900/20 border border-zinc-900/50 rounded-2xl p-4">
                  <div className="w-7 h-7 rounded-full bg-zinc-900 text-violet-400 border border-zinc-800 font-bold text-xs flex items-center justify-center shrink-0 shadow-inner">1</div>
                  <div>
                    <h5 className="font-bold text-zinc-200 text-xs sm:text-sm">Загрузка листа</h5>
                    <p className="text-[10.5px] text-zinc-400 leading-relaxed mt-1">Сделайте фото на камеру или выберите картинку с иконками.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 bg-zinc-900/20 border border-zinc-900/50 rounded-2xl p-4">
                  <div className="w-7 h-7 rounded-full bg-zinc-900 text-violet-400 border border-zinc-800 font-bold text-xs flex items-center justify-center shrink-0 shadow-inner">2</div>
                  <div>
                    <h5 className="font-bold text-zinc-200 text-xs sm:text-sm">Авто-нарезка и чистка</h5>
                    <p className="text-[10.5px] text-zinc-400 leading-relaxed mt-1">Фон становится прозрачным. Объекты нарезаются в отдельные рамки.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 bg-zinc-900/20 border border-zinc-900/50 rounded-2xl p-4">
                  <div className="w-7 h-7 rounded-full bg-zinc-900 text-violet-400 border border-zinc-800 font-bold text-xs flex items-center justify-center shrink-0 shadow-inner">3</div>
                  <div>
                    <h5 className="font-bold text-zinc-200 text-xs sm:text-sm">Векторный SVG экспорт</h5>
                    <p className="text-[10.5px] text-zinc-400 leading-relaxed mt-1">Получите чистые SVG файлы или скопируйте код прямо в разметку.</p>
                  </div>
                </div>
              </div>

            </div>
          ) : (
            /* Active Workspace State */
            <div
              key="workspace-view"
              className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500"
            >

              {/* Workspace Board */}
              <Workspace
                imageSrc={originalImageSrc || imageSrc!}
                aiImageSrc={useAIBgRemoval && imageSrc !== originalImageSrc ? imageSrc : null}
                initialSlices={initialSlices}
                onSlicesUpdated={handleSlicesUpdated}
                onReset={handleReset}
              />

              {/* Sliced Output Result Assets Area */}
              <div id="results-section" className="w-full border-t border-zinc-800/80 pt-10 pb-16">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                  <div>
                    <h3 className="font-extrabold text-zinc-100 text-lg sm:text-xl flex items-center gap-2.5">
                      <Layers className="w-5.5 h-5.5 text-violet-400" />
                      Результаты нарезки ассетов
                    </h3>
                    <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                      Каждый выделенный объект вырезан с прозрачным фоном и готов к загрузке в SVG формате.
                    </p>
                  </div>

                  {/* Batch Actions */}
                  {activeAssetsCount > 0 && (
                    <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                      <button
                        id="btn-download-all"
                        onClick={handleDownloadAll}
                        disabled={isZipping}
                        className="flex items-center gap-2 py-3 px-6 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-850 disabled:to-zinc-850 text-white rounded-2xl font-bold text-xs transition-all duration-300 shadow-[0_4px_12px_rgba(124,58,237,0.25)] hover:shadow-[0_4px_20px_rgba(124,58,237,0.4)] active:scale-95 w-full sm:w-auto justify-center cursor-pointer"
                      >
                        {isZipping ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Создание ZIP архива...
                          </>
                        ) : (
                          <>
                            <FolderDown className="w-4 h-4" />
                            Скачать все ассеты в ZIP-архиве
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Grid Lists of Assets */}
                {slices.length === 0 ? (
                  <div className="w-full bg-zinc-900/30 border border-zinc-800/80 rounded-3xl p-12 text-center flex flex-col items-center justify-center shadow-lg relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-tr from-violet-500/5 via-transparent to-transparent pointer-events-none" />
                    <div className="w-14 h-14 bg-zinc-900/80 rounded-2xl flex items-center justify-center border border-zinc-800 mb-4 text-zinc-400 shadow-md">
                      <Info className="w-6 h-6 text-zinc-400" />
                    </div>
                    <h5 className="font-bold text-zinc-200 text-sm sm:text-base mb-2">
                      Объекты не обнаружены
                    </h5>
                    <p className="text-xs text-zinc-400 max-w-md leading-relaxed">
                      Попробуйте отрегулировать допуск цвета фона во вкладке **Фон**, уменьшить **Размер объекта** или обведите границы нужного элемента вручную в режиме **Выделение**.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    {processedImageDataRef.current && slices.map(slice => (
                      <AssetCard
                        key={slice.id}
                        slice={slice}
                        processedImageData={processedImageDataRef.current!}
                        originalImageData={originalImageDataRef.current}
                        keyColor={keyColor}
                        onAssetUpdated={handleAssetUpdated}
                      />
                    ))}
                  </div>
                )}
              </div>

            </div>
          )}

      </main>

      {/* Clean Mobile-friendly footer */}
      <footer className="w-full border-t border-zinc-900 bg-zinc-950 py-8 mt-auto text-center text-zinc-550 text-xs px-4">
        <p className="font-medium tracking-wide">
          Asset Slicer & SVG Vectorizer — Удобное кадрирование и векторизация графики прямо с мобильного телефона.
        </p>
      </footer>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-zinc-950/80 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-in fade-in duration-300">
          <div className="bg-zinc-900/90 border border-zinc-800/80 backdrop-blur-2xl rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-300">
            {/* Modal Header */}
            <div className="px-6 py-5 border-b border-zinc-800/60 flex items-center justify-between bg-zinc-950/40">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center shadow-md">
                  <Settings className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-zinc-100 text-sm sm:text-base tracking-tight">Настройки ИИ и Экспорта</h3>
                  <p className="text-[10px] text-zinc-450 font-semibold uppercase tracking-wider">Конфигурация для Android и Web</p>
                </div>
              </div>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-all border border-transparent hover:border-zinc-700/50 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 flex-1 overflow-y-auto space-y-6">
              
              {Capacitor.isNativePlatform() ? (
                <div className="bg-zinc-900/15 border border-zinc-850/60 rounded-2xl p-5 space-y-5 shadow-md relative overflow-hidden backdrop-blur-md">
                  <div className="absolute inset-0 bg-gradient-to-tr from-violet-600/4 via-indigo-600/1 to-transparent pointer-events-none" />
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-violet-400" />
                      <label className="text-[11px] tracking-widest font-extrabold text-zinc-300 uppercase">Нативная модель ИИ (Android)</label>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-wider block">Сохраненные локальные модели:</span>
                      <span className="text-[9px] text-zinc-550 font-bold uppercase tracking-widest">Всего: {modelsList.length}</span>
                    </div>
                    
                    <div className="grid grid-cols-1 gap-3 max-h-[225px] overflow-y-auto pr-1.5 scrollbar-thin">
                      {modelsList.map((model, idx) => {
                        const isActive = customModelUrl === model.url;
                        const isCached = cacheStatuses[model.url] || false;
                        return (
                          <div 
                            key={idx}
                            onClick={async () => {
                              setCustomModelUrl(model.url);
                              localStorage.setItem('customModelUrl', model.url);
                              await checkCustomModelCacheStatus(model.url);
                            }}
                            className={`p-4 rounded-2xl border transition-all duration-300 cursor-pointer flex flex-col gap-2 relative overflow-hidden active:scale-[0.98] active:translate-y-[1px] ${
                              isActive
                                ? 'bg-violet-950/25 border-violet-500 shadow-[0_4px_20px_rgba(139,92,246,0.15)]'
                                : 'bg-zinc-950/50 border-zinc-850/70 hover:bg-zinc-900/30 hover:border-zinc-700/60'
                            }`}
                          >
                            <div className="flex justify-between items-center">
                              <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-violet-400 animate-pulse' : 'bg-zinc-650'}`} />
                                <span className="text-xs font-bold text-zinc-200 font-sans tracking-tight">{model.name}</span>
                              </div>
                              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900/80 text-zinc-400 font-mono font-bold">{model.sizeLabel}</span>
                                {!model.isPreset && (
                                  <button
                                    onClick={() => {
                                      const updated = modelsList.filter((_, i) => i !== idx);
                                      setModelsList(updated);
                                      localStorage.setItem('user_models_list', JSON.stringify(updated));
                                      if (isActive && updated.length > 0) {
                                        setCustomModelUrl(updated[0].url);
                                        localStorage.setItem('customModelUrl', updated[0].url);
                                        checkCustomModelCacheStatus(updated[0].url, updated);
                                      } else {
                                        checkCustomModelCacheStatus(customModelUrl, updated);
                                      }
                                    }}
                                    className="w-6.5 h-6.5 rounded-lg bg-red-950/20 hover:bg-red-900/40 text-red-400 hover:text-red-350 flex items-center justify-center transition-all duration-200 cursor-pointer active:scale-90 hover:scale-105 border border-red-900/30 hover:border-red-900/50 shadow-sm"
                                    title="Удалить модель из списка"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-relaxed font-normal">
                              {model.description}
                            </p>
                            
                            <div className="flex justify-between items-center mt-1 border-t border-zinc-850/40 pt-2 text-[10px] font-bold uppercase tracking-wide">
                              {isCached ? (
                                <span className="text-emerald-400 flex items-center gap-1.5 font-semibold">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                  Готова к работе
                                </span>
                              ) : (
                                <span className="text-amber-400 flex items-center gap-1.5 font-semibold">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                  Требуется загрузка
                                </span>
                              )}
                              {isActive && (
                                <span className="text-violet-400 font-extrabold text-[9px] bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full uppercase tracking-wide animate-pulse">
                                  Активна
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Add Custom Model Form */}
                    <div className="bg-zinc-950/60 border border-zinc-850/70 rounded-2xl p-4.5 space-y-3.5 relative overflow-hidden backdrop-blur-md">
                      <span className="text-[10px] text-zinc-400 font-extrabold uppercase tracking-wider block">Добавить свою ONNX модель в список:</span>
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={newModelName}
                          onChange={(e) => setNewModelName(e.target.value)}
                          placeholder="Название (например, BiRefNet-General)"
                          className="w-full bg-zinc-950/60 border border-zinc-850 hover:border-zinc-750 focus:border-violet-500/80 focus:ring-[3px] focus:ring-violet-500/10 rounded-xl px-3.5 py-2 text-xs text-zinc-200 placeholder-zinc-650 transition-all duration-300 outline-none"
                        />
                        <input
                          type="text"
                          value={newModelUrl}
                          onChange={(e) => setNewModelUrl(e.target.value)}
                          placeholder="Прямой URL-адрес к .onnx файлу"
                          className="w-full bg-zinc-950/60 border border-zinc-850 hover:border-zinc-750 focus:border-violet-500/80 focus:ring-[3px] focus:ring-violet-500/10 rounded-xl px-3.5 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-650 transition-all duration-300 outline-none"
                        />
                        <button
                          onClick={async () => {
                            if (!newModelName.trim() || !newModelUrl.trim()) {
                              alert('Пожалуйста, введите название и URL модели');
                              return;
                            }
                            if (!newModelUrl.startsWith('http://') && !newModelUrl.startsWith('https://')) {
                              alert('URL модели должен начинаться с http:// или https://');
                              return;
                            }
                            const urlNormalized = newModelUrl.trim();
                            if (modelsList.some(m => m.url === urlNormalized)) {
                              alert('Модель с таким URL уже добавлена в список');
                              return;
                            }
                            const newModel: SavedModel = {
                              name: newModelName.trim(),
                              url: urlNormalized,
                              sizeLabel: 'ONNX',
                              isPreset: false,
                              description: 'Пользовательская модель.'
                            };
                            const updated = [...modelsList, newModel];
                            setModelsList(updated);
                            localStorage.setItem('user_models_list', JSON.stringify(updated));
                            setNewModelName('');
                            setNewModelUrl('');
                            
                            // Auto-select the newly added model
                            setCustomModelUrl(newModel.url);
                            localStorage.setItem('customModelUrl', newModel.url);
                            await checkCustomModelCacheStatus(newModel.url, updated);
                          }}
                          className="w-full py-2.5 bg-gradient-to-r from-violet-950/40 to-indigo-950/40 hover:from-violet-900/35 hover:to-indigo-900/35 border border-violet-850/50 hover:border-violet-600/40 text-[11px] font-bold text-violet-300 hover:text-violet-200 rounded-xl transition-all duration-300 cursor-pointer active:scale-[0.98] shadow-sm flex items-center justify-center gap-1.5"
                        >
                          + Добавить в список
                        </button>
                      </div>
                    </div>

                    {/* Active Download Progress / Action Button */}
                    <div className="pt-2 border-t border-zinc-850/60">
                      {isModelDownloading ? (
                        <div className="bg-zinc-950/60 border border-zinc-850 rounded-2xl p-4 space-y-2.5">
                          <div className="flex justify-between text-[11px] font-bold text-zinc-300">
                            <span className="flex items-center gap-1.5 font-sans">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                              {modelFetchInfo && modelFetchInfo.total > 0
                                ? `Загрузка модели… ${formatMb(modelFetchInfo.loaded)} / ${formatMb(modelFetchInfo.total)} МБ`
                                : 'Загрузка модели...'}
                              {modelFetchInfo?.resumed && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 uppercase tracking-wide font-extrabold">
                                  докачка
                                </span>
                              )}
                            </span>
                            <span className="text-violet-400 font-mono">{modelDownloadProgress}%</span>
                          </div>
                          <div className="w-full bg-zinc-950 h-2 border border-zinc-850 rounded-full overflow-hidden p-0.5">
                            <div
                              className="bg-gradient-to-r from-violet-500 to-emerald-500 h-full rounded-full transition-all duration-300 ease-out"
                              style={{ width: `${modelDownloadProgress}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        !cacheStatuses[customModelUrl] && (
                          <button
                            onClick={preloadLocalModel}
                            className="w-full py-3 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white border border-violet-500/20 rounded-xl text-xs font-bold transition-all duration-300 shadow-lg shadow-violet-950/30 hover:shadow-violet-900/45 active:scale-[0.97] flex items-center justify-center gap-2 cursor-pointer"
                          >
                            <FolderDown className="w-4 h-4" />
                            Скачать выбранную модель
                          </button>
                        )
                      )}
                    </div>

                    {/* Cache Actions */}
                    <div className="pt-1 flex justify-between gap-3">
                      <button
                        onClick={clearCustomModelCache}
                        className="flex-1 py-2.5 px-3 bg-red-950/15 hover:bg-red-950/30 border border-red-900/30 hover:border-red-800/40 rounded-xl text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-350 transition-all duration-250 cursor-pointer active:scale-[0.97] shadow-sm"
                      >
                        Очистить кэш
                      </button>
                      <button
                        onClick={async () => {
                          const url = DEFAULT_PRESETS[0].url;
                          setModelsList(DEFAULT_PRESETS);
                          localStorage.setItem('user_models_list', JSON.stringify(DEFAULT_PRESETS));
                          setCustomModelUrl(url);
                          localStorage.setItem('customModelUrl', url);
                          await checkCustomModelCacheStatus(url, DEFAULT_PRESETS);
                        }}
                        className="py-2.5 px-3 bg-zinc-900/40 hover:bg-zinc-800/50 border border-zinc-800 hover:border-zinc-700 rounded-xl text-[10px] font-bold uppercase tracking-wider text-zinc-450 hover:text-zinc-200 transition-all duration-250 cursor-pointer active:scale-[0.97] shadow-sm"
                      >
                        Сбросить
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Card 1: AI Model Selection for Web */
                <div className="bg-zinc-900/15 border border-zinc-850/60 rounded-2xl p-5 space-y-4 shadow-md relative overflow-hidden backdrop-blur-md">
                  <div className="absolute inset-0 bg-gradient-to-tr from-violet-600/4 via-indigo-600/1 to-transparent pointer-events-none" />
                  
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-violet-400" />
                    <label className="text-[11px] tracking-widest font-extrabold text-zinc-300 uppercase">Модель ИИ (Браузерная версия)</label>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {/* Web Option 1: isnet_quint8 */}
                    <div 
                      onClick={() => {
                        const url = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal-data@1.4.5/dist/';
                        setModelDownloadUrl(url);
                        localStorage.setItem('modelDownloadUrl', url);
                        setLocalModel('isnet_quint8');
                        localStorage.setItem('localModel', 'isnet_quint8');
                      }}
                      className={`p-4 rounded-2xl border transition-all duration-300 cursor-pointer flex flex-col gap-2 relative overflow-hidden active:scale-[0.98] active:translate-y-[1px] ${
                        localModel === 'isnet_quint8'
                          ? 'bg-emerald-950/25 border-emerald-500 shadow-[0_4px_20px_rgba(16,185,129,0.15)]'
                          : 'bg-zinc-950/50 border-zinc-850/70 hover:bg-zinc-900/30 hover:border-zinc-700/60'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${localModel === 'isnet_quint8' ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-650'}`} />
                          <span className="text-xs font-bold text-zinc-200 font-sans tracking-tight">isnet_quint8 (Быстрая)</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900/80 text-zinc-400 font-mono font-bold">22 МБ</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 leading-relaxed font-normal">
                        Оптимизирована для мобильных и слабых ПК. Быстрый запуск, минимальное потребление ресурсов.
                      </p>
                    </div>

                    {/* Web Option 2: isnet_fp16 */}
                    <div 
                      onClick={() => {
                        const url = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal-data@1.4.5/dist/';
                        setModelDownloadUrl(url);
                        localStorage.setItem('modelDownloadUrl', url);
                        setLocalModel('isnet_fp16');
                        localStorage.setItem('localModel', 'isnet_fp16');
                      }}
                      className={`p-4 rounded-2xl border transition-all duration-300 cursor-pointer flex flex-col gap-2 relative overflow-hidden active:scale-[0.98] active:translate-y-[1px] ${
                        localModel === 'isnet_fp16'
                          ? 'bg-violet-950/25 border-violet-500 shadow-[0_4px_20px_rgba(139,92,246,0.15)]'
                          : 'bg-zinc-950/50 border-zinc-850/70 hover:bg-zinc-900/30 hover:border-zinc-700/60'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${localModel === 'isnet_fp16' ? 'bg-violet-400 animate-pulse' : 'bg-zinc-650'}`} />
                          <span className="text-xs font-bold text-zinc-200 font-sans tracking-tight">isnet_fp16 (Средняя)</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900/80 text-zinc-400 font-mono font-bold">44 МБ</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 leading-relaxed font-normal">
                        Стандартная модель. Оптимальное качество удаления фона для большинства картинок.
                      </p>
                    </div>

                    {/* Web Option 3: birefnet */}
                    <div 
                      onClick={() => {
                        const url = 'https://huggingface.co/ZhengPeng7/BiRefNet/resolve/main/';
                        setModelDownloadUrl(url);
                        localStorage.setItem('modelDownloadUrl', url);
                        setLocalModel('birefnet');
                        localStorage.setItem('localModel', 'birefnet');
                      }}
                      className={`p-4 rounded-2xl border transition-all duration-300 cursor-pointer flex flex-col gap-2 relative overflow-hidden active:scale-[0.98] active:translate-y-[1px] ${
                        localModel === 'birefnet'
                          ? 'bg-indigo-950/25 border-indigo-500 shadow-[0_4px_20px_rgba(99,102,241,0.15)]'
                          : 'bg-zinc-950/50 border-zinc-850/70 hover:bg-zinc-900/30 hover:border-zinc-700/60'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${localModel === 'birefnet' ? 'bg-indigo-400 animate-pulse' : 'bg-zinc-650'}`} />
                          <span className="text-xs font-bold text-zinc-200 font-sans tracking-tight">BiRefNet (Максимальная точность)</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900/80 text-zinc-400 font-mono font-bold">120+ МБ</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 leading-relaxed font-normal">
                        Новейшая и самая точная модель ИИ. Требует быстрой сети и хорошей производительности.
                      </p>
                    </div>
                  </div>

                  {/* Browser Download Progress */}
                  <div className="pt-2 border-t border-zinc-850/60">
                    {isModelDownloading ? (
                      <div className="bg-zinc-950/60 border border-zinc-850 rounded-2xl p-4 space-y-2.5">
                        <div className="flex justify-between text-[11px] font-bold text-zinc-300">
                          <span className="flex items-center gap-1.5 font-sans">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                            Загрузка модели ({localModel})...
                          </span>
                          <span className="text-violet-400 font-mono">{modelDownloadProgress}%</span>
                        </div>
                        <div className="w-full bg-zinc-950 h-2 border border-zinc-850 rounded-full overflow-hidden p-0.5">
                          <div
                            className="bg-gradient-to-r from-violet-500 to-emerald-500 h-full rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${modelDownloadProgress}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={preloadLocalModel}
                        className="w-full py-3 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white border border-violet-500/20 rounded-xl text-xs font-bold transition-all duration-300 shadow-lg shadow-violet-950/30 hover:shadow-violet-900/45 active:scale-[0.97] flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <FolderDown className="w-4 h-4" />
                        Скачать выбранную модель
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Card 2: Export Path Settings */}
              <div className="bg-zinc-900/15 border border-zinc-850/60 rounded-2xl p-5 space-y-4 shadow-md relative overflow-hidden backdrop-blur-md">
                <div className="absolute inset-0 bg-gradient-to-tr from-indigo-600/4 via-violet-600/1 to-transparent pointer-events-none" />
                
                <div className="flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-indigo-400" />
                  <label className="text-[11px] tracking-widest font-extrabold text-zinc-300 uppercase">Директория экспорта</label>
                </div>

                <div className="space-y-3">
                  <input
                    type="text"
                    value={exportFolder}
                    onChange={(e) => {
                      setExportFolder(e.target.value);
                      localStorage.setItem('exportFolder', e.target.value);
                    }}
                    placeholder="Download"
                    className="w-full bg-zinc-950/60 border border-zinc-850 hover:border-zinc-750 focus:border-violet-500/80 focus:ring-[3px] focus:ring-violet-500/10 rounded-xl px-4 py-2.5 text-xs text-zinc-200 placeholder-zinc-650 transition-all duration-300 outline-none"
                  />
                  <p className="text-[11px] text-zinc-400 leading-relaxed font-normal">
                    Все ассеты (картинки, SVG и ZIP-архивы) сохраняются в указанную подпапку Android-директории <code className="text-violet-450 font-mono text-[10px] bg-violet-950/20 px-1 py-0.5 rounded border border-violet-900/30">Documents</code>.
                  </p>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-zinc-950/40 border-t border-zinc-800/60 flex justify-end">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="py-2.5 px-6 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white border border-violet-500/20 font-bold text-xs rounded-xl shadow-lg shadow-violet-950/30 transition-all duration-200 active:scale-95 cursor-pointer"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
