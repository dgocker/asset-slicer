/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Локализация UI (ru/en). Словари — единственное место, где допустимы
 * пользовательские кириллические строки. Подстановки вида {name} в шаблонах.
 *
 * - Компоненты: const { t, lang, setLang } = useT();
 * - Не-компонентный код (downloadHelper и т.п.): tGlobal(key, vars) —
 *   читает текущий язык из module-level переменной, синхронизированной
 *   с контекстом через setLang.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

export type Lang = 'ru' | 'en';

type Vars = Record<string, string | number>;

const RU = {
  // --- Общие ---
  'common.cancel': 'Отмена',
  'common.done': 'Готово',
  'common.reset': 'Сброс',
  'common.quality': 'Качество',
  'common.download': 'Скачать',
  'common.processing': 'Обработка...',
  'units.mb': 'МБ',
  'units.kb': 'КБ',

  // --- Шапка / подвал ---
  'header.title': 'Нарезка ассетов',
  'header.subtitle': 'AI ASSET CUTTER',
  'header.settingsTitle': 'Настройки ИИ и скачивания',
  'header.langTitle': 'Язык интерфейса: RU / EN',
  'footer.tagline': 'Asset Slicer — ИИ-вырезание объектов из любого изображения прямо с телефона.',

  // --- Интро на главной ---
  'intro.badge': 'Оптимизировано для мобильных телефонов',
  'intro.title': 'Вырезайте ассеты из любого листа за секунды',
  'intro.subtitle': 'Загрузите лист с иконками, логотипами или графикой — ИИ вырежет каждый объект отдельно, с прозрачным фоном и аккуратной обрезкой.',
  'intro.step1.title': 'Загрузите лист',
  'intro.step1.text': 'Сделайте фото или выберите картинку с объектами из галереи.',
  'intro.step2.title': 'Выберите объекты',
  'intro.step2.text': 'Авто-детекция, вручную или умное выделение — как удобнее.',
  'intro.step3.title': 'Скачайте результат',
  'intro.step3.text': 'ИИ вырежет каждый объект отдельно — скачайте PNG или WebP.',

  // --- Загрузчик ---
  'uploader.title': 'Загрузите лист с ассетами',
  'uploader.dropHint': 'Перетащите файл сюда или нажмите для выбора из галереи',
  'uploader.chooseFile': 'Выбрать файл',
  'uploader.takePhoto': 'Сделать фото',
  'uploader.aiToggle': 'Авто-удаление фона через AI',
  'uploader.aiToggleDesc': 'Автоматически вырежет фон нейросетью прямо при загрузке.',
  'uploader.aiModel': 'Модель ИИ',
  'uploader.allSettings': 'Все настройки',
  'uploader.cached': '✓ скачана',
  'uploader.notCached': 'не скачана',
  'uploader.demoLabel': 'Быстрый тест без загрузки своих файлов',
  'uploader.demoIcons': 'Лист иконок (Белый фон)',
  'uploader.demoLogos': 'Лист логотипов (Светлый фон)',

  // --- Прогресс / обработка ---
  'progress.init': 'Инициализация...',
  'progress.preparing': 'Подготовка...',
  'progress.modelDownloadStart': 'Загрузка модели ИИ...',
  'progress.modelDownloadMb': 'Загрузка модели… {loaded} / {total} МБ',
  'progress.modelDownloadMbNoTotal': 'Загрузка модели… {loaded} МБ',
  'progress.resumedSuffix': ' (докачка)',
  'progress.objectOfN': 'Объект {i} из {n}',
  'progress.excludingNested': 'Исключение вложенных объектов...',
  'progress.retrying': 'Повторная обработка: {label}',
  'processing.downloadHint': 'Модель ИИ скачивается на устройство. Прерванная загрузка продолжится с того же места (докачка).',
  'processing.offlineHint': 'Локальная нейросеть вырезает фон прямо на устройстве, офлайн. Изображения никуда не отправляются.',
  'processing.cancel': 'Отменить',
  'processing.cancelTitle': 'Прервать обработку и вернуться назад',

  // --- Ассеты / конвейер ---
  'asset.objectN': 'Объект {n}',
  'asset.wholeSheet': 'Весь лист',
  'app.webAiUnsupported': 'Обработка доступна в мобильном приложении (Android). Соберите APK или скачайте его из релизов.',
  'app.lowMemWarning': 'На устройстве {gb} ГБ ОЗУ. Модель «Качество» (467 МБ) требует 6+ ГБ и может вылетать. Продолжить?',
  'app.aiReadError': 'Не удалось прочитать результат ИИ (HTTP {status})',
  'app.aiEmptyResult': 'ИИ вернул пустой результат',
  'app.colorEmptyResult': 'Объект не найден по цвету фона',
  'app.noteColorFallback': 'ИИ не нашёл объект — вырезано по цвету фона',
  'app.modelNotLoaded': 'Модель ИИ не загружена. Пожалуйста, откройте настройки и скачайте модель.',
  'app.processObjectsFailed': 'Обработка объектов не удалась: {error}',
  'app.processSheetFailed': 'Обработка листа не удалась: {error}',
  'app.modelDownloadDone': 'Модель ИИ успешно загружена и кэширована!',
  'app.modelDownloadError': 'Ошибка при загрузке модели: {error}',
  'app.cacheCleared': 'Кэш очищен. Удалено файлов моделей: {count}',
  'app.cacheClearError': 'Ошибка при очистке кэша: {error}',
  'app.pickedFolder': 'Выбранная папка',

  // --- Настройки ---
  'settings.title': 'Настройки ИИ и Экспорта',
  'settings.subtitle': 'Конфигурация для Android и Web',
  'settings.language': 'Язык интерфейса',
  'settings.nativeModel': 'Нативная модель ИИ (Android)',
  'settings.savedModels': 'Сохраненные локальные модели:',
  'settings.totalCount': 'Всего: {n}',
  'settings.deleteModelTitle': 'Удалить модель из списка',
  'settings.modelReady': 'Готова к работе',
  'settings.modelNeedsDownload': 'Требуется загрузка',
  'settings.modelActive': 'Активна',
  'settings.addModelLabel': 'Добавить свою ONNX модель в список:',
  'settings.modelNamePlaceholder': 'Название (например, BiRefNet-General)',
  'settings.modelUrlPlaceholder': 'Прямой URL-адрес к .onnx файлу',
  'settings.addModelValidation': 'Пожалуйста, введите название и URL модели',
  'settings.addModelUrlInvalid': 'URL модели должен начинаться с http:// или https://',
  'settings.addModelDuplicate': 'Модель с таким URL уже добавлена в список',
  'settings.addModelButton': '+ Добавить в список',
  'settings.downloadingModel': 'Загрузка модели...',
  'settings.resumedBadge': 'докачка',
  'settings.downloadModelButton': 'Скачать выбранную модель',
  'settings.clearCache': 'Очистить кэш',
  'settings.resetModels': 'Сбросить',
  'settings.webAiTitle': 'ИИ-обработка (только Android)',
  'settings.webAiText': 'ИИ-вырезание фона выполняется нативно на устройстве (onnxruntime) и доступно только в мобильном приложении Android. Соберите APK или скачайте его из релизов. В браузере работает вырез без ИИ — по цвету фона листа.',
  'settings.exportDir': 'Директория экспорта',
  'settings.exportFolderLabel': 'Папка сохранения:',
  'settings.changeFolder': 'Изменить',
  'settings.changeFolderTitle': 'Выбрать папку сохранения ассетов (системный выбор папки)',
  'settings.exportHintBefore': 'Если папка сохранения не выбрана (путь по умолчанию), ассеты (PNG и WebP) сохраняются в указанную подпапку Android-директории',
  'settings.exportHintAfter': '.',

  // --- Модалка очистки кэша ---
  'clearCache.title': 'Очистить кэш моделей?',
  'clearCache.body1Before': 'Будут удалены',
  'clearCache.body1All': 'все',
  'clearCache.body1After': 'скачанные модели ИИ. Перед следующей обработкой их придётся скачивать заново (десятки–сотни МБ трафика).',
  'clearCache.body2Before': 'Для подтверждения введите',
  'clearCache.confirmWord': 'УДАЛИТЬ',
  'clearCache.deleteAll': 'Удалить всё',

  // --- Описания моделей ---
  'models.tag.recommended': 'Рекомендуется',
  'models.tag.quality': 'Качество',
  'models.birefnetLite.desc': 'Точная модель для вырезания объектов по отдельности. Скачивается с докачкой и проверкой контрольной суммы.',
  'models.birefnetBase.desc': 'Полный Swin-Large: берёт мелкие и бледные объекты, которые lite пропускает. В 4–6 раз медленнее и требует много памяти — для мощных телефонов (8+ ГБ ОЗУ). Докачка и проверка суммы включены.',
  'models.u2netp.desc': 'Суперлегкая модель. Мгновенно скачивается, работает быстро и потребляет минимум оперативной памяти.',
  'models.custom.desc': 'Пользовательская модель.',

  // --- Выбор объектов ---
  'selector.title': 'Выбор объектов для ИИ-вырезания',
  'selector.subtitle': 'Каждый отмеченный объект будет вырезан нейросетью отдельным кропом — это заметно повышает качество краёв.',
  'selector.cancelTitle': 'Отмена — загрузить другое изображение',
  'selector.mode.auto': 'Авто',
  'selector.mode.manual': 'Вручную',
  'selector.mode.snap': 'Прилипание',
  'selector.mode.smart': 'Умное',
  'selector.hint.auto': 'Объекты найдены автоматически. Удалите лишние рамки крестиком или добавьте свои перетаскиванием.',
  'selector.hint.manual': 'Нарисуйте рамку перетаскиванием. Перемещайте её за тело, меняйте размер за углы.',
  'selector.hint.snap': 'Нарисуйте грубую рамку вокруг объекта — она автоматически прилипнет к его границам.',
  'selector.hint.smart': 'Коснитесь объекта — он выделится точно по контуру. Повторное касание снимает выделение, касание фона ничего не делает.',
  'selector.redetect': 'Найти объекты снова',
  'selector.clearAll': 'Очистить всё',
  'selector.boxCount': 'Рамок:',
  'selector.smartVariantLabel': 'Выделять:',
  'selector.smartVariant.contour': 'По контуру',
  'selector.smartVariant.rect': 'Рамкой',
  'selector.loadingImage': 'Загрузка изображения...',
  'selector.sheetAlt': 'Лист с объектами',
  'selector.deleteBoxTitle': 'Удалить рамку',
  'selector.detecting': 'Поиск объектов...',
  'selector.excludeNested': 'Исключать вложенные рамки',
  'selector.excludeNestedDesc': 'Объекты, попавшие внутрь другой рамки, будут вырезаны из её результата по контуру.',
  'selector.excludeNestedTitle': 'Исключать вложенные рамки из результата родительской',
  'selector.process': 'Обработать ({n})',
  'selector.wholeSheet': 'Весь лист (без нарезки)',

  // --- Галерея ---
  'gallery.title': 'Галерея готовых ассетов',
  'gallery.subtitle': 'Каждый объект вырезан нейросетью отдельно и обрезан по границам непрозрачных пикселей. Готово: {done} из {total}',
  'gallery.subtitleErrors': ', с ошибкой: {n}',
  'gallery.backToSelector': 'К выбору объектов',
  'gallery.backTitle': 'Вернуться к выбору объектов (рамки сохранятся)',
  'gallery.downloadAll': 'Скачать все ({n})',
  'gallery.downloadFormat': 'Формат скачивания',
  'gallery.empty': 'Нет обработанных объектов. Вернитесь к выбору объектов и отметьте рамки.',
  'gallery.processingError': 'Ошибка обработки',
  'gallery.queued': 'В очереди',
  'gallery.labelTitle': 'Название ассета (имя файла при скачивании)',
  'gallery.boxSize': 'рамка {w} × {h} px',
  'gallery.edit': 'Редактировать',
  'gallery.editTitle': 'Открыть ассет в редакторе (ластик, восстановление, кроп, формат)',
  'gallery.retry': 'Повторить',
  'gallery.folderUnavailable': 'Папка сохранения недоступна. Выберите папку заново.',
  'gallery.downloadError': 'Ошибка при скачивании файла: {error}',
  'gallery.downloadAllError': 'Ошибка при скачивании файлов: {error}',
  'gallery.savedToPicked': 'Сохранено файлов: {n} (в выбранную папку)',
  'gallery.savedToLegacy': 'Сохранено файлов: {n} (Documents/{folder}/)',
  'gallery.encodeError': 'Не удалось перекодировать ассет',
  'gallery.folderModal.title': 'Куда сохранять ассеты?',
  'gallery.folderModal.body': 'Выберите папку на устройстве — все скачанные ассеты будут сохраняться в неё. Изменить выбор можно в настройках.',
  'gallery.folderModal.pick': 'Выбрать папку',
  'gallery.folderModal.legacy': 'Documents/Download (по умолчанию)',

  // --- Редактор ---
  'editor.title': 'Редактор ассета',
  'editor.closeTitle': 'Закрыть редактор',
  'editor.loading': 'Загрузка ассета...',
  'editor.zoomIn': 'Приблизить',
  'editor.zoomOut': 'Отдалить',
  'editor.zoom100': 'Масштаб 100%',
  'editor.applyCrop': 'Применить кадр',
  'editor.cropHint': 'Перетащите, чтобы выделить область',
  'editor.tools': 'Инструменты',
  'editor.tool.erase': 'Ластик',
  'editor.tool.restore': 'Восст.',
  'editor.tool.restoreTitle': 'Восстановить пиксели оригинала',
  'editor.tool.pan': 'Рука',
  'editor.tool.panTitle': 'Перемещение по холсту',
  'editor.tool.crop': 'Кадр',
  'editor.tool.cropTitle': 'Кадрировать',
  'editor.tool.rotateTitle': 'Повернуть на 90° по часовой',
  'editor.tool.undo': 'Назад',
  'editor.tool.undoTitle': 'Отменить (undo)',
  'editor.tool.redo': 'Вперёд',
  'editor.tool.redoTitle': 'Повторить (redo)',
  'editor.restoreDisabledNote': '«Восстановить» отключено: после кадрирования, поворота или изменения размера соответствие пикселей оригинальному листу потеряно.',
  'editor.brushSize': 'Размер кисти',
  'editor.size': 'Размер',
  'editor.widthTitle': 'Ширина, px',
  'editor.heightTitle': 'Высота, px (пропорция залочена)',
  'editor.format': 'Формат',
  'editor.saving': 'Сохранение...',
  'editor.save': 'Сохранить',
  'editor.confirmExit': 'Выйти без сохранения?',

  // --- Скачивание (downloadHelper) ---
  'download.noFolder': 'Папка сохранения не выбрана',
  'download.savedTo': 'Файл успешно сохранен: {path}',
  'download.saveError': 'Ошибка при сохранении файла: {error}',
  'download.savedToDocuments': 'Файл успешно сохранен в Documents/{folder}/{file}',
  'download.savedToRoot': 'Файл сохранен в корне Documents: {file}',
} as const;

