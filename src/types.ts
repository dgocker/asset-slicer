/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Slice {
  id: string;
  rect: Rect;
  label: string;
}

export interface ColorRGB {
  r: number;
  g: number;
  b: number;
}

export type SVGMode = 'silhouette' | 'color' | 'embedded';

export interface ProcessedAsset {
  id: string;
  name: string;
  rect: Rect;
  pngDataUrl: string;
  rasterDataUrl?: string;
  rasterFormat?: 'webp' | 'png';
  width: number;
  height: number;
  svgMode: SVGMode;
  svgCode: string;
  silhouetteSvg: string;
  colorSvg: string;
  embeddedSvg: string;
  dominantColor: string;
  tags: string[];
}

export interface AppState {
  originalImage: string | null; // DataURL of uploaded image
  imageWidth: number;
  imageHeight: number;
  transparentColor: ColorRGB | null;
  tolerance: number;
  mergeDistance: number;
  minSize: number;
  padding: number;
  slices: Slice[];
  selectedSliceId: string | null;
  processedAssets: ProcessedAsset[];
  isProcessing: boolean;
  brushMode: 'none' | 'erase' | 'restore';
  brushSize: number;
}
