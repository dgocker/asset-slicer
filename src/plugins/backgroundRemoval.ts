/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Типизированный мост к нативному Capacitor-плагину BackgroundRemoval (Android).
 * Контракт должен совпадать с BackgroundRemovalPlugin.kt.
 */

import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

/** Событие прогресса скачивания модели (не чаще ~4 раз/сек). */
export interface ModelDownloadProgressEvent {
  /** Скачано байт (включая уже имеющуюся часть .part при докачке). */
  loaded: number;
  /** Полный размер файла в байтах (0, если сервер не сообщил). */
  total: number;
  /** true, если загрузка продолжается с ранее скачанной части (.part). */
  resumed: boolean;
}

/** Легаси-событие прогресса (проценты). */
export interface DownloadProgressEvent {
  percent: number;
}

export interface RemoveBackgroundResult {
  uri: string;
  path: string;
}

/** Точка-промпт MobileSAM (пиксели оригинала; label 1 = точка объекта). */
export interface SamPoint {
  x: number;
  y: number;
  label: number;
}

/** Рамка-промпт MobileSAM (пиксели оригинала, углы left-top / right-bottom). */
export interface SamBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SamPrepareResult {
  /** Размеры листа, для которого посчитан embedding. */
  width: number;
  height: number;
}

export interface SamPromptResult {
  /** PNG-маска (base64 без dataURL-префикса): белый непрозрачный = объект. */
  maskBase64: string;
  width: number;
  height: number;
  /** Предсказанный IoU маски (уверенность модели). */
  iou: number;
}

export interface BackgroundRemovalPlugin {
  /**
   * Скачивает и кэширует ONNX-модель с поддержкой докачки (HTTP Range).
   * При переданном sha256 файл проверяется по контрольной сумме
   * (при несовпадении — файл удаляется и промис отклоняется).
   */
  preloadModel(options: { url: string; sha256?: string }): Promise<void>;

  /**
   * Удаляет фон с изображения (base64 dataURL).
   * При raw=true маска модели (после sigmoid) применяется как альфа напрямую,
   * без guided filter и EdgeCleanup.
   */
  removeBackground(options: {
    image: string;
    url: string;
    raw?: boolean;
  }): Promise<RemoveBackgroundResult>;

  releaseModel(): Promise<void>;

  /**
   * Готовит MobileSAM для листа: кэширует сессии энкодера/декодера и считает
   * embedding изображения (обе модели должны быть скачаны через preloadModel).
   */
  samPrepare(options: {
    encoderUrl: string;
    decoderUrl: string;
    /** Лист: dataURL / base64 / uri — как в removeBackground. */
    image: string;
  }): Promise<SamPrepareResult>;

  /**
   * Сегментация по промпту (точки и/или рамка в пикселях оригинала)
   * на embedding-е, посчитанном samPrepare.
   */
  samPrompt(options: {
    points?: SamPoint[];
    box?: SamBox;
  }): Promise<SamPromptResult>;

  /** Освобождает embedding листа (сессии SAM остаются прогретыми). */
  samRelease(): Promise<void>;

  /**
   * Открывает системный выбор папки (SAF, ACTION_OPEN_DOCUMENT_TREE).
   * Выбранный tree-URI сохраняется в SharedPreferences с persistable-правами.
   * Реджектится, если пользователь закрыл пикер без выбора.
   */
  pickExportFolder(): Promise<{ uri: string; name: string }>;

  /**
   * Ранее выбранная папка экспорта. Пустой объект, если папка не выбрана
   * или разрешение на неё отозвано/протухло.
   */
  getExportFolder(): Promise<{ uri?: string; name?: string }>;

  /**
   * Сохраняет файл (base64, с dataURL-префиксом или без) в выбранную
   * SAF-папку. {saved:false, reason:'no-folder'} — папка не выбрана либо
   * доступ к ней потерян; вызывающий код решает, что делать дальше.
   */
  saveToExportFolder(options: {
    filename: string;
    base64: string;
    mime: string;
  }): Promise<{ saved: boolean; path?: string; reason?: string }>;

  isModelCached(options: { url: string }): Promise<{ isCached: boolean }>;

  /** ОЗУ и ядра устройства — для рекомендаций моделей под железо. */
  getDeviceInfo(): Promise<{ totalMemBytes: number; cores: number }>;

  clearCachedModels(): Promise<{ deletedCount: number }>;

  addListener(
    eventName: 'modelDownloadProgress',
    listenerFunc: (event: ModelDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: DownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

export const BackgroundRemoval =
  registerPlugin<BackgroundRemovalPlugin>('BackgroundRemoval');
