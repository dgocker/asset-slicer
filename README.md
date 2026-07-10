# Asset Slicer — AI Asset Cutter

🇬🇧 English | [🇷🇺 Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE) [![Platform](https://img.shields.io/badge/Platform-Android-3DDC84)](https://github.com/dgocker/asset-slicer/releases) [![Build APK](https://github.com/dgocker/asset-slicer/actions/workflows/build-apk.yml/badge.svg)](https://github.com/dgocker/asset-slicer/actions/workflows/build-apk.yml)

**📱 [Download APK (latest release)](https://github.com/dgocker/asset-slicer/releases/latest/download/asset-slicer.apk)**

Cut game assets out of sprite sheets, icon packs and photos — entirely on your phone,
offline. Select objects on a sheet, and an on-device neural network extracts each one
as a separate transparent-background image. No servers, no uploads.

Built with React + TypeScript + Vite and Capacitor (Android). Inference runs natively
via ONNX Runtime.

## Screenshots

| Model picker | Object selection | Asset gallery |
|---|---|---|
| ![Main screen](docs/screenshots/main.jpg) | ![Object selection](docs/screenshots/selector.jpg) | ![Gallery](docs/screenshots/gallery.jpg) |

## Features

- **Object selection on the sheet** — automatic detection, manual boxes, edge
  snapping, and smart contour-based selection inside a frame.
- **Per-object AI cutout** — each selection is cropped and segmented individually
  (BiRefNet on ONNX Runtime), fully on-device; images never leave the phone.
- **Fallback cascade** — if a small crop confuses the model, the app retries with
  expanded context, then with a region-level pass, and finally falls back to
  background-color keying, so a selection rarely comes back empty.
- **Gallery with a built-in editor** — eraser and restore brushes, crop, rotate,
  resize with aspect-ratio lock, and PNG/WebP export with a live file-size preview.
- **Resumable model downloads** — models are fetched on first use with HTTP Range
  resume and SHA-256 verification, then cached on the device.
- **Nested-object exclusion** — an object fully contained in another (a gem on a
  crown) can be subtracted from the parent asset automatically.

## Models

| Preset | Size | License | Notes |
| --- | --- | --- | --- |
| BiRefNet-lite fp16 (default) | 109 MB | MIT | Fast, good general quality |
| BiRefNet base fp16 ("Quality") | 467 MB | MIT | Swin-Large; catches small/faint objects, needs 8+ GB RAM phones |
| U2Netp | 4.4 MB | Apache-2.0 | Tiny and fast, lower quality |

Both BiRefNet presets are fp16 conversions of the MIT-licensed weights with fp32
inputs/outputs kept. Interface: input tensor `input_image`, 1024×1024, ImageNet
normalization; output is logits, passed through sigmoid. You can also add any custom
ONNX model by URL from the settings screen.

**Model hosting:** presets download from this repository's [GitHub Releases](https://github.com/dgocker/asset-slicer/releases). If you fork, attach the models to your own release and update the URLs in `src/App.tsx`. The
models can be produced from the [onnx-community/BiRefNet-ONNX](https://huggingface.co/onnx-community/BiRefNet-ONNX)
/ [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)
exports with `onnxconverter_common.float16.convert_float_to_float16(keep_io_types=True)`.
Your server must support HTTP Range requests, or interrupted downloads will not resume.

## Build

Requirements: Node.js 20+, JDK 21, Android SDK.

```bash
npm install
npx vite build
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK ends up in `android/app/build/outputs/apk/debug/`. The web build is UI-only:
AI processing is implemented in the native Android plugin, so in a browser only the
non-AI background-color cutout works.

## Project structure

```
src/
  App.tsx                 # main flow: selection → processing → gallery
  components/
    ObjectSelector.tsx    # object selection on the sheet
    AssetGallery.tsx      # gallery of extracted assets
    AssetEditor.tsx       # per-asset editor (erase/restore, crop, export)
  plugins/
    backgroundRemoval.ts  # Capacitor bridge to the native plugin
android/
  .../BackgroundRemovalPlugin.kt  # ONNX Runtime inference (CPU EP), resumable
                                  # model download, raw-mask mode
```

## Security note

The repository contains a `debug.keystore` so that debug builds installed from
releases can be updated in place. It is a well-known debug key — for any production
distribution, generate your own signing key and do not commit it.

## License

MIT — see [LICENSE](LICENSE). Third-party components and model licenses are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
