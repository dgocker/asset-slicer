/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Галерея готовых ассетов: результаты per-object ИИ-вырезания.
 * Карточки появляются по мере обработки; каждый ассет можно скачать,
 * упавший — повторить, все готовые — скачать по очереди одной кнопкой.
 */

import React, { useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  Download,
  FolderDown,
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
  onOpenInEditor: () => void;
}

/** CSS-шахматка, как в AssetCard (та же техника: 4 linear-gradient по 45°). */
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

/**
 * Скачивание одного PNG-ассета через общий downloadHelper (native/web).
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
  onOpenInEditor,
}: AssetGalleryProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  const doneAssets = assets.filter((a) => a.status === 'done' && a.blob);
  const errorCount = assets.filter((a) => a.status === 'error').length;
  const busy = isProcessing || isDownloadingAll || downloadingId !== null;

  const handleDownloadOne = async (asset: ObjectAsset) => {
    if (!asset.blob || downloadingId) return;
    setDownloadingId(asset.id);
    try {
      await downloadAssetBlob(`${sanitizeFileName(asset.label)}.png`, asset.blob);
    } catch (e) {
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
        await downloadAssetBlob(`${safeName}.png`, asset.blob, true);
        savedCount++;
      }
      if (Capacitor.isNativePlatform() && savedCount > 0) {
        const exportFolder = localStorage.getItem('exportFolder') || 'Download';
        alert(`Сохранено файлов: ${savedCount} (Documents/${exportFolder}/)`);
      }
    } catch (e) {
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
              onClick={onOpenInEditor}
              disabled={isProcessing}
              className="flex items-center gap-1.5 py-2.5 px-4 bg-zinc-950/60 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Открыть оригинальный лист в классическом редакторе нарезки"
            >
              <PencilRuler className="w-3.5 h-3.5" />
              Открыть в редакторе
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
    </div>
  );
}