export type I18nKey = keyof typeof RU;

const EN: Record<I18nKey, string> = {
  // --- Common ---
  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.reset': 'Reset',
  'common.quality': 'Quality',
  'common.download': 'Download',
  'common.processing': 'Processing…',
  'units.mb': 'MB',
  'units.kb': 'KB',

  // --- Header / footer ---
  'header.title': 'Asset Slicer',
  'header.subtitle': 'AI ASSET CUTTER',
  'header.settingsTitle': 'AI & download settings',
  'header.langTitle': 'Interface language: RU / EN',
  'footer.tagline': 'Asset Slicer — AI-powered object cutting from any image, right on your phone.',

  // --- Intro ---
  'intro.badge': 'Optimized for mobile phones',
  'intro.title': 'Cut assets out of any sheet in seconds',
  'intro.subtitle': 'Upload a sheet of icons, logos or artwork — the AI cuts out every object separately, with a transparent background and tidy trimming.',
  'intro.step1.title': 'Upload a sheet',
  'intro.step1.text': 'Take a photo or pick an image with objects from your gallery.',
  'intro.step2.title': 'Select objects',
  'intro.step2.text': 'Auto-detection, manual boxes or smart selection — whatever suits you.',
  'intro.step3.title': 'Download the result',
  'intro.step3.text': 'The AI cuts each object out separately — download PNG or WebP.',

  // --- Uploader ---
  'uploader.title': 'Upload an asset sheet',
  'uploader.dropHint': 'Drop a file here or tap to pick from your gallery',
  'uploader.chooseFile': 'Choose file',
  'uploader.takePhoto': 'Take a photo',
  'uploader.aiToggle': 'Auto background removal with AI',
  'uploader.aiToggleDesc': 'The neural net removes the background automatically as you upload.',
  'uploader.aiModel': 'AI model',
  'uploader.allSettings': 'All settings',
  'uploader.cached': '✓ downloaded',
  'uploader.notCached': 'not downloaded',
  'uploader.demoLabel': 'Quick test without your own files',
  'uploader.demoIcons': 'Icon sheet (white background)',
  'uploader.demoLogos': 'Logo sheet (light background)',

  // --- Progress / processing ---
  'progress.init': 'Initializing…',
  'progress.preparing': 'Preparing…',
  'progress.modelDownloadStart': 'Downloading AI model…',
  'progress.modelDownloadMb': 'Downloading model… {loaded} / {total} MB',
  'progress.modelDownloadMbNoTotal': 'Downloading model… {loaded} MB',
  'progress.resumedSuffix': ' (resumed)',
  'progress.objectOfN': 'Object {i} of {n}',
  'progress.excludingNested': 'Excluding nested objects…',
  'progress.retrying': 'Reprocessing: {label}',
  'processing.downloadHint': 'The AI model is downloading to your device. An interrupted download resumes where it left off.',
  'processing.offlineHint': 'A local neural net removes the background right on your device, offline. Your images never leave it.',
  'processing.cancel': 'Cancel',
  'processing.cancelTitle': 'Stop processing and go back',

  // --- Assets / pipeline ---
  'asset.objectN': 'Object {n}',
  'asset.wholeSheet': 'Whole sheet',
  'app.webAiUnsupported': 'AI processing works in the Android app. Build the APK or grab it from the releases.',
  'app.lowMemWarning': 'This device has {gb} GB of RAM. The Quality model (467 MB) needs 6+ GB and may crash. Continue?',
  'app.aiReadError': 'Could not read the AI result (HTTP {status})',
  'app.aiEmptyResult': 'The AI returned an empty result',
  'app.colorEmptyResult': 'No object found by background color',
  'app.noteColorFallback': 'AI missed the object — cut out by background color',
  'app.modelNotLoaded': 'The AI model is not downloaded. Open settings and download it first.',
  'app.processObjectsFailed': 'Object processing failed: {error}',
  'app.processSheetFailed': 'Sheet processing failed: {error}',
  'app.modelDownloadDone': 'AI model downloaded and cached!',
  'app.modelDownloadError': 'Model download failed: {error}',
  'app.cacheCleared': 'Cache cleared. Model files removed: {count}',
  'app.cacheClearError': 'Failed to clear cache: {error}',
  'app.pickedFolder': 'Selected folder',

  // --- Settings ---
  'settings.title': 'AI & Export Settings',
  'settings.subtitle': 'Configuration for Android and Web',
  'settings.language': 'Interface language',
  'settings.nativeModel': 'On-device AI model (Android)',
  'settings.savedModels': 'Saved local models:',
  'settings.totalCount': 'Total: {n}',
  'settings.deleteModelTitle': 'Remove model from the list',
  'settings.modelReady': 'Ready to use',
  'settings.modelNeedsDownload': 'Download required',
  'settings.modelActive': 'Active',
  'settings.addModelLabel': 'Add your own ONNX model:',
  'settings.modelNamePlaceholder': 'Name (e.g. BiRefNet-General)',
  'settings.modelUrlPlaceholder': 'Direct URL to the .onnx file',
  'settings.addModelValidation': 'Please enter a model name and URL',
  'settings.addModelUrlInvalid': 'The model URL must start with http:// or https://',
  'settings.addModelDuplicate': 'A model with this URL is already in the list',
  'settings.addModelButton': '+ Add to list',
  'settings.downloadingModel': 'Downloading model…',
  'settings.resumedBadge': 'resumed',
  'settings.downloadModelButton': 'Download selected model',
  'settings.clearCache': 'Clear cache',
  'settings.resetModels': 'Reset',
  'settings.webAiTitle': 'AI processing (Android only)',
  'settings.webAiText': 'AI background removal runs natively on-device (onnxruntime) and is only available in the Android app. Build the APK or grab it from the releases. In the browser you can still cut without AI — by sheet background color.',
  'settings.exportDir': 'Export directory',
  'settings.exportFolderLabel': 'Save folder:',
  'settings.changeFolder': 'Change',
  'settings.changeFolderTitle': 'Pick the asset save folder (system folder picker)',
  'settings.exportHintBefore': 'If no save folder is picked (default path), assets (PNG and WebP) are saved to the given subfolder of the Android',
  'settings.exportHintAfter': ' directory.',

  // --- Clear cache modal ---
  'clearCache.title': 'Clear model cache?',
  'clearCache.body1Before': 'This removes',
  'clearCache.body1All': 'all',
  'clearCache.body1After': 'downloaded AI models. They will have to be downloaded again before the next run (tens to hundreds of MB of traffic).',
  'clearCache.body2Before': 'To confirm, type',
  'clearCache.confirmWord': 'DELETE',
  'clearCache.deleteAll': 'Delete all',

  // --- Model descriptions ---
  'models.tag.recommended': 'Recommended',
  'models.tag.quality': 'Quality',
  'models.birefnetLite.desc': 'Accurate model for cutting objects out one by one. Downloads with resume support and checksum verification.',
  'models.birefnetBase.desc': 'Full Swin-Large: catches the small, pale objects that lite misses. 4–6× slower and memory-hungry — for powerful phones (8+ GB RAM). Resume and checksum verification included.',
  'models.u2netp.desc': 'Super-lightweight model. Downloads instantly, runs fast and uses minimal RAM.',
  'models.custom.desc': 'Custom model.',

  // --- Object selector ---
  'selector.title': 'Select objects for AI cutting',
  'selector.subtitle': 'Each marked object is cut out by the neural net as its own crop — edge quality gets noticeably better.',
  'selector.cancelTitle': 'Cancel — upload a different image',
  'selector.mode.auto': 'Auto',
  'selector.mode.manual': 'Manual',
  'selector.mode.snap': 'Snap',
  'selector.mode.smart': 'Smart',
  'selector.hint.auto': 'Objects were detected automatically. Remove extra boxes with the cross, or drag to add your own.',
  'selector.hint.manual': 'Drag to draw a box. Move it by its body, resize by the corners.',
  'selector.hint.snap': 'Draw a rough box around an object — it snaps to the object bounds automatically.',
  'selector.hint.smart': 'Tap an object to select it precisely along its outline. Tap again to deselect; tapping the background does nothing.',
  'selector.redetect': 'Detect objects again',
  'selector.clearAll': 'Clear all',
  'selector.boxCount': 'Boxes:',
  'selector.smartVariantLabel': 'Select:',
  'selector.smartVariant.contour': 'By outline',
  'selector.smartVariant.rect': 'As a box',
  'selector.loadingImage': 'Loading image…',
  'selector.sheetAlt': 'Sheet with objects',
  'selector.deleteBoxTitle': 'Delete box',
  'selector.detecting': 'Finding objects…',
  'selector.excludeNested': 'Exclude nested boxes',
  'selector.excludeNestedDesc': 'Objects that fall inside another box are cut out of its result along their outline.',
  'selector.excludeNestedTitle': 'Exclude nested boxes from the parent result',
  'selector.process': 'Process ({n})',
  'selector.wholeSheet': 'Whole sheet (no slicing)',

  // --- Gallery ---
  'gallery.title': 'Finished asset gallery',
  'gallery.subtitle': 'Each object is cut out by the neural net separately and trimmed to its opaque pixels. Done: {done} of {total}',
  'gallery.subtitleErrors': ', failed: {n}',
  'gallery.backToSelector': 'Back to selection',
  'gallery.backTitle': 'Return to object selection (your boxes are kept)',
  'gallery.downloadAll': 'Download all ({n})',
  'gallery.downloadFormat': 'Download format',
  'gallery.empty': 'No processed objects yet. Go back to selection and mark some boxes.',
  'gallery.processingError': 'Processing error',
  'gallery.queued': 'Queued',
  'gallery.labelTitle': 'Asset name (file name on download)',
  'gallery.boxSize': 'box {w} × {h} px',
  'gallery.edit': 'Edit',
  'gallery.editTitle': 'Open in the editor (eraser, restore, crop, format)',
  'gallery.retry': 'Retry',
  'gallery.folderUnavailable': 'The save folder is unavailable. Please pick a folder again.',
  'gallery.downloadError': 'File download failed: {error}',
  'gallery.downloadAllError': 'Files download failed: {error}',
  'gallery.savedToPicked': 'Files saved: {n} (to the selected folder)',
  'gallery.savedToLegacy': 'Files saved: {n} (Documents/{folder}/)',
  'gallery.encodeError': 'Failed to re-encode the asset',
  'gallery.folderModal.title': 'Where should assets be saved?',
  'gallery.folderModal.body': 'Pick a folder on your device — every downloaded asset goes there. You can change this later in settings.',
  'gallery.folderModal.pick': 'Pick a folder',
  'gallery.folderModal.legacy': 'Documents/Download (default)',

  // --- Editor ---
  'editor.title': 'Asset editor',
  'editor.closeTitle': 'Close editor',
  'editor.loading': 'Loading asset…',
  'editor.zoomIn': 'Zoom in',
  'editor.zoomOut': 'Zoom out',
  'editor.zoom100': 'Zoom to 100%',
  'editor.applyCrop': 'Apply crop',
  'editor.cropHint': 'Drag to select an area',
  'editor.tools': 'Tools',
  'editor.tool.erase': 'Eraser',
  'editor.tool.restore': 'Restore',
  'editor.tool.restoreTitle': 'Restore original pixels',
  'editor.tool.pan': 'Pan',
  'editor.tool.panTitle': 'Move around the canvas',
  'editor.tool.crop': 'Crop',
  'editor.tool.cropTitle': 'Crop the asset',
  'editor.tool.rotateTitle': 'Rotate 90° clockwise',
  'editor.tool.undo': 'Undo',
  'editor.tool.undoTitle': 'Undo',
  'editor.tool.redo': 'Redo',
  'editor.tool.redoTitle': 'Redo',
  'editor.restoreDisabledNote': 'Restore is disabled: after cropping, rotating or resizing, the pixels no longer match the original sheet.',
  'editor.brushSize': 'Brush size',
  'editor.size': 'Size',
  'editor.widthTitle': 'Width, px',
  'editor.heightTitle': 'Height, px (aspect ratio locked)',
  'editor.format': 'Format',
  'editor.saving': 'Saving…',
  'editor.save': 'Save',
  'editor.confirmExit': 'Leave without saving?',

  // --- Downloads (downloadHelper) ---
  'download.noFolder': 'No save folder selected',
  'download.savedTo': 'File saved: {path}',
  'download.saveError': 'Failed to save file: {error}',
  'download.savedToDocuments': 'File saved to Documents/{folder}/{file}',
  'download.savedToRoot': 'File saved to Documents root: {file}',
};

