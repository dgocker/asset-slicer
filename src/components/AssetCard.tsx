/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import { Download, Copy, Check, Sparkles, Image as ImageIcon, Code, Palette, Tag } from 'lucide-react';
import { Slice, SVGMode, ProcessedAsset, ColorRGB } from '../types';
import { generateSilhouetteSvg, generateColorLayersSvg, generateEmbeddedSvg, trimTransparentMargins, applySmartEdgeCleanup, cropImageData } from '../utils/imageProcess';

import { enqueueHeavyTask } from '../utils/taskQueue';

interface AssetCardProps {
  key?: string;
  slice: Slice;
  processedImageData: ImageData;
  originalImageData?: ImageData | null;
  keyColor?: ColorRGB | null;
  onAssetUpdated: (asset: ProcessedAsset) => void;
}

const AssetCard = React.memo(function AssetCard({ slice, processedImageData, originalImageData, keyColor, onAssetUpdated }: AssetCardProps) {
  const [assetName, setAssetName] = useState<string>('');
  const [svgMode, setSvgMode] = useState<SVGMode>('embedded');
  const [copied, setCopied] = useState(false);
  const [processed, setProcessed] = useState<ProcessedAsset | null>(null);
  const [embedFormat, setEmbedFormat] = useState<'webp' | 'png'>('webp');
  const [embedQuality, setEmbedQuality] = useState<number>(80);
  const [trimMargins, setTrimMargins] = useState<boolean>(true);
  const [keepBackground, setKeepBackground] = useState<boolean>(false);
  const [smartEdge, setSmartEdge] = useState<boolean>(false);
  const [erodeAmount, setErodeAmount] = useState<number>(1);
  const [previewBackground, setPreviewBackground] = useState<'checkerboard' | 'black' | 'white'>('checkerboard');

  interface CroppedState {
    croppedImgData: ImageData;
    tightRect: { x: number; y: number; width: number; height: number };
    version: number;
  }

  const [croppedState, setCroppedState] = useState<CroppedState | null>(null);
  const lastCroppedDataRef = useRef<ImageData | null>(null);

  // Deep pixel-by-pixel comparison helper for TypedArray performance optimization
  const areImageDataEqual = (a: ImageData, b: ImageData): boolean => {
    if (a.width !== b.width || a.height !== b.height) return false;
    const dataA = a.data;
    const dataB = b.data;
    const len = dataA.length;
    for (let i = 0; i < len; i++) {
      if (dataA[i] !== dataB[i]) return false;
    }
    return true;
  };

  // STAGE 1: Extract and Clean Sub-region Pixels (Only runs when source image, slice area, or cleanup parameters change)
  useEffect(() => {
    if (!processedImageData) return;

    let isSubscribed = true;

    const timer = setTimeout(() => {
      enqueueHeavyTask(async () => {
        if (!isSubscribed) return;

        // 1. Trim margins tightly around the slice for a clean close-cropped asset bounding box
        const tightRect = trimMargins 
          ? trimTransparentMargins(processedImageData, slice.rect)
          : slice.rect;
        
        // Safety check for empty regions
        if (tightRect.width <= 0 || tightRect.height <= 0) return;
        
        // 2. Extract cropped PNG from processed/original ImageData
        const sourceData = (keepBackground && originalImageData) ? originalImageData : processedImageData;
        const croppedImgData = cropImageData(sourceData, tightRect);

        // Apply Smart Edge Cleanup (in-place modification on the fresh croppedImgData copy)
        if (smartEdge) {
          applySmartEdgeCleanup(croppedImgData, erodeAmount, keyColor);
        }

        // Optimization: Fast comparison with the last cropped data
        if (lastCroppedDataRef.current && areImageDataEqual(lastCroppedDataRef.current, croppedImgData)) {
          // Pixel data is identical! Bypass any state updates, downstream SVG rendering, or parent notifications.
          return;
        }

        if (!isSubscribed) return;

        // Cache the newly processed pixels
        lastCroppedDataRef.current = croppedImgData;

        setCroppedState({
          croppedImgData,
          tightRect,
          version: Date.now()
        });
      });
    }, 250);

    return () => {
      isSubscribed = false;
      clearTimeout(timer);
    };
  }, [
    slice.rect.x,
    slice.rect.y,
    slice.rect.width,
    slice.rect.height,
    processedImageData,
    originalImageData,
    keyColor,
    trimMargins,
    keepBackground,
    smartEdge,
    erodeAmount
  ]);

  // STAGE 2: Render & Vectorize SVG/Base64 Outputs (Runs on stage 1 output OR when export configurations change)
  useEffect(() => {
    if (!croppedState) return;

    let isSubscribed = true;

    enqueueHeavyTask(async () => {
      if (!isSubscribed) return;

      const { croppedImgData, tightRect } = croppedState;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = tightRect.width;
      tempCanvas.height = tightRect.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;
      
      tempCtx.putImageData(croppedImgData, 0, 0);

      const pngDataUrl = tempCanvas.toDataURL('image/png');

      // Generate compressed base64 string
      const embedDataUrl = embedFormat === 'webp'
        ? tempCanvas.toDataURL('image/webp', embedQuality / 100)
        : pngDataUrl;

      // Generate the active SVG vectorization format (lazy calculation to prevent thread blocking)
      let currentSvgCode = '';
      let silhouetteSvg = '';
      let colorSvg = '';
      let embeddedSvg = '';

      if (svgMode === 'silhouette') {
        silhouetteSvg = generateSilhouetteSvg(croppedImgData, '#1e293b');
        currentSvgCode = silhouetteSvg;
      } else if (svgMode === 'color') {
        colorSvg = generateColorLayersSvg(croppedImgData, 4);
        currentSvgCode = colorSvg;
      } else {
        embeddedSvg = generateEmbeddedSvg(tightRect.width, tightRect.height, embedDataUrl);
        currentSvgCode = embeddedSvg;
      }

      // Set default name if empty or generic
      const currentName = assetName || slice.label.toLowerCase().replace(/\s+/g, '_');
      if (!assetName && isSubscribed) {
        setAssetName(currentName);
      }

      // Determine dominant color representation
      let domColor = '#4b5563';
      // Sample a prominent pixel color for visual flair
      const pixelData = croppedImgData.data;
      for (let i = 0; i < pixelData.length; i += 4 * 10) {
        if (pixelData[i + 3] > 150) {
           const r = pixelData[i].toString(16).padStart(2, '0');
           const g = pixelData[i + 1].toString(16).padStart(2, '0');
           const b = pixelData[i + 2].toString(16).padStart(2, '0');
           domColor = `#${r}${g}${b}`;
           break;
        }
      }

      if (!isSubscribed) return;

      const newAsset: ProcessedAsset = {
        id: slice.id,
        name: currentName,
        rect: tightRect,
        pngDataUrl,
        rasterDataUrl: embedDataUrl,
        rasterFormat: embedFormat,
        width: tightRect.width,
        height: tightRect.height,
        svgMode,
        svgCode: currentSvgCode,
        silhouetteSvg: silhouetteSvg || currentSvgCode,
        colorSvg: colorSvg || currentSvgCode,
        embeddedSvg: embeddedSvg || currentSvgCode,
        dominantColor: domColor,
        tags: [
          `${tightRect.width}x${tightRect.height}px`,
          svgMode === 'silhouette' ? 'Силуэт' : svgMode === 'color' ? 'Вектор (цвет)' : `SVG (${embedFormat.toUpperCase()})`
        ]
      };

      setProcessed(newAsset);
      onAssetUpdated(newAsset);
    });

    return () => {
      isSubscribed = false;
    };
  }, [
    croppedState,
    svgMode,
    assetName,
    embedFormat,
    embedQuality,
    slice.id,
    slice.label,
    onAssetUpdated
  ]);

  const handleCopyCode = () => {
    if (!processed) return;
    navigator.clipboard.writeText(processed.svgCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSVG = () => {
    if (!processed) return;
    const blob = new Blob([processed.svgCode], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${processed.name}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadPNG = () => {
    if (!processed) return;
    const a = document.createElement('a');
    a.href = processed.rasterDataUrl || processed.pngDataUrl;
    const ext = processed.rasterFormat || 'png';
    a.download = `${processed.name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!processed) {
    return (
      <div className="w-full h-44 bg-neutral-50 rounded-2xl border border-neutral-100 flex items-center justify-center text-neutral-400 text-xs">
        Обработка ассета...
      </div>
    );
  }

  return (
    <div id={`asset-card-${slice.id}`} className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row gap-5 items-stretch">
      
      {/* Visual Asset Previews (PNG & SVG Side-by-Side or Stacked) */}
      <div 
        className={`flex flex-col sm:flex-row md:flex-col gap-3 justify-center items-center rounded-xl p-4 border relative overflow-hidden group transition-all duration-300 min-w-[140px] md:w-[160px] ${
          previewBackground === 'checkerboard' ? 'bg-neutral-50 border-neutral-100' :
          previewBackground === 'black' ? 'bg-black border-neutral-900 shadow-inner' : 'bg-white border-neutral-200 shadow-inner'
        }`}
      >
        
        {/* Background Preview Selectors floating on top of preview box */}
        <div className="absolute top-1.5 right-1.5 flex gap-1 z-20 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm p-1 rounded-lg border border-neutral-200/50 shadow-sm opacity-60 hover:opacity-100 transition-all">
          <button
            title="Прозрачная сетка"
            onClick={() => setPreviewBackground('checkerboard')}
            className={`w-3.5 h-3.5 rounded transition-all flex items-center justify-center border text-[8px] leading-none ${
              previewBackground === 'checkerboard' ? 'border-neutral-900 bg-neutral-100 scale-110 font-bold' : 'border-transparent hover:bg-neutral-100/50'
            }`}
          >
            🏁
          </button>
          <button
            title="Черный фон"
            onClick={() => setPreviewBackground('black')}
            className={`w-3.5 h-3.5 rounded transition-all bg-black border ${
              previewBackground === 'black' ? 'border-blue-500 scale-110' : 'border-neutral-300'
            }`}
          />
          <button
            title="Белый фон"
            onClick={() => setPreviewBackground('white')}
            className={`w-3.5 h-3.5 rounded transition-all bg-white border ${
              previewBackground === 'white' ? 'border-blue-500 scale-110' : 'border-neutral-300'
            }`}
          />
        </div>

        {/* Transparent grid backdrop (Optimized CSS Checkerboard) */}
        {previewBackground === 'checkerboard' && (
          <div 
            className="absolute inset-0 opacity-5 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(45deg, #1e293b 25%, transparent 25%), 
                linear-gradient(-45deg, #1e293b 25%, transparent 25%), 
                linear-gradient(45deg, transparent 75%, #1e293b 75%), 
                linear-gradient(-45deg, transparent 75%, #1e293b 75%)
              `,
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px'
            }}
          />
        )}

        {/* Live SVG Rendering inside responsive container */}
        <div className="w-20 h-20 md:w-24 md:h-24 flex items-center justify-center relative z-10 p-1">
          <div 
            className="w-full h-full object-contain flex items-center justify-center transition-all duration-300"
            dangerouslySetInnerHTML={{ __html: processed.svgCode }}
          />
        </div>

        {/* Dominant Color Info Pill */}
        <div className="flex flex-col items-center gap-1 z-10 text-center">
          <span className="text-[10px] font-mono font-semibold text-neutral-400 flex items-center gap-1">
            <Palette className="w-3 h-3" style={{ color: processed.dominantColor }} />
            {processed.dominantColor.toUpperCase()}
          </span>
          <span className={`text-[9px] font-mono font-semibold rounded px-1.5 py-0.5 ${
            previewBackground === 'black' ? 'bg-neutral-800 text-neutral-300' : 'bg-neutral-200/60 text-neutral-600'
          }`}>
            {processed.width} × {processed.height} px
          </span>
          <span className="text-[9px] bg-emerald-50 border border-emerald-100 font-mono font-bold text-emerald-700 rounded px-1.5 py-0.5">
            {(processed.svgCode.length / 1024).toFixed(1)} КБ SVG
          </span>
        </div>
      </div>

      {/* Control Configuration Forms & Conversion Settings */}
      <div className="flex-1 flex flex-col justify-between gap-4">
        
        {/* Name input & Mode selection */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
            {/* Input name for file output */}
            <div className="flex-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1 block">
                Имя ассета / Имя файла SVG
              </label>
              <input
                id={`input-name-${slice.id}`}
                type="text"
                value={assetName}
                onChange={e => setAssetName(e.target.value.toLowerCase().replace(/[^a-z0-9_\-]/g, ''))}
                placeholder="название_ассета"
                className="w-full text-sm font-semibold text-neutral-800 bg-neutral-50 hover:bg-neutral-100/50 focus:bg-white border border-neutral-100 focus:border-neutral-300 rounded-xl px-3.5 py-2 transition-all outline-none"
              />
            </div>
          </div>

          {/* Toggle for Auto-Trimming Margins */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex flex-col gap-0.5 pr-2">
                <span className="text-xs font-bold text-neutral-800">Обрезать пустые поля ассета</span>
                <p className="text-[10px] text-neutral-500 leading-normal">
                  Автоматически ужимает рамку по границам видимого объекта. Выключите, чтобы сохранить оригинальный размер и пропорции выделенной вами рамки (например, для фиксированного шага иконок).
                </p>
              </div>
              <button
                id={`btn-toggle-trim-${slice.id}`}
                onClick={() => setTrimMargins(prev => !prev)}
                type="button"
                className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${
                  trimMargins ? 'bg-neutral-900 justify-end' : 'bg-neutral-200 justify-start'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
              </button>
            </div>

            {/* Toggle for Keeping Original Background */}
            <div className="flex items-center justify-between p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex flex-col gap-0.5 pr-2">
                <span className="text-xs font-bold text-neutral-800">Сохранить оригинальный фон</span>
                <p className="text-[10px] text-neutral-500 leading-normal">
                  Не вырезать фон и сохранить оригинальные цвета изображения вокруг объекта. Идеально для фоновых картинок, баннеров и плиток интерфейса.
                </p>
              </div>
              <button
                id={`btn-toggle-keep-bg-${slice.id}`}
                onClick={() => setKeepBackground(prev => !prev)}
                type="button"
                className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${
                  keepBackground ? 'bg-neutral-900 justify-end' : 'bg-neutral-200 justify-start'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
              </button>
            </div>

            {/* Toggle for Smart AI Edge Repair / Anti-Fringe */}
            <div className="flex flex-col gap-2 p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5 pr-2">
                  <span className="text-xs font-bold text-neutral-800 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    Умное удаление каймы (De-Fringe)
                  </span>
                  <p className="text-[10px] text-neutral-500 leading-normal">
                    Устраняет остаточный белый ореол по краям вырезанного объекта за счет перетекания цветов (color decontamination) и сужения маски.
                  </p>
                </div>
                <button
                  id={`btn-toggle-smart-edge-${slice.id}`}
                  onClick={() => setSmartEdge(prev => !prev)}
                  type="button"
                  className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${
                    smartEdge ? 'bg-amber-500 justify-end' : 'bg-neutral-200 justify-start'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
                </button>
              </div>

              {smartEdge && (
                <div className="mt-1 pt-2 border-t border-neutral-200/50 flex flex-col gap-1.5 animate-fadeIn">
                  <div className="flex items-center justify-between text-[10px] text-neutral-500">
                    <span>Ширина среза краев:</span>
                    <span className="font-mono font-bold bg-neutral-200/50 text-neutral-700 px-1.5 py-0.5 rounded">
                      {erodeAmount} px
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {[0, 1, 2, 3].map((val) => (
                      <button
                        key={val}
                        id={`btn-erode-amount-${val}-${slice.id}`}
                        onClick={() => setErodeAmount(val)}
                        type="button"
                        className={`flex-1 py-1 text-[9px] font-bold rounded-lg transition-all border ${
                          erodeAmount === val
                            ? 'bg-neutral-900 border-neutral-900 text-white'
                            : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-100/50'
                        }`}
                      >
                        {val === 0 ? 'Без сужения' : `${val} px`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SVG Vectorization Format Selector */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1.5 block">
              Режим конвертации в SVG
            </label>
            <div className="grid grid-cols-3 gap-1.5 bg-neutral-50 border border-neutral-100 rounded-xl p-1">
              <button
                id={`btn-svg-mode-color-${slice.id}`}
                onClick={() => setSvgMode('color')}
                className={`py-2 px-1 text-center rounded-lg text-xs font-semibold transition-all ${
                  svgMode === 'color'
                    ? 'bg-neutral-900 text-white shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/40'
                }`}
              >
                Вектор (Цвет)
              </button>
              <button
                id={`btn-svg-mode-silhouette-${slice.id}`}
                onClick={() => setSvgMode('silhouette')}
                className={`py-2 px-1 text-center rounded-lg text-xs font-semibold transition-all ${
                  svgMode === 'silhouette'
                    ? 'bg-neutral-900 text-white shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/40'
                }`}
              >
                Вектор (Силуэт)
              </button>
              <button
                id={`btn-svg-mode-embedded-${slice.id}`}
                onClick={() => setSvgMode('embedded')}
                className={`py-2 px-1 text-center rounded-lg text-xs font-semibold transition-all ${
                  svgMode === 'embedded'
                    ? 'bg-neutral-900 text-white shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/40'
                }`}
              >
                PNG в SVG
              </button>
            </div>
            {/* SVG mode description helper text */}
            <p className="text-[10px] text-neutral-400 mt-1.5 leading-relaxed">
              {svgMode === 'color' && 'Преобразует изображение в векторные цветные фигуры. Идеально для цветных логотипов.'}
              {svgMode === 'silhouette' && 'Создает монохромный силуэтный вектор. Лучший выбор для иконок.'}
              {svgMode === 'embedded' && 'Упаковывает изображение в масштабируемый SVG-контейнер с возможностью сжатия.'}
            </p>

            {/* Embedded Quality & Format Controls */}
            {svgMode === 'embedded' && (
              <div className="mt-3 p-3 bg-neutral-50 border border-neutral-100/80 rounded-xl flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                    Формат упаковки:
                  </span>
                  <div className="flex gap-1 bg-white border border-neutral-200 rounded-lg p-0.5 shrink-0">
                    <button
                      id={`btn-embed-webp-${slice.id}`}
                      onClick={() => setEmbedFormat('webp')}
                      className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${
                        embedFormat === 'webp'
                          ? 'bg-neutral-900 text-white shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      WebP (Сжатый)
                    </button>
                    <button
                      id={`btn-embed-png-${slice.id}`}
                      onClick={() => setEmbedFormat('png')}
                      className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${
                        embedFormat === 'png'
                          ? 'bg-neutral-900 text-white shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      PNG (Максимум)
                    </button>
                  </div>
                </div>

                {embedFormat === 'webp' && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[10px] font-semibold text-neutral-600">
                      <span>Качество сжатия WebP</span>
                      <span className="font-mono bg-neutral-200 text-neutral-800 rounded px-1">{embedQuality}%</span>
                    </div>
                    <input
                      id={`input-embed-quality-${slice.id}`}
                      type="range"
                      min="10"
                      max="100"
                      value={embedQuality}
                      onChange={e => setEmbedQuality(parseInt(e.target.value))}
                      className="w-full h-1 bg-neutral-200 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                    />
                  </div>
                )}
                <p className="text-[9px] text-neutral-400 leading-normal">
                  {embedFormat === 'webp' 
                    ? 'Сжатие WebP уменьшает размер SVG файла в 3–5 раз без видимой потери качества. Полностью поддерживается всеми современными браузерами.' 
                    : 'Формат PNG сохраняет исходный пиксельный вид без какого-либо сжатия, из-за чего SVG файл весит значительно больше.'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Action button downloads & Copying code */}
        <div className="flex flex-wrap gap-2 pt-3 border-t border-neutral-100">
          {/* Copy SVG Code */}
          <button
            id={`btn-copy-svg-${slice.id}`}
            onClick={handleCopyCode}
            className={`flex items-center gap-1.5 py-2.5 px-3.5 rounded-xl text-xs font-semibold transition-all shadow-sm ${
              copied
                ? 'bg-emerald-500 text-white'
                : 'bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 text-neutral-700 hover:text-neutral-900'
            }`}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                Код скопирован!
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Копировать SVG код
              </>
            )}
          </button>

          {/* Download SVG */}
          <button
            id={`btn-download-svg-${slice.id}`}
            onClick={handleDownloadSVG}
            className="flex items-center gap-1.5 py-2.5 px-3.5 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl text-xs font-semibold transition-all shadow-md active:scale-95"
          >
            <Download className="w-3.5 h-3.5" />
            Скачать SVG
          </button>

          {/* Download PNG/WebP */}
          <button
            id={`btn-download-png-${slice.id}`}
            onClick={handleDownloadPNG}
            className="flex items-center gap-1.5 py-2.5 px-3.5 bg-white hover:bg-neutral-50 border border-neutral-200 hover:border-neutral-300 text-neutral-600 rounded-xl text-xs font-semibold transition-all shadow-sm"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Скачать {(processed.rasterFormat || 'png').toUpperCase()}
          </button>
        </div>

      </div>
    </div>
  );
});

export default AssetCard;
