/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

/**
 * Downloads/saves a text file (like SVG) to the device.
 * On Web: standard browser download.
 * On Native (Android): saves to Documents/Download folder.
 */
export async function downloadTextFile(filename: string, content: string) {
  if (Capacitor.isNativePlatform()) {
    try {
      try {
        const perm = await Filesystem.checkPermissions();
        if (perm.publicStorage !== 'granted') {
          await Filesystem.requestPermissions();
        }
      } catch (permErr) {
        console.warn('Could not check/request storage permissions:', permErr);
      }

      const exportFolder = localStorage.getItem('exportFolder') || 'Download';
      const result = await Filesystem.writeFile({
        path: `${exportFolder}/${filename}`,
        data: content,
        directory: Directory.Documents,
        recursive: true,
        encoding: Encoding.UTF8
      });
      alert(`Файл успешно сохранен в Documents/${exportFolder}/${filename}`);
      console.log('Saved text file successfully:', result.uri);
    } catch (e) {
      const exportFolder = localStorage.getItem('exportFolder') || 'Download';
      console.error(`Natively saving text file to ${exportFolder}/ failed, trying root folder:`, e);
      try {
        await Filesystem.writeFile({
          path: filename,
          data: content,
          directory: Directory.Documents,
          recursive: true,
          encoding: Encoding.UTF8
        });
        alert(`Файл сохранен в корне Documents: ${filename}`);
      } catch (err2) {
        alert('Ошибка при сохранении файла: ' + String(err2));
      }
    }
  } else {
    // Web implementation
    const blob = new Blob([content], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * Downloads/saves a binary file (from base64 or blob, like ZIP/PNG) to the device.
 * On Web: downloads via Blob URL or Data URL.
 * On Native (Android): saves to Documents/Download folder.
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
