/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Галерея готовых ассетов: результаты per-object ИИ-вырезания.
 * Карточки появляются по мере обработки; каждый ассет можно скачать,
 * упавший — повторить, все готовые — скачать по очереди одной кнопкой.
 */

import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  Download,
  FolderDown,
  FolderOpen,
  Hourglass,
  Images,
  Loader2,
  PencilRuler,
  RefreshCw,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ObjectAsset } from '../types';

interface AssetGalleryProps {
  assets: ObjectAsset[];
  /** Идёт ли сейчас обработка (пакетная или повтор одного объекта). */
  isProcessing: boolean;
  progressText: string;
  progressPercent: number;
  onRetry: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onBackToSelector: () => void;
  /** Открыть готовый ассет в редакторе (ластик/восстановление/кроп/экспорт). */
  onEdit: (id: string) => void;
}

/** CSS-шахматка под превью ассета (4 linear-gradient по 45°). */
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #52525b 25%, transparent 25%), linear-gradient(-45deg, #52525b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #52525b 75%), linear-gradient(-45deg, transparent 75%, #52525b 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

const sanitizeFileName = (name: string): string => {
  const safe = name.replace(/[\/\\?%*:|"<>\s]+/g, '_').trim();
  return !safe || safe === '_' ? 'asset' : safe;
};

/** Расширение файла по mime-типу blob'а (после редактора ассет может стать WebP). */
const blobExt = (blob: Blob): string => (blob.type === 'image/webp' ? 'webp' : 'png');

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
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
    reader.readAsDataURL(blob);
  });

const loadImageFromBlob = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      try { URL.revokeObjectURL(url); } catch (e) {}
    };
    img.onload = () => { cleanup(); resolve(img); };
    img.onerror = (err) => { cleanup(); reject(err); };
    img.src = url;
  });

/** Кэш перекодировок: blob → результат для конкретного формата/качества. */
const encodeCache = new WeakMap<Blob, { key: string; out: Blob }>();

/**
 * Перекодирует ассет в выбранный формат скачивания (blob → Image → canvas →
 * toBlob). PNG→PNG и WebP→WebP отдаются как есть (без повторного lossy).
 * Если браузер не умеет кодировать WebP и вернул image/png — скачиваем PNG
 * (имя файла берёт расширение по итоговому mime через blobExt).
 */
async function encodeBlobForDownload(
  src: Blob,
  format: 'png' | 'webp',
  quality: number,
): Promise<Blob> {
  if (format === 'png' && src.type === 'image/png') return src;
  if (format === 'webp' && src.type === 'image/webp') return src;

  const key = `${format}:${quality}`;
  const cached = encodeCache.get(src);
  if (cached && cached.key === key) return cached.out;

  const img = await loadImageFromBlob(src);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, img.naturalWidth);
  canvas.height = Math.max(1, img.naturalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);

  const mime = format === 'webp' ? 'image/webp' : 'image/png';
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось перекодировать ассет'))),
      mime,
      format === 'webp' ? quality / 100 : undefined,
    ),
  );
  encodeCache.set(src, { key, out });
  return out;
}

/**
 * Скачивание одного ассета (PNG/WebP) через общий downloadHelper (native/web).
 * silent=true — тихий режим для пакетного скачивания (без alert на каждый файл).
 */
async function downloadAssetBlob(filename: string, blob: Blob, silent = false): Promise<void> {
  const { downloadBinaryFile } = await import('../utils/downloadHelper');
  if (Capacitor.isNativePlatform()) {
    const dataUrl = await blobToDataUrl(blob);
    await downloadBinaryFile(filename, dataUrl, undefined, { silent });
  } else {
    await downloadBinaryFile(filename, '', blob, { silent });
  }
}

