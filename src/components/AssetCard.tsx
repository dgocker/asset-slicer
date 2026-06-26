import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Download, Copy, Check, Sparkles, Image as ImageIcon, Palette, Loader2 } from 'lucide-react';
import { Slice, SVGMode, ProcessedAsset, ColorRGB } from '../types';
import { generateSilhouetteSvg, generateColorLayersSvg, generateEmbeddedSvg, trimTransparentMargins, applySmartEdgeCleanup, cropImageData } from '../utils/imageProcess';
import { enqueueHeavyTask, yieldToMain } from '../utils/taskQueue';

interface AssetCardProps {
  slice: Slice;
  processedImageData: ImageData;
  originalImageData?: ImageData | null;
  keyColor?: ColorRGB | null;
  onAssetUpdated: (asset: ProcessedAsset) => void;
}

export default React.memo(function AssetCard({ slice, processedImageData, originalImageData, keyColor, onAssetUpdated }: AssetCardProps) {
  const [assetName, setAssetName] = useState(() => (slice.label || 'asset').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, ''));
  
  useEffect(() => {
    setAssetName((slice.label || 'asset').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, ''));
  }, [slice.label]);

  const [svgMode, setSvgMode] = useState<SVGMode>('embedded');
  const [trimMargins, setTrimMargins] = useState(true);
  const [keepBackground, setKeepBackground] = useState(false);
  const [smartEdge, setSmartEdge] = useState(false);
  const [erodeAmount, setErodeAmount] = useState(1);
  const [embedFormat, setEmbedFormat] = useState<'webp' | 'png'>('webp');
  const [embedQuality, setEmbedQuality] = useState(80);
  const [previewBackground, setPreviewBackground] = useState<'checkerboard' | 'black' | 'white'>('checkerboard');

  const [isProcessing, setIsProcessing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ width: 0, height: 0, sizeKb: 0, domColor: '#9ca3af' });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processedAssetRef = useRef<ProcessedAsset | null>(null);
  
  // Track inputs to know what changed
  const lastSourceDataRef = useRef<ImageData | null>(null);
  const lastSourcePixelsRef = useRef<ImageData | null>(null);
  const lastRectRef = useRef<{x: number, y: number, width: number, height: number} | null>(null);
  const lastSettingsRef = useRef<any>(null);

  const processAsset = useCallback(async () => {
    if (!processedImageData) return;
    const currentSource = (keepBackground && originalImageData) ? originalImageData : processedImageData;
    
    const settings = { trimMargins, smartEdge, erodeAmount, embedFormat, embedQuality, svgMode, assetName, keyColor };
    const settingsChanged = JSON.stringify(settings) !== JSON.stringify(lastSettingsRef.current);
    
    // Fast check: if source identity and rect and settings are identical, return immediately.
    let possibleSourceChange = true;
    if (lastSourceDataRef.current === currentSource && 
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

    // If we reach here, we actually need to process! Show loader immediately.
    setIsProcessing(true);
    await yieldToMain();

    // Enter heavy task queue to avoid blocking main thread with simultaneous crops/SVG tracing
    const result = await enqueueHeavyTask(async () => {
      // 1. Margins & crop
      let tightRect = slice.rect;
      if (trimMargins) {
        tightRect = trimTransparentMargins(currentSource, slice.rect);
      }
      if (tightRect.width <= 0 || tightRect.height <= 0) return { skipped: true, currentSlicePixels };

      const croppedData = cropImageData(currentSource, tightRect);

      if (smartEdge) {
        applySmartEdgeCleanup(croppedData, erodeAmount, keyColor);
      }

      // 2. Data URLs
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = tightRect.width;
      tempCanvas.height = tightRect.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) tempCtx.putImageData(croppedData, 0, 0);

      const pngDataUrl = tempCanvas.toDataURL('image/png');
      const rasterDataUrl = embedFormat === 'webp' ? tempCanvas.toDataURL('image/webp', embedQuality / 100) : pngDataUrl;

      // 3. Dominant Color
      let domColor = '#4b5563';
      for (let i = 0; i < croppedData.data.length; i += 40) {
        if (croppedData.data[i + 3] > 150) {
          const r = croppedData.data[i].toString(16).padStart(2, '0');
          const g = croppedData.data[i + 1].toString(16).padStart(2, '0');
          const b = croppedData.data[i + 2].toString(16).padStart(2, '0');
          domColor = `#${r}${g}${b}`;
          break;
        }
      }

      // 4. SVG Code
      let svgCode = '';
      if (svgMode === 'silhouette') {
        svgCode = generateSilhouetteSvg(croppedData, '#1e293b');
      } else if (svgMode === 'embedded') {
        svgCode = generateEmbeddedSvg(tightRect.width, tightRect.height, rasterDataUrl);
      } else {
        svgCode = generateColorLayersSvg(croppedData, 4);
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
        displayData: croppedData,
        rawSlicePixels: currentSlicePixels
      };
    });

    if (result) {
      if ('skipped' in result && result.skipped) {
        lastSourceDataRef.current = currentSource;
        lastRectRef.current = { ...slice.rect };
        lastSourcePixelsRef.current = result.currentSlicePixels;
        lastSettingsRef.current = settings;
        setIsProcessing(false);
        return;
      }

      lastSourceDataRef.current = currentSource;
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

      // Update the preview canvas directly
      if (canvasRef.current) {
        canvasRef.current.width = (result as any).displayData.width;
        canvasRef.current.height = (result as any).displayData.height;
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) ctx.putImageData((result as any).displayData, 0, 0);
      }

      onAssetUpdated((result as any).asset);
    }
    
    setIsProcessing(false);
  }, [slice, processedImageData, originalImageData, keyColor, trimMargins, keepBackground, smartEdge, erodeAmount, embedFormat, embedQuality, svgMode, assetName, onAssetUpdated]);

  useEffect(() => {
    const timer = setTimeout(() => {
      processAsset();
    }, 150);
    return () => clearTimeout(timer);
  }, [processAsset]);

  const handleCopyCode = () => {
    if (!processedAssetRef.current) return;
    navigator.clipboard.writeText(processedAssetRef.current.svgCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSVG = () => {
    if (!processedAssetRef.current) return;
    const blob = new Blob([processedAssetRef.current.svgCode], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${processedAssetRef.current.name}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadPNG = () => {
    if (!processedAssetRef.current) return;
    const a = document.createElement('a');
    a.href = processedAssetRef.current.rasterDataUrl || processedAssetRef.current.pngDataUrl;
    const ext = processedAssetRef.current.rasterFormat || 'png';
    a.download = `${processedAssetRef.current.name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

        <div className="w-20 h-20 md:w-24 md:h-24 flex items-center justify-center relative z-10 p-1">
          <div className="relative w-full h-full flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className={`max-w-full max-h-full object-contain transition-all duration-300 ${isProcessing ? 'opacity-50 scale-95' : 'opacity-100 scale-100'}`}
            />
            {isProcessing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-white/40 backdrop-blur-[1px] rounded-xl pointer-events-none">
                <Loader2 className="w-5.5 h-5.5 animate-spin text-neutral-600" />
                <span className="text-[9px] font-bold text-neutral-600 shadow-white drop-shadow-md">Обработка...</span>
              </div>
            )}
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
              onChange={e => setAssetName(e.target.value.toLowerCase().replace(/[^a-z0-9_\-]/g, ''))}
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

            <div className="flex flex-col gap-2 p-2.5 bg-neutral-50 border border-neutral-100/85 rounded-xl">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5 pr-2">
                  <span className="text-xs font-bold text-neutral-800 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    Умное удаление каймы
                  </span>
                  <p className="text-[10px] text-neutral-500 leading-normal">Устраняет остаточный белый ореол по краям.</p>
                </div>
                <button onClick={() => setSmartEdge(prev => !prev)} type="button" className={`w-10 h-6 flex items-center rounded-full p-1 transition-all shrink-0 ${smartEdge ? 'bg-amber-500 justify-end' : 'bg-neutral-200 justify-start'}`}>
                  <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
                </button>
              </div>
              {smartEdge && (
                <div className="mt-1 pt-2 border-t border-neutral-200/50 flex gap-2 animate-fadeIn">
                  {[0, 1, 2, 3].map((val) => (
                    <button key={val} onClick={() => setErodeAmount(val)} type="button" className={`flex-1 py-1 text-[9px] font-bold rounded-lg transition-all border ${erodeAmount === val ? 'bg-neutral-900 border-neutral-900 text-white' : 'bg-white border-neutral-200 text-neutral-600'}`}>
                      {val === 0 ? 'Без сужения' : `${val} px`}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
    </div>
  );
});