const DICTS: Record<Lang, Record<I18nKey, string>> = { ru: RU, en: EN };

const LANG_STORAGE_KEY = 'appLang';

const detectLang = (): Lang => {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch (e) {
    /* localStorage может быть недоступен — падаем на язык системы */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
};

/** Текущий язык для не-компонентного кода; синхронизируется с контекстом. */
let currentLang: Lang = detectLang();

const format = (template: string, vars?: Vars): string =>
  vars
    ? template.replace(/\{(\w+)\}/g, (m, name) =>
        name in vars ? String(vars[name]) : m,
      )
    : template;

/**
 * Standalone-перевод для кода вне React (downloadHelper, module-level хелперы,
 * колбэки конвейера): читает язык из module-level переменной.
 */
export function tGlobal(key: I18nKey, vars?: Vars): string {
  const dict = DICTS[currentLang];
  return format(dict[key] ?? EN[key] ?? key, vars);
}

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey, vars?: Vars) => string;
}

const LangContext = createContext<LangContextValue>({
  lang: currentLang,
  setLang: () => {},
  t: (key, vars) => tGlobal(key, vars),
});

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);

  const setLang = useCallback((next: Lang) => {
    currentLang = next; // синхронизация tGlobal с контекстом
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch (e) {
      /* ignore */
    }
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: I18nKey, vars?: Vars): string => {
      const dict = DICTS[lang];
      return format(dict[key] ?? EN[key] ?? key, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return React.createElement(LangContext.Provider, { value }, children);
}

/** Хук доступа к переводам: const { t, lang, setLang } = useT(); */
export function useT(): LangContextValue {
  return useContext(LangContext);
}
