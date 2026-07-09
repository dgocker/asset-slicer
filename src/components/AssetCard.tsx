import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Download, Copy, Check, Sparkles, Image as ImageIcon, Palette, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { Slice, SVGMode, ProcessedAsset, ColorRGB } from '../types';
import { generateSilhouetteSvg, generateColorLayersSvg, generateEmbeddedSvg, trimTransparentMargins, cropImageData, removeForeignFragments } from '../utils/imageProcess';
import { enqueueHeavyTask, yieldToMain, getNextTaskVersion } from '../utils/taskQueue';

interface AssetCardProps {
  slice: Slice;
  processedImageData: ImageData;
  originalImageData?: ImageData | null;
  keyColor?: ColorRGB | null;
  onAssetUpdated: (asset: ProcessedAsset) => void;
}

export default React.memo(function AssetCard({
  slice,
  processedImageData,
  originalImageData,
  keyColor,
  onAssetUpdated
}: AssetCardProps) {
  const [assetName, setAssetName] = useState(() => (slice.label || 'asset').trim());

  useEffect(() => {
    setAssetName((slice.label || 'asset').trim());
  }, [slice.label]);

  const [svgMode, setSvgMode] = useState<SVGMode>('embedded');
  const [trimMargins, setTrimMargins] = useState(true);
  const [keepBackground, setKeepBackground] = useState(false);
  // Удаление «чужих» фрагментов соседних объектов из рамки. Отключаемо:
  // если пользователь намеренно нарезал крупный объект по частям, его фрагмент
  // (<50% непрозрачных пикселей кропа) иначе молча стирался бы из экспорта.
  const [removeFragments, setRemoveFragments] = useState(true);
  const [embedFormat, setEmbedFormat] = useState<'webp' | 'png'>('webp');
  const [embedQuality, setEmbedQuality] = useState(80);
  const [previewBackground, setPreviewBackground] = useState<'checkerboard' | 'black' | 'white'>('checkerboard');

  const [isProcessing, setIsProcessing] = useState(false);

  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ width: 0, height: 0, sizeKb: 0, domColor: '#9ca3af' });
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processedAssetRef = useRef<ProcessedAsset | null>(null);

  // Track inputs to know what changed
  const lastSourceDataRef = useRef<ImageData | null>(null);
  const lastSourcePixelsRef = useRef<ImageData | null>(null);
  const lastRectRef = useRef<{x: number, y: number, width: number, height: number} | null>(null);
  const lastSettingsRef = useRef<any>(null);

  // FAST CANVAS UPDATE: instant visual feedback without blocking or waiting
  useEffect(() => {
    if (!processedImageData || !canvasRef.current) return;

    let displayData: ImageData;
    const currentSource = (keepBackground && originalImageData) ? originalImageData : processedImageData;

    let tightRect = slice.rect;
    if (trimMargins) {
      tightRect = trimTransparentMargins(currentSource, slice.rect);
    }

    if (tightRect.width > 0 && tightRect.height > 0) {
      displayData = cropImageData(currentSource, tightRect);
      if (!keepBackground && removeFragments) {
        displayData = removeForeignFragments(displayData, currentSource, tightRect);
      }
    } else {
      return;
    }

    canvasRef.current.width = displayData.width;
    canvasRef.current.height = displayData.height;
    const ctx = canvasRef.current.getContext('2d');
    if (ctx) ctx.putImageData(displayData, 0, 0);
  }, [slice, processedImageData, originalImageData, trimMargins, keepBackground, removeFragments]);

  const processAsset = useCallback(async () => {
    if (!processedImageData) return;

    const settings = { trimMargins, removeFragments, embedFormat, embedQuality, svgMode, assetName, keyColor };
    const settingsChanged = JSON.stringify(settings) !== JSON.stringify(lastSettingsRef.current);

    // Fast check: if source identity and rect and settings are identical, return immediately.
    let possibleSourceChange = true;
    if (lastSourceDataRef.current === processedImageData &&
        lastRectRef.current?.x === slice.rect.x &&
        lastRectRef.current?.y === slice.rect.y &&
        lastRectRef.current?.width === slice.rect.width &&
        lastRectRef.current?.height === slice.rect.height) {
      possibleSourceChange = false;
    }

    if (!possibleSourceChange && !settingsChanged && processedAssetRef.current) {
      return; // Nothing to do!
    }

    // Crop the current region to do a fast pixel comparison before queueing
    const currentSource = (keepBackground && originalImageData) ? originalImageData : processedImageData;
    const currentSlicePixels = cropImageData(currentSource, slice.rect);

    let pixelsChanged = true;
    if (lastSourcePixelsRef.current &&
        lastSourcePixelsRef.current.width === currentSlicePixels.width &&
        lastSourcePixelsRef.current.height === currentSlicePixels.height) {
      const oldData = lastSourcePixelsRef.current.data;
      const newData = currentSlicePixels.data;
      let isSame = true;
      for (let i = 0; i < oldData.length; i += 4) {
        if (oldData[i] !== newData[i] || oldData[i+1] !== newData[i+1] || oldData[i+2] !== newData[i+2] || oldData[i+3] !== newData[i+3]) {
          isSame = false;
          break;
        }
      }
      if (isSame) {
        pixelsChanged = false;
      }
    }

    if (!pixelsChanged && !settingsChanged && processedAssetRef.current) {
      return; // Nothing to do!
    }

    setIsProcessing(true);

    const version = getNextTaskVersion(slice.id);

    // Enter heavy task queue to avoid blocking main thread with simultaneous crops/SVG tracing
    // It will run AFTER the user stops moving the slider, because the queue/debounce will handle it
    const result = await enqueueHeavyTask(async () => {
      let displayData: ImageData;
      let tightRect = slice.rect;

      if (trimMargins) {
        tightRect = trimTransparentMargins(currentSource, slice.rect);
      }

      if (tightRect.width <= 0 || tightRect.height <= 0) return { skipped: true, currentSlicePixels };
      displayData = cropImageData(currentSource, tightRect);
      if (!keepBackground && removeFragments) {
        displayData = removeForeignFragments(displayData, currentSource, tightRect);
      }

      // 2. Data URLs
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = tightRect.width;
      tempCanvas.height = tightRect.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) tempCtx.putImageData(displayData, 0, 0);

      const pngDataUrl = tempCanvas.toDataURL('image/png');
      const rasterDataUrl = embedFormat === 'webp' ? tempCanvas.toDataURL('image/webp', embedQuality / 100) : pngDataUrl;

      // 3. Dominant Color
      let domColor = '#4b5563';
      for (let i = 0; i < displayData.data.length; i += 40) {
        if (displayData.data[i + 3] > 150) {
          const r = displayData.data[i].toString(16).padStart(2, '0');
          const g = displayData.data[i + 1].toString(16).padStart(2, '0');
          const b = displayData.data[i + 2].toString(16).padStart(2, '0');
          domColor = `#${r}${g}${b}`;
          break;
        }
      }

      // 4. SVG Code
      let svgCode = '';
      if (svgMode === 'silhouette') {
        svgCode = generateSilhouetteSvg(displayData, '#1e293b');
      } else if (svgMode === 'embedded') {
        svgCode = generateEmbeddedSvg(tightRect.width, tightRect.height, rasterDataUrl);
      } else {
        svgCode = generateColorLayersSvg(displayData, 4);
      }

      return {
        asset: {
          id: slice.id,
          name: assetName,
          rect: tightRect,
          pngDataUrl,
          rasterDataUrl,
          rasterFormat: embedFormat,
          width: tightRect.width,
          height: tightRect.height,
          svgMode,
          svgCode,
          dominantColor: domColor,
          tags: [`${tightRect.width}x${tightRect.height}px`]
        } as ProcessedAsset,
        displayData,
        rawSlicePixels: currentSlicePixels
      };
    }, slice.id, version);

    if (result) {
      if ('skipped' in result && result.skipped) {
        lastSourceDataRef.current = processedImageData;
        lastRectRef.current = { ...slice.rect };
        lastSourcePixelsRef.current = result.currentSlicePixels;
        lastSettingsRef.current = settings;
        setIsProcessing(false);
        return;
      }

      lastSourceDataRef.current = processedImageData;
      lastRectRef.current = { ...slice.rect };
      lastSourcePixelsRef.current = (result as any).rawSlicePixels;
      lastSettingsRef.current = settings;
      processedAssetRef.current = (result as any).asset;

      setStats({
        width: (result as any).asset.width,
        height: (result as any).asset.height,
        sizeKb: parseFloat(((result as any).asset.svgCode.length / 1024).toFixed(1)),
        domColor: (result as any).asset.dominantColor || '#9ca3af'
      });

      onAssetUpdated((result as any).asset);
    }

    setIsProcessing(false);
  }, [slice, processedImageData, originalImageData, keyColor, trimMargins, keepBackground, removeFragments, embedFormat, embedQuality, svgMode, assetName, onAssetUpdated]);

  useEffect(() => {
    // Debounce the entire process slightly more so it doesn't queue 100 tasks while dragging
    const timer = setTimeout(() => {
      processAsset();
    }, 250);
    return () => clearTimeout(timer);
  }, [processAsset]);

  useEffect(() => {
    return () => {
      // Invalidate any pending tasks for this slice on unmount
      getNextTaskVersion(slice.id);
    };
  }, [slice.id]);

  const handleCopyCode = () => {
    if (!processedAssetRef.current) return;
    navigator.clipboard.writeText(processedAssetRef.current.svgCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSVG = async () => {
    if (!processedAssetRef.current) return;
    try {
      const { downloadTextFile } = await import('../utils/downloadHelper');
      await downloadTextFile(`${processedAssetRef.current.name}.svg`, processedAssetRef.current.svgCode);
    } catch (err) {
      console.error('Failed to download SVG:', err);
      alert('Ошибка при скачивании SVG: ' + String(err));
    }
  };

  const handleDownloadPNG = async () => {
    if (!processedAssetRef.current) return;
    try {
      const ext = processedAssetRef.current.rasterFormat || 'png';
      const rasterUrl = processedAssetRef.current.rasterDataUrl || processedAssetRef.current.pngDataUrl;
      const { downloadBinaryFile } = await import('../utils/downloadHelper');
      await downloadBinaryFile(`${processedAssetRef.current.name}.${ext}`, rasterUrl);
    } catch (err) {
      console.error('Failed to download PNG:', err);
      alert('Ошибка при скачивании изображения: ' + String(err));
    }
  };

  return (
    <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row gap-5 items-stretch relative">
      <div
        className={`flex flex-col sm:flex-row md:flex-col gap-3 justify-center items-center rounded-xl p-4 border relative overflow-hidden group transition-all duration-300 min-w-[140px] md:w-[160px] ${
          previewBackground === 'checkerboard' ? 'bg-neutral-50 border-neutral-100' :
          previewBackground === 'black' ? 'bg-black border-neutral-900 shadow-inner' : 'bg-white border-neutral-200 shadow-inner'
        }`}
      >
        <div className="absolute top-1.5 right-1.5 flex gap-1 z-20 bg-white/95 backdrop-blur-sm p-1 rounded-lg border border-neutral-200/50 shadow-sm opacity-60 hover:opacity-100 transition-all">
          <button onClick={() => setPreviewBackground('checkerboard')} className={`w-3.5 h-3.5 rounded transition-all flex items-center justify-center border text-[8px] leading-none ${previewBackground === 'checkerboard' ? 'border-neutral-900 bg-neutral-100 scale-110 font-bold' : 'border-transparent hover:bg-neutral-100/50'}`}>🏁</button>
          <button onClick={() => setPreviewBackground('black')} className={`w-3.5 h-3.5 rounded transition-all bg-black border ${previewBackground === 'black' ? 'border-blue-500 scale-110' : 'border-neutral-300'}`} />
          <button onClick={() => setPreviewBackground('white')} className={`w-3.5 h-3.5 rounded transition-all bg-white border ${previewBackground === 'white' ? 'border-blue-500 scale-110' : 'border-neutral-300'}`} />
        </div>

        {previewBackground === 'checkerboard' && (
          <div
            className="absolute inset-0 opacity-5 pointer-events-none"
            style={{
              backgroundImage: `linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)`,
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px'
            }}
          />
        )}

        <div
          onClick={() => setIsZoomOpen(true)}
          className="w-20 h-20 md:w-24 md:h-24 flex items-center justify-center relative z-10 p-1 cursor-zoom-in hover:scale-105 transition-transform duration-200"
          title="Нажмите, чтобы увеличить и рассмотреть"
        >
          <div className="relative w-full h-full flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        </div>

        <div className="flex flex-col items-center gap-1 z-10 text-center">
          <span className="text-[10px] font-mono font-semibold text-neutral-400 flex items-center gap-1">
            <Palette className="w-3 h-3" style={{ color: stats.domColor }} />
            {stats.domColor.toUpperCase()}
          </span>
          <span className={`text-[9px] font-mono font-semibold rounded px-1.5 py-0.5 ${previewBackground === 'black' ? 'bg-neutral-800 text-neutral-300' : 'bg-neutral-200/60 text-neutral-600'}`}>
            {stats.width} × {stats.height} px
          </span>
          <span className="text-[9px] bg-emerald-50 border border-emerald-100 font-mono font-bold text-emerald-700 rounded px-1.5 py-0.5">
            {stats.sizeKb} КБ SVG
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-between gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1 block">Имя ассета / Имя файла SVG</label>
            <input
              type="text"
              value={assetName}
              onChange={e => setAssetName(e.target.value)}
              placeholder="название_ассета"
              className="w-full text-sm font-semibold text-neutral-800 bg-neutral-50 hover:bg-neutral-100/50 focus:bg-white border border-neutral-100 focus:border-neutral-300 rounded-xl px-3.5 py-2 transition-all outline-none"
            />
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex flex-col gap-0.5 pr-2">
                <span className="text-xs font-bold text-neutral-800">Обрезать пустые поля</span>
                <p className="text-[10px] text-neutral-500 leading-normal">Автоматически ужимает рамку по границам видимого объекта.</p>
              </div>
              <button onClick={() => setTrimMargins(prev => !prev)} type="button" className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${trimMargins ? 'bg-neutral-900 justify-end' : 'bg-neutral-200 justify-start'}`}>
                <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
              </button>
            </div>

            <div className="flex items-center justify-between p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex flex-col gap-0.5 pr-2">
                <span className="text-xs font-bold text-neutral-800">Сохранить фон</span>
                <p className="text-[10px] text-neutral-500 leading-normal">Не вырезать фон и сохранить оригинальные цвета.</p>
              </div>
              <button onClick={() => setKeepBackground(prev => !prev)} type="button" className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${keepBackground ? 'bg-neutral-900 justify-end' : 'bg-neutral-200 justify-start'}`}>
                <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
              </button>
            </div>

            {!keepBackground && (
              <div className="flex items-center justify-between p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
                <div className="flex flex-col gap-0.5 pr-2">
                  <span className="text-xs font-bold text-neutral-800">Стирать чужие фрагменты</span>
                  <p className="text-[10px] text-neutral-500 leading-normal">Удаляет куски соседних объектов, попавшие в рамку. Отключите, если объект намеренно нарезан по частям.</p>
                </div>
                <button onClick={() => setRemoveFragments(prev => !prev)} type="button" className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${removeFragments ? 'bg-neutral-900 justify-end' : 'bg-neutral-200 justify-start'}`}>
                  <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1.5 block">Режим SVG</label>
            <div className="grid grid-cols-3 gap-1.5 bg-neutral-50 border border-neutral-100 rounded-xl p-1">
              <button onClick={() => setSvgMode('color')} className={`py-2 px-1 rounded-lg text-xs font-semibold transition-all ${svgMode === 'color' ? 'bg-neutral-900 text-white shadow-sm' : 'text-neutral-500 hover:bg-neutral-100/40'}`}>Цвет</button>
              <button onClick={() => setSvgMode('silhouette')} className={`py-2 px-1 rounded-lg text-xs font-semibold transition-all ${svgMode === 'silhouette' ? 'bg-neutral-900 text-white shadow-sm' : 'text-neutral-500 hover:bg-neutral-100/40'}`}>Силуэт</button>
              <button onClick={() => setSvgMode('embedded')} className={`py-2 px-1 rounded-lg text-xs font-semibold transition-all ${svgMode === 'embedded' ? 'bg-neutral-900 text-white shadow-sm' : 'text-neutral-500 hover:bg-neutral-100/40'}`}>PNG в SVG</button>
            </div>
            {svgMode === 'embedded' && (
              <div className="mt-3 p-3 bg-neutral-50 border border-neutral-100/80 rounded-xl flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase text-neutral-500">Формат упаковки:</span>
                  <div className="flex gap-1 bg-white border border-neutral-200 rounded-lg p-0.5 shrink-0">
                    <button onClick={() => setEmbedFormat('webp')} className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${embedFormat === 'webp' ? 'bg-neutral-900 text-white' : 'text-neutral-500'}`}>WebP</button>
                    <button onClick={() => setEmbedFormat('png')} className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${embedFormat === 'png' ? 'bg-neutral-900 text-white' : 'text-neutral-500'}`}>PNG</button>
                  </div>
                </div>
                {embedFormat === 'webp' && (
                  <div className="flex flex-col gap-1.5">
                    <input type="range" min="10" max="100" value={embedQuality} onChange={e => setEmbedQuality(parseInt(e.target.value))} className="w-full h-1 bg-neutral-200 rounded-lg appearance-none cursor-pointer accent-neutral-900" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-3 border-t border-neutral-100">
          <button onClick={handleCopyCode} disabled={isProcessing} className={`flex items-center gap-1.5 py-2.5 px-3.5 rounded-xl text-xs font-semibold transition-all shadow-sm ${isProcessing ? 'bg-neutral-50 border border-neutral-100 text-neutral-400' : copied ? 'bg-emerald-500 text-white' : 'bg-neutral-50 border border-neutral-200 text-neutral-700'}`}>
            {copied ? <><Check className="w-3.5 h-3.5" /> Код скопирован!</> : <><Copy className="w-3.5 h-3.5" /> Копировать SVG</>}
          </button>
          <button onClick={handleDownloadSVG} disabled={isProcessing} className={`flex items-center gap-1.5 py-2.5 px-3.5 text-white rounded-xl text-xs font-semibold transition-all shadow-md active:scale-95 ${isProcessing ? 'bg-neutral-300 cursor-not-allowed' : 'bg-neutral-900 hover:bg-neutral-800'}`}>
            <Download className="w-3.5 h-3.5" /> Скачать SVG
          </button>
          <button onClick={handleDownloadPNG} disabled={isProcessing} className={`flex items-center gap-1.5 py-2.5 px-3.5 border border-neutral-200 text-neutral-600 rounded-xl text-xs font-semibold transition-all shadow-sm ${isProcessing ? 'bg-neutral-50 border border-neutral-100 text-neutral-400' : 'bg-white hover:bg-neutral-50'}`}>
            <ImageIcon className="w-3.5 h-3.5" /> Скачать {(embedFormat || 'png').toUpperCase()}
          </button>
        </div>
      </div>

      {/* High-resolution fullscreen preview Zoom Modal */}
      {isZoomOpen && (
        <div className="fixed inset-0 bg-neutral-950/85 backdrop-blur-md flex flex-col items-center justify-center z-50 p-4 animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-3xl p-5 sm:p-6 shadow-2xl max-w-2xl w-full flex flex-col items-stretch gap-4 relative max-h-[90vh] animate-in zoom-in-95 duration-250">
            
            {/* Header */}
            <div className="flex justify-between items-center pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-bold text-neutral-100 uppercase tracking-wide">Детальный осмотр: {assetName}</span>
              </div>
              <button 
                onClick={() => setIsZoomOpen(false)}
                className="w-8 h-8 rounded-full bg-neutral-800 hover:bg-neutral-750 flex items-center justify-center text-neutral-400 hover:text-neutral-200 border border-neutral-700 transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Background selection for the preview inside modal */}
            <div className="flex justify-end gap-1.5 bg-neutral-950/50 p-1.5 rounded-xl border border-neutral-800/80 self-end">
              <button 
                onClick={() => setPreviewBackground('checkerboard')} 
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  previewBackground === 'checkerboard' ? 'bg-neutral-800 text-white border border-neutral-700' : 'text-neutral-400 hover:text-neutral-250 border border-transparent'
                }`}
              >
                🏁 Шахматка
              </button>
              <button 
                onClick={() => setPreviewBackground('black')} 
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  previewBackground === 'black' ? 'bg-black text-white border border-neutral-900' : 'text-neutral-400 hover:text-neutral-250 border border-transparent'
                }`}
              >
                ⚫ Чёрный
              </button>
              <button 
                onClick={() => setPreviewBackground('white')} 
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  previewBackground === 'white' ? 'bg-white text-black border border-neutral-200' : 'text-neutral-450 hover:text-neutral-600 border border-transparent'
                }`}
              >
                ⚪ Белый
              </button>
            </div>

            {/* Large Image Viewport */}
            <div 
              className={`flex-1 min-h-[250px] sm:min-h-[350px] rounded-2xl border flex items-center justify-center relative overflow-hidden p-6 transition-all duration-300 ${
                previewBackground === 'checkerboard' ? 'bg-neutral-950 border-neutral-850' :
                previewBackground === 'black' ? 'bg-black border-neutral-950' : 'bg-white border-neutral-200'
              }`}
            >
              {previewBackground === 'checkerboard' && (
                <div
                  className="absolute inset-0 opacity-10 pointer-events-none"
                  style={{
                    backgroundImage: `linear-gradient(45deg, #475569 25%, transparent 25%), linear-gradient(-45deg, #475569 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #475569 75%), linear-gradient(-45deg, transparent 75%, #475569 75%)`,
                    backgroundSize: '24px 24px',
                    backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px'
                  }}
                />
              )}

              {processedAssetRef.current ? (
                <img 
                  src={processedAssetRef.current.pngDataUrl || processedAssetRef.current.rasterDataUrl} 
                  alt={assetName} 
                  className="max-w-full max-h-[45vh] object-contain relative z-10 shadow-lg select-none"
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 text-neutral-400">
                  <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
                  <span className="text-xs font-semibold">Генерация предпросмотра...</span>
                </div>
              )}
            </div>

            {/* Bottom Meta */}
            <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 px-1 pt-1.5 border-t border-neutral-800/60">
              <span>Разрешение: {stats.width} × {stats.height} px</span>
              <span>Размер SVG: {stats.sizeKb} КБ</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