export default function AssetGallery({
  assets,
  isProcessing,
  progressText,
  progressPercent,
  onRetry,
  onRename,
  onBackToSelector,
  onEdit,
}: AssetGalleryProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  // Формат скачивания (общий для «Скачать» и «Скачать все»), живёт в localStorage
  const [downloadFormat, setDownloadFormat] = useState<'png' | 'webp'>(() =>
    localStorage.getItem('downloadFormat') === 'webp' ? 'webp' : 'png',
  );
  const [downloadQuality, setDownloadQuality] = useState<number>(() => {
    const v = parseInt(localStorage.getItem('downloadQuality') || '85', 10);
    return Number.isFinite(v) ? Math.min(100, Math.max(10, v)) : 85;
  });

  const selectFormat = (fmt: 'png' | 'webp') => {
    setDownloadFormat(fmt);
    localStorage.setItem('downloadFormat', fmt);
  };
  const changeQuality = (q: number) => {
    setDownloadQuality(q);
    localStorage.setItem('downloadQuality', String(q));
  };

  // Модалка «Куда сохранять ассеты?» (Android): выбор SAF-папки или легаси-пути
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const folderResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const doneAssets = assets.filter((a) => a.status === 'done' && a.blob);
  const errorCount = assets.filter((a) => a.status === 'error').length;
  const busy = isProcessing || isDownloadingAll || downloadingId !== null;

  /**
   * Перед первым скачиванием на Android выясняем, КУДА сохранять:
   * если пользователь уже выбрал SAF-папку (getExportFolder непуст) или явно
   * выбрал легаси-путь ('downloadTarget' === 'legacy') — скачиваем сразу,
   * иначе показываем модалку выбора. false = пользователь отменил.
   */
  const ensureDownloadTarget = async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform()) return true;
    if (localStorage.getItem('downloadTarget') === 'legacy') return true;
    try {
      const { BackgroundRemoval } = await import('../plugins/backgroundRemoval');
      const folder = await BackgroundRemoval.getExportFolder();
      if (folder && folder.uri) {
        localStorage.setItem('downloadTarget', 'saf');
        return true;
      }
    } catch (e) {
      // Старый нативный слой без SAF-методов — работаем по легаси-пути
      console.warn('getExportFolder unavailable:', e);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      folderResolveRef.current = resolve;
      setFolderModalOpen(true);
    });
  };

  const closeFolderModal = (ok: boolean) => {
    setFolderModalOpen(false);
    const resolve = folderResolveRef.current;
    folderResolveRef.current = null;
    if (resolve) resolve(ok);
  };

  const handlePickFolder = async () => {
    if (isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const { BackgroundRemoval } = await import('../plugins/backgroundRemoval');
      const res = await BackgroundRemoval.pickExportFolder();
      if (res && res.uri) {
        localStorage.setItem('downloadTarget', 'saf');
        closeFolderModal(true);
      }
    } catch (e) {
      // Пользователь закрыл системный пикер — модалка остаётся открытой
      console.warn('Folder pick cancelled/failed:', e);
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleUseLegacyFolder = () => {
    localStorage.setItem('downloadTarget', 'legacy');
    closeFolderModal(true);
  };

  /** SAF-папка протухла/удалена посреди скачивания — просим выбрать заново. */
  const handleNoFolderError = () => {
    localStorage.removeItem('downloadTarget');
    folderResolveRef.current = null;
    setFolderModalOpen(true);
  };

  const isNoFolderError = (e: unknown): boolean =>
    (e as any)?.code === 'NO_FOLDER';

  const handleDownloadOne = async (asset: ObjectAsset) => {
    if (!asset.blob || downloadingId) return;
    setDownloadingId(asset.id);
    try {
      if (!(await ensureDownloadTarget())) return;
      const out = await encodeBlobForDownload(asset.blob, downloadFormat, downloadQuality);
      await downloadAssetBlob(`${sanitizeFileName(asset.label)}.${blobExt(out)}`, out);
    } catch (e) {
      if (isNoFolderError(e)) {
        alert('Папка сохранения недоступна. Выберите папку заново.');
        handleNoFolderError();
        return;
      }
      console.error('Asset download failed:', e);
      alert('Ошибка при скачивании файла: ' + String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDownloadAll = async () => {
    if (doneAssets.length === 0 || isDownloadingAll) return;
    setIsDownloadingAll(true);
    try {
      if (!(await ensureDownloadTarget())) return;
      const nameCounts: Record<string, number> = {};
      let savedCount = 0;
      for (const asset of doneAssets) {
        if (!asset.blob) continue;
        let safeName = sanitizeFileName(asset.label);
        if (nameCounts[safeName] !== undefined) {
          nameCounts[safeName]++;
          safeName = `${safeName}_${nameCounts[safeName]}`;
        } else {
          nameCounts[safeName] = 1;
        }
        // По очереди — тем же helper-ом, но в тихом режиме:
        // один итоговый alert вместо N блокирующих диалогов на каждый файл
        const out = await encodeBlobForDownload(asset.blob, downloadFormat, downloadQuality);
        await downloadAssetBlob(`${safeName}.${blobExt(out)}`, out, true);
        savedCount++;
      }
      if (Capacitor.isNativePlatform() && savedCount > 0) {
        if (localStorage.getItem('downloadTarget') === 'saf') {
          alert(`Сохранено файлов: ${savedCount} (в выбранную папку)`);
        } else {
          const exportFolder = localStorage.getItem('exportFolder') || 'Download';
          alert(`Сохранено файлов: ${savedCount} (Documents/${exportFolder}/)`);
        }
      }
    } catch (e) {
      if (isNoFolderError(e)) {
        alert('Папка сохранения недоступна. Выберите папку заново.');
        handleNoFolderError();
        return;
      }
      console.error('Download all failed:', e);
      alert('Ошибка при скачивании файлов: ' + String(e));
    } finally {
      setIsDownloadingAll(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-5 mt-2 max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-3xl p-4 sm:p-6 flex flex-col gap-5 relative shadow-xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h3 className="font-extrabold text-zinc-100 text-base sm:text-lg flex items-center gap-2.5 tracking-tight">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center shadow-md">
                <Images className="w-4 h-4 text-white" />
              </div>
              Галерея готовых ассетов
            </h3>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed max-w-xl">
              Каждый объект вырезан нейросетью отдельно и обрезан по границам
              непрозрачных пикселей. Готово: {doneAssets.length} из {assets.length}
              {errorCount > 0 ? `, с ошибкой: ${errorCount}` : ''}.
            </p>
          </div>

          {/* Top actions */}
          <div className="flex flex-wrap gap-2 shrink-0">
            <button
              onClick={onBackToSelector}
              disabled={isProcessing}
              className="flex items-center gap-1.5 py-2.5 px-4 bg-zinc-950/60 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Вернуться к выбору объектов (рамки сохранятся)"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              К выбору объектов
            </button>
            <button
              onClick={handleDownloadAll}
              disabled={busy || doneAssets.length === 0}
              className="flex items-center gap-1.5 py-2.5 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-xl text-xs font-bold transition-all shadow-[0_4px_12px_rgba(124,58,237,0.25)] hover:shadow-[0_4px_20px_rgba(124,58,237,0.4)] cursor-pointer active:scale-95 disabled:cursor-not-allowed"
            >
              {isDownloadingAll ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderDown className="w-3.5 h-3.5" />
              )}
              Скачать все ({doneAssets.length})
            </button>
          </div>
        </div>

        {/* Download format panel (applies to single and batch download) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 bg-zinc-950/40 border border-zinc-800/80 rounded-2xl px-4 py-2.5">
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-500 shrink-0">
            Формат скачивания
          </span>
          <div className="flex gap-1 bg-zinc-900/60 border border-zinc-800 rounded-xl p-1">
            <button
              type="button"
              onClick={() => selectFormat('png')}
              className={`py-1.5 px-3.5 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                downloadFormat === 'png'
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => selectFormat('webp')}
              className={`py-1.5 px-3.5 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                downloadFormat === 'webp'
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              WebP
            </button>
          </div>
          {downloadFormat === 'webp' && (
            <div className="flex items-center gap-2.5 flex-1 min-w-[170px] max-w-xs">
              <span className="text-[10px] font-bold text-zinc-500 shrink-0">Качество</span>
              <input
                type="range"
                min="10"
                max="100"
                value={downloadQuality}
                onChange={(e) => changeQuality(parseInt(e.target.value, 10))}
                className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-violet-500"
              />
              <span className="text-[10px] font-mono font-bold text-violet-300 w-7 text-right shrink-0">
                {downloadQuality}
              </span>
            </div>
          )}
        </div>

        {/* Progress banner during processing */}
        {isProcessing && (
          <div className="flex items-center gap-4 bg-zinc-950/60 border border-zinc-800 rounded-2xl px-4 py-3 animate-in fade-in duration-300">
            <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
            <span className="text-xs font-semibold text-zinc-300 shrink-0">
              {progressText}
            </span>
            <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-full h-2.5 p-0.5 overflow-hidden shadow-inner">
              <div
                className="h-full bg-gradient-to-r from-violet-600 via-fuchsia-500 to-emerald-500 transition-all duration-500 ease-out rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs font-bold font-mono text-violet-300 shrink-0">
              {progressPercent}%
            </span>
          </div>
        )}

        {/* Cards grid */}
        {assets.length === 0 ? (
          <div className="w-full bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-10 text-center text-zinc-400 text-xs">
            Нет обработанных объектов. Вернитесь к выбору объектов и отметьте рамки.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="bg-zinc-950/60 border border-zinc-800 rounded-2xl p-3 flex flex-col gap-3 shadow-lg animate-in fade-in zoom-in-95 duration-300"
              >
                {/* Preview on checkerboard */}
                <div className="relative w-full h-44 rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 flex items-center justify-center">
                  <div
                    className="absolute inset-0 opacity-20 pointer-events-none"
                    style={CHECKERBOARD_STYLE}
                  />
                  {asset.status === 'done' && asset.displayUrl ? (
                    <img
                      src={asset.displayUrl}
                      alt={asset.label}
                      draggable={false}
                      className="relative z-10 max-w-full max-h-full object-contain p-2 select-none"
                    />
                  ) : asset.status === 'error' ? (
                    <div className="relative z-10 flex flex-col items-center gap-2 text-red-400 px-4 text-center">
                      <AlertTriangle className="w-7 h-7" />
                      <span className="text-[11px] font-semibold leading-snug">
                        {asset.error || 'Ошибка обработки'}
                      </span>
                    </div>
                  ) : asset.status === 'processing' ? (
                    <div className="relative z-10 flex flex-col items-center gap-2 text-violet-300">
                      <Loader2 className="w-7 h-7 animate-spin" />
                      <span className="text-[11px] font-semibold">Обработка...</span>
                    </div>
                  ) : (
                    <div className="relative z-10 flex flex-col items-center gap-2 text-zinc-500">
                      <Hourglass className="w-6 h-6" />
                      <span className="text-[11px] font-semibold">В очереди</span>
                    </div>
                  )}
                </div>

                {/* Editable label */}
                <input
                  type="text"
                  value={asset.label}
                  onChange={(e) => onRename(asset.id, e.target.value)}
                  spellCheck={false}
                  className="w-full text-xs font-semibold text-zinc-100 bg-zinc-900/60 focus:bg-zinc-900 border border-zinc-800 focus:border-violet-500/50 rounded-xl px-3 py-2 outline-none transition-all"
                  title="Название ассета (имя файла при скачивании)"
                />

                {/* Note badge (нестандартный путь обработки, напр. фолбэк без ИИ) */}
                {asset.status === 'done' && asset.note && (
                  <span className="self-start inline-flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] font-semibold px-2.5 py-1 rounded-full leading-none">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    {asset.note}
                  </span>
                )}

                {/* Size + actions */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono font-semibold text-zinc-400">
                    {asset.status === 'done'
                      ? `${asset.width} × ${asset.height} px`
                      : `рамка ${Math.round(asset.rect.width)} × ${Math.round(asset.rect.height)} px`}
                  </span>

                  {asset.status === 'done' && asset.blob && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onEdit(asset.id)}
                        disabled={busy}
                        className="flex items-center gap-1.5 py-2 px-3 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded-xl text-[11px] font-bold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Открыть ассет в редакторе (ластик, восстановление, кроп, формат)"
                      >
                        <PencilRuler className="w-3.5 h-3.5" />
                        Редактировать
                      </button>
                      <button
                        onClick={() => handleDownloadOne(asset)}
                        disabled={busy}
                        className="flex items-center gap-1.5 py-2 px-3.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-xl text-[11px] font-bold transition-all shadow-md cursor-pointer active:scale-95 disabled:cursor-not-allowed"
                      >
                        {downloadingId === asset.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        Скачать
                      </button>
                    </div>
                  )}

                  {asset.status === 'error' && (
                    <button
                      onClick={() => onRetry(asset.id)}
                      disabled={isProcessing}
                      className="flex items-center gap-1.5 py-2 px-3.5 bg-red-950/20 hover:bg-red-950/40 border border-red-900/40 hover:border-red-800/60 rounded-xl text-[11px] font-bold text-red-400 hover:text-red-300 transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Повторить
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Модалка первого скачивания: куда сохранять ассеты (Android) */}
      {folderModalOpen && (
        <div className="fixed inset-0 bg-zinc-950/80 backdrop-blur-md flex items-center justify-center z-[70] p-4 animate-in fade-in duration-200">
          <div className="bg-zinc-900/95 border border-zinc-800 rounded-3xl shadow-2xl max-w-sm w-full p-6 flex flex-col gap-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center shrink-0 shadow-md">
                <FolderOpen className="w-4 h-4 text-white" />
              </div>
              <h3 className="font-extrabold text-zinc-100 text-sm tracking-tight">
                Куда сохранять ассеты?
              </h3>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Выберите папку на устройстве — все скачанные ассеты будут
              сохраняться в неё. Изменить выбор можно в настройках.
            </p>
            <button
              onClick={handlePickFolder}
              disabled={isPickingFolder}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-violet-950/30 cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed"
            >
              {isPickingFolder ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4" />
              )}
              Выбрать папку
            </button>
            <button
              onClick={handleUseLegacyFolder}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-zinc-950/60 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-[0.98]"
            >
              <FolderDown className="w-4 h-4" />
              Documents/Download (по умолчанию)
            </button>
            <button
              onClick={() => closeFolderModal(false)}
              className="w-full py-2 text-[11px] font-semibold text-zinc-500 hover:text-zinc-300 transition-all cursor-pointer"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
