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
import { Capacitor, registerPlugin } from '@capacitor/core';
import JSZip from 'jszip';
import { Slice, ProcessedAsset, ColorRGB } from './types';
import ImageUploader from './components/ImageUploader';
import Workspace from './components/Workspace';
import AssetCard from './components/AssetCard';

const BackgroundRemoval = registerPlugin<any>('BackgroundRemoval');

interface SavedModel {
  name: string;
  url: string;
  sizeLabel: string;
  isPreset: boolean;
  description: string;
}

const DEFAULT_PRESETS: SavedModel[] = [
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
  const [isAIRemoving, setIsAIRemoving] = useState(false);
  const [useAIBgRemoval, setUseAIBgRemoval] = useState(true);
  const [aiProgress, setAiProgress] = useState<string>('Инициализация...');
  const [aiPercent, setAiPercent] = useState<number>(0);

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

  useEffect(() => {
    return () => {
      revokeAllBlobs();
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
    return localStorage.getItem('customModelUrl') || 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx';
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

  const handleImageSelected = useCallback(async (file: File) => {
    const requestId = ++imageLoadRequestIdRef.current;
    
    // Revoke previous blob URLs to prevent memory leaks in WebView
    revokeAllBlobs();

    const dataUrl = registerBlobUrl(URL.createObjectURL(file));
    setOriginalImageSrc(dataUrl);
    if (!useAIBgRemoval) {
      setImageSrc(dataUrl);
      setAssets({});
      setIsAIRemoving(false);
      setAiPercent(0);
      return;
    }

    setIsAIRemoving(true);
    setAiProgress('Инициализация ИИ...');
    setAiPercent(10);

    try {
      if (Capacitor.isNativePlatform()) {
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
        setIsAIRemoving(false);
        setAiPercent(0);
        setAssets({});
      }
    }
  }, [useAIBgRemoval, localModel, modelDownloadUrl, customModelUrl]);

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
    revokeAllBlobs();
    setImageSrc(null);
    setOriginalImageSrc(null);
    setSlices([]);
    processedImageDataRef.current = null;
    originalImageDataRef.current = null;
    setKeyColor(null);
    setAssets({});
    setDataVersion(0);
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
    let progressListener: any = null;
    try {
      if (Capacitor.isNativePlatform()) {
        progressListener = await (BackgroundRemoval as any).addListener(
          'downloadProgress',
          (info: any) => {
            if (info && typeof info.percent === 'number') {
              setModelDownloadProgress(info.percent);
            }
          }
        );

        await BackgroundRemoval.preloadModel({ url: customModelUrl });
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

          {isAIRemoving ? (
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
                Локальная нейросеть вырезает фон прямо в вашем браузере. Это абсолютно безопасно и работает офлайн.
              </p>
            </div>
          ) : !imageSrc ? (
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
                aiImageSrc={useAIBgRemoval ? imageSrc : null}
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
                              Загрузка модели...
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
