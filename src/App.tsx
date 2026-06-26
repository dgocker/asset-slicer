/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Layers, 
  Scissors, 
  Sparkles, 
  ChevronRight, 
  Info, 
  Smartphone,
  FolderDown,
  FileImage,
  Loader2
} from 'lucide-react';
import JSZip from 'jszip';
import { Slice, ProcessedAsset, ColorRGB } from './types';
import ImageUploader from './components/ImageUploader';
import Workspace from './components/Workspace';
import AssetCard from './components/AssetCard';

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [slices, setSlices] = useState<Slice[]>([]);
  const [processedImageData, setProcessedImageData] = useState<ImageData | null>(null);
  const [originalImageData, setOriginalImageData] = useState<ImageData | null>(null);
  const [keyColor, setKeyColor] = useState<ColorRGB | null>(null);
  const [assets, setAssets] = useState<{ [id: string]: ProcessedAsset }>({});
  const [isZipping, setIsZipping] = useState(false);

  const handleImageSelected = useCallback((dataUrl: string) => {
    setImageSrc(dataUrl);
    setAssets({});
  }, []);

  const handleSlicesUpdated = useCallback((newSlices: Slice[], imgData: ImageData, origData?: ImageData, kColor?: ColorRGB) => {
    setSlices(newSlices);
    setProcessedImageData(imgData);
    if (origData) {
      setOriginalImageData(origData);
    }
    if (kColor) {
      setKeyColor(kColor);
    } else {
      setKeyColor(null);
    }
  }, []);

  const handleAssetUpdated = useCallback((asset: ProcessedAsset) => {
    setAssets(prev => ({
      ...prev,
      [asset.id]: asset
    }));
  }, []);

  const handleReset = useCallback(() => {
    setImageSrc(null);
    setSlices([]);
    setProcessedImageData(null);
    setOriginalImageData(null);
    setKeyColor(null);
    setAssets({});
  }, []);

  // Triggers zipping and downloading all active assets in a single structured file
  const handleDownloadAll = async () => {
    const activeAssets = (Object.values(assets) as ProcessedAsset[]).filter(asset => 
      slices.some(s => s.id === asset.id)
    );
    if (activeAssets.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      
      activeAssets.forEach(asset => {
        // 1. Add SVG files to root
        zip.file(`${asset.name}.svg`, asset.svgCode);

        // 2. Add compressed/configured raster files to a format-named subfolder
        const rasterUrl = asset.rasterDataUrl || asset.pngDataUrl;
        const format = asset.rasterFormat || 'png';
        if (rasterUrl && rasterUrl.includes(',')) {
          const base64Content = rasterUrl.split(',')[1];
          zip.file(`${format}/${asset.name}.${format}`, base64Content, { base64: true });
        }
      });

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sliced_assets_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to create ZIP archive:', err);
    } finally {
      setIsZipping(false);
    }
  };

  const activeAssetsCount = slices.filter(s => !!assets[s.id]).length;

  return (
    <div className="min-h-screen bg-neutral-50/60 text-neutral-800 flex flex-col font-sans">
      
      {/* Premium Header */}
      <header className="w-full bg-white border-b border-neutral-100/80 sticky top-0 z-40 backdrop-blur-md shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center shadow-md">
              <Scissors className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-neutral-800 text-sm sm:text-base leading-tight">
                Нарезка и Векторизация
              </h1>
              <p className="text-[10px] text-neutral-400 font-medium">
                Asset Slicer & SVG Vectorizer
              </p>
            </div>
          </div>

          {/* Quick Stats Pill */}
          {imageSrc && (
            <div className="flex items-center gap-2 bg-neutral-50 border border-neutral-100 rounded-full px-3 py-1 text-xs">
              <Smartphone className="w-3.5 h-3.5 text-neutral-400" />
              <span className="text-neutral-500 font-medium hidden sm:inline">Готово для телефона:</span>
              <span className="text-neutral-900 font-bold font-mono">{slices.length} объектов</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6 flex flex-col gap-6">
        
        <AnimatePresence mode="wait">
          {!imageSrc ? (
            /* Upload State */
            <motion.div
              key="uploader-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex-1 flex flex-col items-center justify-center py-8 lg:py-16"
            >
              {/* Introduction Text Block */}
              <div className="text-center max-w-xl mb-8">
                <div className="inline-flex items-center gap-1.5 bg-neutral-900 text-white font-semibold text-xs rounded-full px-3.5 py-1.5 mb-4 shadow-sm">
                  <Sparkles className="w-3.5 h-3.5" />
                  Оптимизировано для мобильных телефонов
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold text-neutral-900 tracking-tight leading-tight">
                  Вырезайте иконки, удаляйте фон и конвертируйте в SVG за секунды
                </h2>
                <p className="text-neutral-500 text-sm sm:text-base mt-2 px-4 leading-relaxed">
                  Загрузите любое изображение, логотип или коллаж графики. Приложение автоматически разделит его на прозрачные, аккуратно кадрированные векторные файлы.
                </p>
              </div>

              {/* Uploader Card */}
              <ImageUploader onImageSelected={handleImageSelected} />

              {/* Explanatory visual step-by-step footer */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl w-full mt-12 pt-8 border-t border-neutral-100/80">
                <div className="flex items-start gap-3">
                  <div className="w-6.5 h-6.5 rounded-full bg-neutral-100 text-neutral-800 font-bold text-xs flex items-center justify-center shrink-0">1</div>
                  <div>
                    <h5 className="font-bold text-neutral-800 text-xs">Загрузка листа</h5>
                    <p className="text-[10px] text-neutral-400 leading-normal mt-0.5">Сделайте фото на камеру или выберите картинку с иконками.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6.5 h-6.5 rounded-full bg-neutral-100 text-neutral-800 font-bold text-xs flex items-center justify-center shrink-0">2</div>
                  <div>
                    <h5 className="font-bold text-neutral-800 text-xs">Авто-нарезка и чистка</h5>
                    <p className="text-[10px] text-neutral-400 leading-normal mt-0.5">Фон становится прозрачным. Объекты нарезаются в отдельные рамки.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6.5 h-6.5 rounded-full bg-neutral-100 text-neutral-800 font-bold text-xs flex items-center justify-center shrink-0">3</div>
                  <div>
                    <h5 className="font-bold text-neutral-800 text-xs">Векторный SVG экспорт</h5>
                    <p className="text-[10px] text-neutral-400 leading-normal mt-0.5">Получите чистые SVG файлы или скопируйте код прямо в разметку сайта.</p>
                  </div>
                </div>
              </div>

            </motion.div>
          ) : (
            /* Active Workspace State */
            <motion.div
              key="workspace-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex flex-col gap-6"
            >
              
              {/* Workspace Board */}
              <Workspace 
                imageSrc={imageSrc} 
                onSlicesUpdated={handleSlicesUpdated} 
                onReset={handleReset}
              />

              {/* Sliced Output Result Assets Area */}
              <div id="results-section" className="w-full border-t border-neutral-200/50 pt-8 pb-12">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                  <div>
                    <h3 className="font-bold text-neutral-950 text-lg flex items-center gap-2">
                      <Layers className="w-5 h-5 text-neutral-600" />
                      Результаты нарезки ассетов
                    </h3>
                    <p className="text-xs text-neutral-500 leading-relaxed">
                      Каждый выделенный объект вырезан с прозрачным фоном и готов к загрузке в SVG формате.
                    </p>
                  </div>

                  {/* Batch Actions */}
                  {activeAssetsCount > 0 && (
                    <button
                      id="btn-download-all"
                      onClick={handleDownloadAll}
                      disabled={isZipping}
                      className="flex items-center gap-2 py-3 px-5 bg-neutral-900 hover:bg-neutral-800 disabled:bg-neutral-600 text-white rounded-xl font-semibold text-xs transition-all shadow-md active:scale-95 w-full sm:w-auto justify-center"
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
                  )}
                </div>

                {/* Grid Lists of Assets */}
                {slices.length === 0 ? (
                  <div className="w-full bg-white border border-neutral-100 rounded-2xl p-10 text-center flex flex-col items-center justify-center">
                    <div className="w-12 h-12 bg-neutral-50 rounded-full flex items-center justify-center border border-neutral-100 mb-3 text-neutral-400">
                      <Info className="w-5 h-5" />
                    </div>
                    <h5 className="font-bold text-neutral-800 text-sm mb-1">
                      Объекты не обнаружены
                    </h5>
                    <p className="text-xs text-neutral-500 max-w-sm leading-relaxed">
                      Попробуйте отрегулировать допуск цвета фона во вкладке **Фон**, уменьшить **Размер объекта** или обведите границы нужного элемента вручную в режиме **Выделение**.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    {processedImageData && slices.map(slice => (
                      <AssetCard
                        key={slice.id}
                        slice={slice}
                        processedImageData={processedImageData}
                        originalImageData={originalImageData}
                        keyColor={keyColor}
                        onAssetUpdated={handleAssetUpdated}
                      />
                    ))}
                  </div>
                )}
              </div>

            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* Clean Mobile-friendly footer */}
      <footer className="w-full border-t border-neutral-100 bg-white py-6 mt-auto text-center text-neutral-400 text-xs">
        <p className="font-medium">
          Asset Slicer & SVG Vectorizer — Удобное кадрирование и векторизация графики прямо с мобильного телефона.
        </p>
      </footer>

    </div>
  );
}
