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
