/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

/**
 * Типизированная ошибка «SAF-папка сохранения не выбрана / доступ потерян».
 * Бросается ВМЕСТО тихого падения в легаси-путь: вызывающий код должен
 * показать пользователю выбор папки (модалка «Куда сохранять ассеты?»).
 */
export class NoExportFolderError extends Error {
  readonly code = 'NO_FOLDER';
  constructor() {
    super('Папка сохранения не выбрана');
    this.name = 'NoExportFolderError';
  }
}

/** MIME-тип по расширению файла (для DocumentFile.createFile). */
const mimeFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
};

/**
 * Downloads/saves a binary file (from base64 or blob, like ZIP/PNG) to the device.
 * On Web: downloads via Blob URL or Data URL.
 * On Native (Android): saves to the user-picked SAF folder (saveToExportFolder);
 * the legacy Documents/<exportFolder> path is used only when the user explicitly
 * chose it ('downloadTarget' === 'legacy') or the native SAF layer is missing.
 * Throws NoExportFolderError when no SAF folder is picked / permission is lost.
 *
 * options.silent — тихий режим для пакетного скачивания: не показывает alert
 * об успехе на каждый файл; при полном провале записи бросает ошибку,
 * чтобы вызывающий код показал один итоговый диалог.
 */
export async function downloadBinaryFile(
  filename: string,
  base64Content: string,
  blobFallback?: Blob,
  options?: { silent?: boolean }
) {
  const silent = !!options?.silent;
  if (Capacitor.isNativePlatform()) {
    // --- Основной путь: SAF-папка, выбранная пользователем ---
    if (localStorage.getItem('downloadTarget') !== 'legacy') {
      try {
        const { BackgroundRemoval } = await import('../plugins/backgroundRemoval');
        const cleanBase64 = base64Content.includes(',')
          ? base64Content.split(',')[1]
          : base64Content;
        const res = await BackgroundRemoval.saveToExportFolder({
          filename,
          base64: cleanBase64,
          mime: mimeFromFilename(filename),
        });
        if (res && res.saved) {
          if (!silent) {
            alert(`Файл успешно сохранен: ${res.path || filename}`);
          }
          console.log('Saved binary file via SAF:', res.path);
          return;
        }
        // saved:false → папки нет или доступ отозван: НЕ падаем в легаси молча
        throw new NoExportFolderError();
      } catch (e) {
        if (e instanceof NoExportFolderError) throw e;
        const msg = String((e as any)?.message || e);
        const unimplemented =
          (e as any)?.code === 'UNIMPLEMENTED' || msg.includes('not implemented');
        if (!unimplemented) {
          // Реальная ошибка записи в выбранную папку — показываем/пробрасываем
          if (silent) throw e;
          alert('Ошибка при сохранении файла: ' + msg);
          return;
        }
        // Старый нативный слой без SAF-методов — проваливаемся в легаси-путь
        console.warn('SAF export unavailable, falling back to legacy path:', msg);
      }
    }

    // --- Легаси-путь: Documents/<exportFolder> через Filesystem ---
    try {
      try {
        const perm = await Filesystem.checkPermissions();
        if (perm.publicStorage !== 'granted') {
          await Filesystem.requestPermissions();
        }
      } catch (permErr) {
        console.warn('Could not check/request storage permissions:', permErr);
      }

      // Clean base64 header if present
      const cleanBase64 = base64Content.includes(',') ? base64Content.split(',')[1] : base64Content;

      const exportFolder = localStorage.getItem('exportFolder') || 'Download';
      const result = await Filesystem.writeFile({
        path: `${exportFolder}/${filename}`,
        data: cleanBase64,
        directory: Directory.Documents,
        recursive: true
      });
      if (!silent) {
        alert(`Файл успешно сохранен в Documents/${exportFolder}/${filename}`);
      }
      console.log('Saved binary file successfully:', result.uri);
    } catch (e) {
      const exportFolder = localStorage.getItem('exportFolder') || 'Download';
      console.error(`Natively saving binary file to ${exportFolder}/ failed, trying root folder:`, e);
      try {
        const cleanBase64 = base64Content.includes(',') ? base64Content.split(',')[1] : base64Content;
        await Filesystem.writeFile({
          path: filename,
          data: cleanBase64,
          directory: Directory.Documents,
          recursive: true
        });
        if (!silent) {
          alert(`Файл сохранен в корне Documents: ${filename}`);
        }
      } catch (err2) {
        if (silent) {
          throw err2;
        }
        alert('Ошибка при сохранении файла: ' + String(err2));
      }
    }
  } else {
    // Web implementation
    let url = '';
    if (blobFallback) {
      url = URL.createObjectURL(blobFallback);
    } else {
      url = base64Content;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (blobFallback) {
      URL.revokeObjectURL(url);
    }
  }
}
