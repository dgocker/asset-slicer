/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import {
  Wand2,
  Eraser,
  Undo,
  RefreshCw,
  SlidersHorizontal,
  Plus,
  Trash2,
  Check,
  Move,
  Grid,
  Sparkles,
  Minus,
  ShieldCheck,
  Search,
  Save,
  X,
} from "lucide-react";
import { Rect, Slice, ColorRGB } from "../types";
import {
  detectBackgroundColor,
  detectSlices,
  getColorDistance,
  findConnectedComponentAt,
  trimTransparentMargins,
} from "../utils/imageProcess";
import { yieldToMain } from "../utils/taskQueue";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

interface WorkspaceProps {
  imageSrc: string;
  aiImageSrc?: string | null;
  onSlicesUpdated: (
    slices: Slice[],
    processedImageData: ImageData,
    originalImageData?: ImageData,
    keyColor?: ColorRGB,
  ) => void;
  onReset: () => void;
}

export default function Workspace({
  imageSrc,
  aiImageSrc,
  onSlicesUpdated,
  onReset,
}: WorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Image element ref
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  // Background and chroma key states
  const [transparentColor, setTransparentColor] = useState<ColorRGB | null>(
    null,
  );
  const [tolerance, setTolerance] = useState<number>(35);
  const [edgeSoftness, setEdgeSoftness] = useState<number>(10);
  const [contiguousMode, setContiguousMode] = useState<boolean>(true);
  const [lastPickedCoords, setLastPickedCoords] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [manualSeeds, setManualSeeds] = useState<{ x: number; y: number }[]>(
    [],
  );

  // Slicing parameters
  const [mergeDistance, setMergeDistance] = useState<number>(15);
  const [minSize, setMinSize] = useState<number>(12);
  const [padding, setPadding] = useState<number>(4);

  // Debounced values to avoid freezing during fast dragging/sliding
  const debouncedTolerance = useDebounce(tolerance, 130);
  const debouncedEdgeSoftness = useDebounce(edgeSoftness, 130);
  const debouncedMergeDistance = useDebounce(mergeDistance, 130);
  const debouncedMinSize = useDebounce(minSize, 130);
  const debouncedPadding = useDebounce(padding, 130);

  // Brush settings
  const [brushMode, setBrushMode] = useState<"none" | "erase" | "restore">(
    "none",
  );
  const [brushSize, setBrushSize] = useState<number>(30);

  // Slices state
  const [slices, setSlices] = useState<Slice[]>([]);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null);

  // Pixel data buffers
  const originalImageDataRef = useRef<ImageData | null>(null);
  const aiImageDataRef = useRef<ImageData | null>(null);
  const brushMaskRef = useRef<Uint8Array | null>(null); // 0 = erased, 1 = restored, 255 = default (chroma key)
  const processedImageDataRef = useRef<ImageData | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);

  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [drawRect, setDrawRect] = useState<Rect | null>(null);

  // Active workspace mode: 'chroma' (color picking), 'brush' (erasing), 'slice' (drawing custom slice box), 'smart' (smart click selection)
  const [workspaceMode, setWorkspaceMode] = useState<
    "chroma" | "brush" | "slice" | "smart"
  >("chroma");
  const [snapToEdges, setSnapToEdges] = useState(true);

  // Active step in the sidebar workflow: 'bg' (background cleanup), 'slice' (slicing), 'objects' (objects list)
  const [activeStep, setActiveStep] = useState<"bg" | "slice" | "objects">("bg");
  const [bgSubMode, setBgSubMode] = useState<"chroma" | "brush">("chroma");
  const [sliceSubMode, setSliceSubMode] = useState<"manual" | "smart">("manual");

  // Automatically switch workspace modes when activeStep or sub-modes change
  useEffect(() => {
    if (activeStep === "bg") {
      if (bgSubMode === "chroma") {
        setWorkspaceMode("chroma");
        setBrushMode("none");
      } else {
        setWorkspaceMode("brush");
        if (brushMode === "none") {
          setBrushMode("erase");
        }
      }
    } else if (activeStep === "slice") {
      if (sliceSubMode === "manual") {
        setWorkspaceMode("slice");
        setBrushMode("none");
      } else if (sliceSubMode === "smart") {
        setWorkspaceMode("smart");
        setBrushMode("none");
      }
    } else if (activeStep === "objects") {
      setWorkspaceMode("slice"); // Neutral mode for selecting slices
      setBrushMode("none");
    }
  }, [activeStep, bgSubMode, sliceSubMode]);

  // Zoom and Pan states
  const [zoom, setZoom] = useState<number>(1);
  const [autoDetectEnabled, setAutoDetectEnabled] = useState<boolean>(false);
  const [isPanActive, setIsPanActive] = useState<boolean>(false);

  // Refs for navigation and layout measuring
  const baseWidthRef = useRef<number>(400);
  const baseHeightRef = useRef<number>(300);
  const allTimeAutoSlicesRef = useRef<Slice[]>([]);
  const panStartRef = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);

  // Touch zoom state refs
  const initialPinchDistanceRef = useRef<number | null>(null);
  const initialPinchZoomRef = useRef<number>(1);

  // Caching client rects to prevent high-frequency layout reflows/lag
  const canvasRectRef = useRef<DOMRect | null>(null);
  const panelRectRef = useRef<DOMRect | null>(null);

  const updateCachedRects = () => {
    if (canvasRef.current) {
      canvasRectRef.current = canvasRef.current.getBoundingClientRect();
    }
    if (panelRef.current) {
      panelRectRef.current = panelRef.current.getBoundingClientRect();
    }
  };

  // Invalidate cached rects on zoom or workspaceMode change
  useEffect(() => {
    canvasRectRef.current = null;
    panelRectRef.current = null;
  }, [zoom, workspaceMode]);

  // Invalidate cached rects and calculate dimensions on window resize
  useEffect(() => {
    const handleResize = () => {
      canvasRectRef.current = null;
      panelRectRef.current = null;

      const canvas = canvasRef.current;
      const parent = containerRef.current;
      if (canvas && parent) {
        const imgW = canvas.width;
        const imgH = canvas.height;
        if (imgW > 0 && imgH > 0) {
          const targetW = parent.clientWidth - 32;
          const targetH = 480;
          const scale = Math.min(targetW / imgW, targetH / imgH);
          baseWidthRef.current = imgW * scale;
          baseHeightRef.current = imgH * scale;
        }
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Invalidate cached rects on container scroll or wheel
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScrollOrWheel = () => {
      canvasRectRef.current = null;
      panelRectRef.current = null;
    };
    container.addEventListener("scroll", handleScrollOrWheel, { passive: true });
    container.addEventListener("wheel", handleScrollOrWheel, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScrollOrWheel);
      container.removeEventListener("wheel", handleScrollOrWheel);
    };
  }, [containerRef.current]);

  // Magnifier button press timer and hold-state refs
  const buttonPressTimerRef = useRef<number | null>(null);
  const pressStartTimeRef = useRef<number>(0);
  const hasTriggeredHoldRef = useRef<boolean>(false);

  const handleMagnifierButtonPressStart = (
    e: React.MouseEvent | React.TouchEvent,
  ) => {
    if (e.cancelable) {
      e.preventDefault();
    }
    pressStartTimeRef.current = Date.now();
    hasTriggeredHoldRef.current = false;

    // Refresh cached rects so they are accurate
    updateCachedRects();

    if (buttonPressTimerRef.current) {
      window.clearTimeout(buttonPressTimerRef.current);
    }

    buttonPressTimerRef.current = window.setTimeout(() => {
      setIsMagnifierActive(true); // Always force-activate on hold
      hasTriggeredHoldRef.current = true;
    }, 250); // 250ms threshold for hold/long-press
  };

  const handleMagnifierButtonPressEnd = (
    e: React.MouseEvent | React.TouchEvent,
  ) => {
    if (e.cancelable) {
      e.preventDefault();
    }
    if (buttonPressTimerRef.current) {
      window.clearTimeout(buttonPressTimerRef.current);
      buttonPressTimerRef.current = null;
    }

    const duration = Date.now() - pressStartTimeRef.current;
    if (duration < 250 && !hasTriggeredHoldRef.current) {
      // Short press: cycle magnifier zoom level
      const levels = [4, 6, 8, 10, 12];
      const currentIndex = levels.indexOf(magnifierZoom);
      const nextIndex = (currentIndex + 1) % levels.length;
      setMagnifierZoom(levels[nextIndex]);
    }
  };

  const handleMagnifierButtonPressCancel = () => {
    if (buttonPressTimerRef.current) {
      window.clearTimeout(buttonPressTimerRef.current);
      buttonPressTimerRef.current = null;
    }
  };

  // Magnifier coordinates, zoom state, and DOM refs
  const magnifierCoordsRef = useRef<{
    screenX: number;
    screenY: number;
    x: number;
    y: number;
  } | null>(null);
  const magnifierContainerRef = useRef<HTMLDivElement>(null);
  const [magnifierZoom, setMagnifierZoom] = useState<number>(6);
  const [isMagnifierActive, setIsMagnifierActive] = useState<boolean>(false);
  const historyRef = useRef<
    Array<{
      slices: Slice[];
      manualSeeds: Array<{ x: number; y: number }>;
      transparentColor: ColorRGB | null;
      brushMask: Uint8Array | null;
    }>
  >([]);
  const [historyCount, setHistoryCount] = useState(0);

  const magnifierBackupRef = useRef<{
    slices: Slice[];
    manualSeeds: Array<{ x: number; y: number }>;
    transparentColor: ColorRGB | null;
    brushMask: Uint8Array | null;
  } | null>(null);
  const activeCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const lastTouchTimeRef = useRef<number>(0);

  // Track latest state to avoid stale closures in effects
  const latestStateRef = useRef({
    slices,
    manualSeeds,
    transparentColor,
    brushMask: brushMaskRef.current,
  });
  useEffect(() => {
    latestStateRef.current = {
      slices,
      manualSeeds,
      transparentColor,
      brushMask: brushMaskRef.current,
    };
  }, [slices, manualSeeds, transparentColor, brushMaskRef.current]);

  const pushToHistory = () => {
    const maskCopy = brushMaskRef.current ? new Uint8Array(brushMaskRef.current) : null;
    historyRef.current.push({
      slices: [...slices],
      manualSeeds: [...manualSeeds],
      transparentColor: transparentColor ? { ...transparentColor } : null,
      brushMask: maskCopy,
    });

    let maxStates = 25;
    if (brushMaskRef.current) {
      const pixelCount = brushMaskRef.current.length;
      if (pixelCount > 4000000) {
        maxStates = 5;
      } else if (pixelCount > 1000000) {
        maxStates = 12;
      }
    }

    while (historyRef.current.length > maxStates) {
      historyRef.current.shift();
    }
    setHistoryCount(historyRef.current.length);
  };

  const handleUndo = () => {
    if (historyRef.current.length === 0) return;
    const prevState = historyRef.current.pop();
    setHistoryCount(historyRef.current.length);
    if (prevState) {
      setSlices(prevState.slices);
      setManualSeeds(prevState.manualSeeds);
      setTransparentColor(prevState.transparentColor);
      if (prevState.brushMask) {
        brushMaskRef.current = new Uint8Array(prevState.brushMask);
      } else {
        brushMaskRef.current = null;
      }
      setDataVersion(v => v + 1);
    }
  };

  const drawMagnifierRafRef = useRef<number | null>(null);

  /**
   * Directly positions and draws the magnifying glass on the canvas context without React state updates.
   */
  const drawMagnifier = (
    screenX: number,
    screenY: number,
    x: number,
    y: number,
  ) => {
    magnifierCoordsRef.current = { screenX, screenY, x, y };

    if (drawMagnifierRafRef.current !== null) {
      return; // Already queued for next frame
    }

    drawMagnifierRafRef.current = requestAnimationFrame(() => {
      drawMagnifierRafRef.current = null;
      const latestCoords = magnifierCoordsRef.current;
      if (!latestCoords) return;

      const {
        screenX: curScreenX,
        screenY: curScreenY,
        x: curX,
        y: curY,
      } = latestCoords;

      if (magnifierContainerRef.current) {
        const panelWidth =
          panelRectRef.current?.width || panelRef.current?.clientWidth || 500;
        const left = Math.max(15, Math.min(panelWidth - 155, curScreenX - 70));
        const top = curScreenY - 140 < 15 ? curScreenY + 45 : curScreenY - 140;
        magnifierContainerRef.current.style.transform = `translate3d(${left}px, ${top}px, 0)`;
        magnifierContainerRef.current.style.left = "0px";
        magnifierContainerRef.current.style.top = "0px";
      }

      const canvas = magnifierCanvasRef.current;
      if (canvas && canvasRef.current) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, 140, 140);

          const srcWidth = 140 / magnifierZoom;
          const srcHeight = 140 / magnifierZoom;
          const srcX = curX - srcWidth / 2;
          const srcY = curY - srcHeight / 2;

          // Clip to canvas bounds to prevent severe drawImage lag/hangs in some browsers
          const sX = Math.floor(Math.max(0, srcX));
          const sY = Math.floor(Math.max(0, srcY));
          const sW = Math.floor(
            Math.min(srcWidth - (sX - srcX), canvasRef.current.width - sX),
          );
          const sH = Math.floor(
            Math.min(srcHeight - (sY - srcY), canvasRef.current.height - sY),
          );

          const dX = Math.floor((sX - srcX) * magnifierZoom);
          const dY = Math.floor((sY - srcY) * magnifierZoom);
          const dW = Math.floor(sW * magnifierZoom);
          const dH = Math.floor(sH * magnifierZoom);

          if (sW > 0 && sH > 0) {
            ctx.drawImage(canvasRef.current, sX, sY, sW, sH, dX, dY, dW, dH);
          }
        }
      }
    });
  };

  // Manage magnifier backup and coordinate initialization
  useEffect(() => {
    if (isMagnifierActive) {
      const {
        slices: latestSlices,
        manualSeeds: latestSeeds,
        transparentColor: latestColor,
        brushMask: latestMask,
      } = latestStateRef.current;
      const maskCopy = latestMask ? new Uint8Array(latestMask) : null;
      magnifierBackupRef.current = {
        slices: [...latestSlices],
        manualSeeds: [...latestSeeds],
        transparentColor: latestColor ? { ...latestColor } : null,
        brushMask: maskCopy,
      };

      if (!magnifierCoordsRef.current && canvasRef.current) {
        const x = Math.round(canvasRef.current.width / 2);
        const y = Math.round(canvasRef.current.height / 2);
        let screenX = 250;
        let screenY = 250;

        const panelRect =
          panelRectRef.current || panelRef.current?.getBoundingClientRect();
        if (panelRect) {
          if (!panelRectRef.current) panelRectRef.current = panelRect;
          screenX = panelRect.width / 2;
          screenY = panelRect.height / 2;
        }

        magnifierCoordsRef.current = {
          screenX,
          screenY,
          x,
          y,
        };

        // Draw initially with a small delay so DOM is mounted
        setTimeout(() => {
          if (magnifierCoordsRef.current) {
            drawMagnifier(
              magnifierCoordsRef.current.screenX,
              magnifierCoordsRef.current.screenY,
              magnifierCoordsRef.current.x,
              magnifierCoordsRef.current.y,
            );
          }
        }, 16);
      }
    } else {
      magnifierBackupRef.current = null;
      magnifierCoordsRef.current = null;
    }
  }, [isMagnifierActive]);

  // Load image on mount
  useEffect(() => {
    if (!imageSrc) return;
    historyRef.current = [];
    setHistoryCount(0);
    let active = true;
    const img = new Image();
    let aiImg: HTMLImageElement | null = null;

    const setCrossOriginIfRemote = (targetImg: HTMLImageElement, srcUrl: string) => {
      if (srcUrl.startsWith("http") && !srcUrl.includes("localhost") && !srcUrl.includes("127.0.0.1")) {
        targetImg.crossOrigin = "anonymous";
      }
    };

    setCrossOriginIfRemote(img, imageSrc);
    img.onload = () => {
      if (!active) return;
      setImage(img);

      // Create offscreen canvas to extract pixels
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(
          0,
          0,
          img.naturalWidth,
          img.naturalHeight,
        );
        originalImageDataRef.current = imgData;
        setDataVersion(v => v + 1);

        // Initialize brush mask
        const mask = new Uint8Array(img.naturalWidth * img.naturalHeight);
        mask.fill(255); // Fill with default
        brushMaskRef.current = mask;

        // Disable automatic chroma-keying by default
        setTransparentColor(null);
        setLastPickedCoords({ x: 0, y: 0 });
        setManualSeeds([]);

        // If AI-cleaned image is provided, load it to initialize processedImageDataRef and aiImageDataRef
        if (aiImageSrc) {
          aiImg = new Image();
          setCrossOriginIfRemote(aiImg, aiImageSrc);
          aiImg.onload = () => {
            if (!active) return;
            const aiCanvas = document.createElement("canvas");
            aiCanvas.width = aiImg!.naturalWidth;
            aiCanvas.height = aiImg!.naturalHeight;
            const aiCtx = aiCanvas.getContext("2d");
            if (aiCtx) {
              aiCtx.drawImage(aiImg!, 0, 0);
              const aiImgData = aiCtx.getImageData(
                0,
                0,
                aiImg!.naturalWidth,
                aiImg!.naturalHeight,
              );

              aiImageDataRef.current = aiImgData;
              processedImageDataRef.current = aiImgData;
              setDataVersion(v => v + 1);
            }
          };
          aiImg.onerror = () => {
            if (!active) return;
          };
          aiImg.src = aiImageSrc;
        } else {
          aiImageDataRef.current = null;
          // Otherwise, initialize processedImageDataRef with the original image
          processedImageDataRef.current = new ImageData(
            new Uint8ClampedArray(imgData.data),
            imgData.width,
            imgData.height
          );
          setDataVersion(v => v + 1);
        }
      }
    };
    img.onerror = () => {
      if (!active) return;
    };
    img.src = imageSrc;

    return () => {
      active = false;
      img.onload = null;
      img.onerror = null;
      if (aiImg) {
        aiImg.onload = null;
        aiImg.onerror = null;
      }
    };
  }, [imageSrc, aiImageSrc]);

  // Ref to track last parameters that triggered auto-detection
  const lastDetectParamsRef = useRef<{
    brushMask: Uint8Array | null;
    transparentColor: ColorRGB | null;
    tolerance: number;
    edgeSoftness: number;
    contiguousMode: boolean;
    lastPickedCoords: { x: number; y: number } | null;
    manualSeeds: { x: number; y: number }[];
    minSize: number;
    mergeDistance: number;
    padding: number;
  }>({
    brushMask: null,
    transparentColor: null,
    tolerance: -1,
    edgeSoftness: -1,
    contiguousMode: true,
    lastPickedCoords: null,
    manualSeeds: [],
    minSize: -1,
    mergeDistance: -1,
    padding: -1,
  });

  // Handle updates to transparency and slicing configurations
  useEffect(() => {
    if (!originalImageDataRef.current || !brushMaskRef.current || !image) return;

    // If AI image is specified but not yet loaded, wait for it to prevent flash/race conditions
    if (aiImageSrc && !aiImageDataRef.current) {
      return;
    }

    // Skip heavy calculations while actively drawing/brushing to prevent lag
    if (isDrawing) {
      return;
    }

    // Check if parameters actually changed to avoid re-detecting deleted auto-slices
    const prev = lastDetectParamsRef.current;
    if (
      prev.brushMask === brushMaskRef.current &&
      prev.transparentColor?.r === transparentColor?.r &&
      prev.transparentColor?.g === transparentColor?.g &&
      prev.transparentColor?.b === transparentColor?.b &&
      prev.tolerance === debouncedTolerance &&
      prev.edgeSoftness === debouncedEdgeSoftness &&
      prev.contiguousMode === contiguousMode &&
      prev.lastPickedCoords?.x === lastPickedCoords?.x &&
      prev.lastPickedCoords?.y === lastPickedCoords?.y &&
      prev.manualSeeds === manualSeeds &&
      prev.minSize === debouncedMinSize &&
      prev.mergeDistance === debouncedMergeDistance &&
      prev.padding === debouncedPadding
    ) {
      return; // Skip if no core parameters changed (e.g. only isDrawing changed)
    }

    lastDetectParamsRef.current = {
      brushMask: brushMaskRef.current,
      transparentColor,
      tolerance: debouncedTolerance,
      edgeSoftness: debouncedEdgeSoftness,
      contiguousMode,
      lastPickedCoords,
      manualSeeds,
      minSize: debouncedMinSize,
      mergeDistance: debouncedMergeDistance,
      padding: debouncedPadding,
    };

    // 1. Process image pixels with Chroma Key + Brush Mask
    const processedData = processPixels(
      originalImageDataRef.current,
      brushMaskRef.current,
      transparentColor,
      debouncedTolerance,
      debouncedEdgeSoftness,
      contiguousMode,
      lastPickedCoords,
    );
    processedImageDataRef.current = processedData;
    setDataVersion(v => v + 1);

    // 2. Detect slices automatically (only if enabled)
    if (autoDetectEnabled) {
      const rects = detectSlices(
        processedData,
        debouncedMinSize,
        debouncedMergeDistance,
        debouncedPadding,
      );

      setSlices((prevSlices) => {
        const manualSlices = prevSlices.filter(
          (s) => s.id.startsWith("custom-") || s.id.startsWith("smart-"),
        );
        const existingAutoSlices = prevSlices.filter(
          (s) => !s.id.startsWith("custom-") && !s.id.startsWith("smart-"),
        );

        const usedIds = new Set<string>();
        const candidateSlices = [...existingAutoSlices, ...allTimeAutoSlicesRef.current];
        
        const newSlices: Slice[] = rects.map((rect, idx) => {
          let bestMatch: Slice | null = null;
          let bestIoU = 0;

          for (const ext of candidateSlices) {
            if (usedIds.has(ext.id)) continue;
            // Intersection rectangle
            const x1 = Math.max(rect.x, ext.rect.x);
            const y1 = Math.max(rect.y, ext.rect.y);
            const x2 = Math.min(rect.x + rect.width, ext.rect.x + ext.rect.width);
            const y2 = Math.min(rect.y + rect.height, ext.rect.y + ext.rect.height);

            if (x2 > x1 && y2 > y1) {
              const intersection = (x2 - x1) * (y2 - y1);
              const union =
                rect.width * rect.height +
                ext.rect.width * ext.rect.height -
                intersection;
              const iou = intersection / union;
              if (iou > bestIoU) {
                bestIoU = iou;
                bestMatch = ext;
              }
            }
          }

          if (bestMatch && bestIoU > 0.01) {
            usedIds.add(bestMatch.id);
            return {
              id: bestMatch.id,
              rect,
              label: bestMatch.label,
            };
          }

          const newId = `slice-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
          return {
            id: newId,
            rect,
            label: `Объект ${idx + 1}`,
          };
        });

        // Update the all-time memory with these new slices
        const newSliceIds = new Set(newSlices.map(s => s.id));
        allTimeAutoSlicesRef.current = [
          ...newSlices,
          ...allTimeAutoSlicesRef.current.filter(s => !newSliceIds.has(s.id))
        ].slice(0, 50); // Keep last 50 in memory

        const allSlices = [...newSlices, ...manualSlices];

        // Retain selection of previously selected slice if it still exists
        setSelectedSliceId((prevId) => {
          if (prevId && allSlices.some((s) => s.id === prevId)) {
            return prevId;
          }
          return allSlices.length > 0 ? allSlices[0].id : null;
        });

        return allSlices;
      });
    } else {
      // Just keep manual/smart slices if auto detect is disabled
      setSlices((prevSlices) => {
        const filtered = prevSlices.filter(
          (s) => s.id.startsWith("custom-") || s.id.startsWith("smart-"),
        );
        if (filtered.length === prevSlices.length && filtered.every((s, i) => s.id === prevSlices[i].id)) {
          return prevSlices; // return original reference to prevent state update!
        }
        return filtered;
      });
    }
  }, [
    originalImageDataRef.current,
    brushMaskRef.current,
    transparentColor,
    debouncedTolerance,
    debouncedEdgeSoftness,
    contiguousMode,
    lastPickedCoords,
    manualSeeds,
    debouncedMergeDistance,
    debouncedMinSize,
    debouncedPadding,
    image,
    isDrawing,
    autoDetectEnabled,
    aiImageSrc,
  ]);

  // Redraw canvas locally on any visual changes (including active drawing/dragging)
  useEffect(() => {
    if (!processedImageDataRef.current) return;
    drawWorkspace(processedImageDataRef.current, slices);
  }, [
    slices,
    selectedSliceId,
    workspaceMode,
    drawRect,
    dataVersion, // Use dataVersion to trigger effect when ref changes
    manualSeeds,
    contiguousMode,
  ]);

  // Notify parent ONLY when slices, processed image data, or keyColor changes
  useEffect(() => {
    if (!processedImageDataRef.current) return;
    onSlicesUpdated(
      slices,
      processedImageDataRef.current,
      originalImageDataRef.current || undefined,
      transparentColor || undefined,
    );
  }, [slices, dataVersion, transparentColor]);

  // Redraw magnifier when zoom level, processed image data, or activation state changes
  useEffect(() => {
    if (isMagnifierActive && magnifierCoordsRef.current) {
      drawMagnifier(
        magnifierCoordsRef.current.screenX,
        magnifierCoordsRef.current.screenY,
        magnifierCoordsRef.current.x,
        magnifierCoordsRef.current.y,
      );
    }
  }, [magnifierZoom, processedImageDataRef.current, isMagnifierActive]);

  // CSS touch-action handles preventing default scrolling, so we don't need manual passive: false listeners.
  // This completely eliminates native scroll jank and main thread blocking.

  /**
   * Applies chroma-keying and brush masking to the image pixels.
   */
  const processPixels = (
    src: ImageData,
    mask: Uint8Array,
    keyColor: ColorRGB | null,
    tol: number,
    softness: number,
    contiguous: boolean,
    pickedCoords: { x: number; y: number } | null,
  ): ImageData => {
    const baseData = aiImageDataRef.current || src;
    const output = new ImageData(
      new Uint8ClampedArray(baseData.data),
      src.width,
      src.height,
    );
    const data = output.data;
    const width = src.width;
    const height = src.height;

    const isBackground = new Uint8Array(width * height);
    if (contiguous && keyColor) {
      const queue = new Int32Array(width * height);
      let qHead = 0;
      let qTail = 0;
      const propTol = tol + softness * 0.4; // Tightened propagation threshold to prevent crossing semi-transparent edge boundaries
      const propTolSqr = propTol * propTol;

      const pushPixel = (idx: number) => {
        if (isBackground[idx] === 0 && mask[idx] !== 1) {
          const pxIdx = idx * 4;
          const dr = data[pxIdx] - keyColor.r;
          const dg = data[pxIdx + 1] - keyColor.g;
          const db = data[pxIdx + 2] - keyColor.b;
          const distSqr = dr * dr + dg * dg + db * db;
          if (distSqr <= propTolSqr) {
            isBackground[idx] = 1;
            queue[qTail++] = idx;
          }
        }
      };

      // Seed all border pixels (all 4 edges) to flood fill starting only from the actual image margins
      for (let x = 0; x < width; x++) {
        pushPixel(x);
        pushPixel((height - 1) * width + x);
      }
      for (let y = 0; y < height; y++) {
        pushPixel(y * width);
        pushPixel(y * width + (width - 1));
      }

      // Seed any manual seed coordinates clicked by the user
      if (manualSeeds && manualSeeds.length > 0) {
        for (const seed of manualSeeds) {
          const px = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
          const py = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
          pushPixel(py * width + px);
        }
      }

      // BFS Flood fill to find all connected background pixels
      while (qHead < qTail) {
        const currIdx = queue[qHead++];
        const cx = currIdx % width;
        const cy = Math.floor(currIdx / width);

        // Left
        if (cx > 0) {
          const nIdx = currIdx - 1;
          if (isBackground[nIdx] === 0) {
            const nPxIdx = nIdx * 4;
            const dr = data[nPxIdx] - keyColor.r;
            const dg = data[nPxIdx + 1] - keyColor.g;
            const db = data[nPxIdx + 2] - keyColor.b;
            const distSqr = dr * dr + dg * dg + db * db;
            if (distSqr <= propTolSqr) {
              isBackground[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
        }
        // Right
        if (cx < width - 1) {
          const nIdx = currIdx + 1;
          if (isBackground[nIdx] === 0) {
            const nPxIdx = nIdx * 4;
            const dr = data[nPxIdx] - keyColor.r;
            const dg = data[nPxIdx + 1] - keyColor.g;
            const db = data[nPxIdx + 2] - keyColor.b;
            const distSqr = dr * dr + dg * dg + db * db;
            if (distSqr <= propTolSqr) {
              isBackground[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
        }
        // Top
        if (cy > 0) {
          const nIdx = currIdx - width;
          if (isBackground[nIdx] === 0) {
            const nPxIdx = nIdx * 4;
            const dr = data[nPxIdx] - keyColor.r;
            const dg = data[nPxIdx + 1] - keyColor.g;
            const db = data[nPxIdx + 2] - keyColor.b;
            const distSqr = dr * dr + dg * dg + db * db;
            if (distSqr <= propTolSqr) {
              isBackground[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
        }
        // Bottom
        if (cy < height - 1) {
          const nIdx = currIdx + width;
          if (isBackground[nIdx] === 0) {
            const nPxIdx = nIdx * 4;
            const dr = data[nPxIdx] - keyColor.r;
            const dg = data[nPxIdx + 1] - keyColor.g;
            const db = data[nPxIdx + 2] - keyColor.b;
            const distSqr = dr * dr + dg * dg + db * db;
            if (distSqr <= propTolSqr) {
              isBackground[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
        }
      }
    }

    if (keyColor) {
      const tolSqr = tol * tol;
      const maxTol = tol + softness * 2;
      const maxTolSqr = maxTol * maxTol;
      const softness2 = softness * 2;

      for (let i = 0; i < data.length; i += 4) {
        const idx = i / 4;
        const maskVal = mask[idx];

        if (maskVal === 0) {
          data[i + 3] = 0;
        } else if (maskVal === 1) {
          data[i] = src.data[i];
          data[i + 1] = src.data[i + 1];
          data[i + 2] = src.data[i + 2];
          data[i + 3] = src.data[i + 3];
        } else {
          if (contiguous && isBackground[idx] === 0) {
            continue;
          }

          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const dr = r - keyColor.r;
          const dg = g - keyColor.g;
          const db = b - keyColor.b;
          const distSqr = dr * dr + dg * dg + db * db;

          if (distSqr <= tolSqr) {
            data[i + 3] = 0;
          } else if (softness > 0 && distSqr < maxTolSqr) {
            const dist = Math.sqrt(distSqr);
            const ratio = (dist - tol) / softness2;
            data[i + 3] = Math.min(data[i + 3], Math.round(255 * ratio));
          }
        }
      }
    } else {
      for (let i = 0; i < data.length; i += 4) {
        const idx = i / 4;
        const maskVal = mask[idx];
        if (maskVal === 0) {
          data[i + 3] = 0;
        } else if (maskVal === 1) {
          data[i] = src.data[i];
          data[i + 1] = src.data[i + 1];
          data[i + 2] = src.data[i + 2];
          data[i + 3] = src.data[i + 3];
        }
      }
    }
    return output;
  };

  /**
   * Main rendering loop of the visual canvas with checkerboard background & bounding boxes.
   */
  const drawWorkspace = (imgData: ImageData, activeSlices: Slice[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas dimensions
    canvas.width = imgData.width;
    canvas.height = imgData.height;

    // 1. Clear the canvas (transparent background - CSS checkerboard handles grid)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Measure actual layout size on screen when at 1x zoom for base scaling
    if (zoom === 1) {
      const parent = containerRef.current;
      if (parent) {
        const imgW = imgData.width;
        const imgH = imgData.height;
        if (imgW > 0 && imgH > 0) {
          const targetW = parent.clientWidth - 32;
          const targetH = 480;
          const scale = Math.min(targetW / imgW, targetH / imgH);
          baseWidthRef.current = imgW * scale;
          baseHeightRef.current = imgH * scale;
        }
      }
    }

    const renderOverlays = () => {
      // 3. Draw Slices Overlays
      activeSlices.forEach((slice) => {
        const isSelected = slice.id === selectedSliceId;
        const r = slice.rect;

        // Draw bounding box border
        ctx.lineWidth = Math.max(2, Math.round(canvas.width / 300));
        if (isSelected) {
          ctx.strokeStyle = "#3b82f6"; // Bright blue for selected
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = "#ef4444"; // Red dash for unselected
          ctx.setLineDash([6, 4]);
        }
        ctx.strokeRect(r.x, r.y, r.width, r.height);

        // Label background
        if (isSelected) {
          ctx.fillStyle = "#3b82f6";
        } else {
          ctx.fillStyle = "#ef4444";
        }
        const labelPadding = 6;
        ctx.font = `bold ${Math.max(12, Math.round(canvas.width / 50))}px sans-serif`;
        const labelText = slice.label;
        const textWidth = ctx.measureText(labelText).width;
        const labelHeight = Math.max(16, Math.round(canvas.width / 40));

        ctx.fillRect(
          r.x,
          Math.max(0, r.y - labelHeight),
          textWidth + labelPadding * 2,
          labelHeight,
        );

        // Label text
        ctx.fillStyle = "#ffffff";
        ctx.fillText(
          labelText,
          r.x + labelPadding,
          Math.max(labelHeight - 4, r.y - 4),
        );
      });

      // 4. Draw active custom crop boundary currently being drawn
      if (workspaceMode === "slice" && drawRect) {
        ctx.lineWidth = Math.max(2, Math.round(canvas.width / 300));
        ctx.strokeStyle = "#10b981"; // Green for custom box in progress
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
      }

      // 5. Draw manual seed points if in chroma mode and contiguous is active
      if (
        workspaceMode === "chroma" &&
        contiguousMode &&
        manualSeeds.length > 0
      ) {
        ctx.setLineDash([]); // Reset dashed line style
        manualSeeds.forEach((seed) => {
          ctx.beginPath();
          ctx.arc(
            seed.x,
            seed.y,
            Math.max(4, Math.round(canvas.width / 150)),
            0,
            2 * Math.PI,
          );
          ctx.fillStyle = "rgba(239, 68, 68, 0.45)"; // Semi-transparent red dot
          ctx.fill();
          ctx.strokeStyle = "#ef4444"; // Red border
          ctx.lineWidth = Math.max(1.5, Math.round(canvas.width / 450));
          ctx.stroke();

          // White crosshair inside the red dot
          ctx.beginPath();
          const rSize = Math.max(5, Math.round(canvas.width / 120));
          ctx.moveTo(seed.x - rSize, seed.y);
          ctx.lineTo(seed.x + rSize, seed.y);
          ctx.moveTo(seed.x, seed.y - rSize);
          ctx.lineTo(seed.x, seed.y + rSize);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(1, Math.round(canvas.width / 600));
          ctx.stroke();
        });
      }

      // Force texture upload for hardware acceleration to prevent severe lag
      // when the magnifier uses drawImage for the first time.
      try {
        if (!offscreenCanvasRef.current) {
          offscreenCanvasRef.current = document.createElement("canvas");
          offscreenCanvasRef.current.width = 1;
          offscreenCanvasRef.current.height = 1;
        }
        const offscreen = offscreenCanvasRef.current;
        const offCtx = offscreen.getContext("2d");
        if (offCtx) offCtx.drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1);
      } catch (e) {
        // ignore
      }
    };

    // 2. Put processed image
    ctx.putImageData(imgData, 0, 0);
    renderOverlays();
  };

  /**
   * Helper to translate screen client space coordinates to real Canvas pixels.
   */
  const getCanvasCoordinates = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvasRectRef.current || canvas.getBoundingClientRect();
    if (!canvasRectRef.current) {
      canvasRectRef.current = rect;
    }

    const adjustedLeft = rect.left + 1;
    const adjustedTop = rect.top + 1;
    const adjustedWidth = rect.width - 2;
    const adjustedHeight = rect.height - 2;

    // Scale mapping factor
    const scaleX = canvas.width / adjustedWidth;
    const scaleY = canvas.height / adjustedHeight;

    const x = Math.round((clientX - adjustedLeft) * scaleX);
    const y = Math.round((clientY - adjustedTop) * scaleY);

    return {
      x: Math.max(0, Math.min(canvas.width - 1, x)),
      y: Math.max(0, Math.min(canvas.height - 1, y)),
    };
  };

  // Canvas Interactions
  const handleStartInteraction = (
    e:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ) => {
    if ("touches" in e) {
      lastTouchTimeRef.current = Date.now();
    } else if (Date.now() - lastTouchTimeRef.current < 500) {
      return; // Ignore synthesized mouse events
    }

    // Update cached rects on every action start to ensure they are fully up-to-date
    updateCachedRects();

    // 1. Check for multi-touch pinch zoom first
    if ("touches" in e && e.touches.length === 2) {
      const canvasTouches = Array.from(
        e.touches as unknown as React.Touch[],
      ).filter(
        (t) =>
          t.target === canvasRef.current ||
          canvasRef.current?.contains(t.target as Node),
      );

      if (canvasTouches.length === 2) {
        if (!isPanActive) {
          return; // strictly ignore pinch zoom if not in Move/Pan mode
        }
        e.preventDefault();
        const dx = canvasTouches[0].clientX - canvasTouches[1].clientX;
        const dy = canvasTouches[0].clientY - canvasTouches[1].clientY;
        initialPinchDistanceRef.current = Math.sqrt(dx * dx + dy * dy);
        initialPinchZoomRef.current = zoom;
        setIsDrawing(false);
        magnifierCoordsRef.current = null; // Clear magnifier during zoom gesture
        return;
      }
    }

    // Do NOT call e.preventDefault() globally here, as it blocks native panning on touch devices
    if (!("touches" in e) || !isPanActive) {
      e.preventDefault();
    }

    // Find the touch that is actually on the canvas
    let activeTouch = "touches" in e ? e.touches[0] : null;
    if ("touches" in e) {
      const canvasTouch = Array.from(
        e.touches as unknown as React.Touch[],
      ).find(
        (t) =>
          t.target === canvasRef.current ||
          canvasRef.current?.contains(t.target as Node),
      );
      if (canvasTouch) activeTouch = canvasTouch;
    }
    const clientX = activeTouch
      ? activeTouch.clientX
      : (e as React.MouseEvent).clientX;
    const clientY = activeTouch
      ? activeTouch.clientY
      : (e as React.MouseEvent).clientY;

    const coords = getCanvasCoordinates(clientX, clientY);
    const isPrecisionMode =
      workspaceMode === "chroma" ||
      workspaceMode === "smart" ||
      workspaceMode === "brush";

    if (coords) {
      activeCoordsRef.current = coords;
    }

    if (
      coords &&
      canvasRef.current &&
      panelRef.current &&
      (isPrecisionMode || isMagnifierActive)
    ) {
      const panelRect =
        panelRectRef.current || panelRef.current.getBoundingClientRect();
      const screenX = clientX - panelRect.left;
      const screenY = clientY - panelRect.top;
      if (isMagnifierActive) {
        drawMagnifier(screenX, screenY, coords.x, coords.y);
      } else {
        magnifierCoordsRef.current = {
          screenX,
          screenY,
          x: coords.x,
          y: coords.y,
        };
      }
    }

    if (isPanActive) {
      if (containerRef.current) {
        if (canvasRef.current) {
          canvasRef.current.style.cursor = "grabbing";
        }
        panStartRef.current = {
          x: clientX,
          y: clientY,
          scrollLeft: containerRef.current.scrollLeft,
          scrollTop: containerRef.current.scrollTop,
        };
        canvasRectRef.current = null;
        panelRectRef.current = null;
      }
      return;
    }

    if (isMagnifierActive) {
      return; // Do not apply automatic actions when magnifier is active (user places manually with button)
    }

    setIsDrawing(true);

    if (!coords || !canvasRef.current) return;

    // Save historyRef.current before any modifications
    pushToHistory();

    if (workspaceMode === "brush" && brushMode !== "none" && brushMaskRef.current) {
      // Begin manual erase/restore brushing immediately (continuous)
      applyBrush(coords.x, coords.y);
    } else if (workspaceMode === "slice") {
      // Begin custom crop rectangle drawing immediately (continuous)
      setDrawStart(coords);
      setDrawRect({ x: coords.x, y: coords.y, width: 0, height: 0 });
    }
  };

  const handleMoveInteraction = (
    e:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ) => {
    if (!("touches" in e) && Date.now() - lastTouchTimeRef.current < 500) {
      return; // Ignore synthesized mouse events
    }

    // 1. Check for multi-touch pinch zoom first
    if ("touches" in e && e.touches.length === 2) {
      // If we are holding the magnifier button, we might have 2 touches but one is on the button.
      // We should only pinch-zoom if BOTH touches are on the canvas.
      const canvasTouches = Array.from(
        e.touches as unknown as React.Touch[],
      ).filter(
        (t) =>
          t.target === canvasRef.current ||
          canvasRef.current?.contains(t.target as Node),
      );

      if (canvasTouches.length === 2) {
        if (!isPanActive) {
          return; // strictly ignore pinch zoom if not in Move/Pan mode
        }
        e.preventDefault();
        if (initialPinchDistanceRef.current !== null) {
          const dx = canvasTouches[0].clientX - canvasTouches[1].clientX;
          const dy = canvasTouches[0].clientY - canvasTouches[1].clientY;
          const currentDist = Math.sqrt(dx * dx + dy * dy);
          if (currentDist > 5) {
            const factor = currentDist / initialPinchDistanceRef.current;
            const targetZoom = Math.max(
              1,
              Math.min(2, initialPinchZoomRef.current * factor),
            );
            const newZoom = Math.round(targetZoom * 100) / 100;

            if (Math.abs(newZoom - zoom) >= 0.05) {
              // Throttle React state updates to 5% increments to prevent lag
              setZoom(newZoom);
            }
          }
        }
        magnifierCoordsRef.current = null; // Clear magnifier during zoom gesture
        return;
      }
    }

    // Find the touch that is actually on the canvas
    let activeTouch = "touches" in e ? e.touches[0] : null;
    if ("touches" in e) {
      const canvasTouch = Array.from(
        e.touches as unknown as React.Touch[],
      ).find(
        (t) =>
          t.target === canvasRef.current ||
          canvasRef.current?.contains(t.target as Node),
      );
      if (canvasTouch) activeTouch = canvasTouch;
    }
    const clientX = activeTouch
      ? activeTouch.clientX
      : (e as React.MouseEvent).clientX;
    const clientY = activeTouch
      ? activeTouch.clientY
      : (e as React.MouseEvent).clientY;

    // 2. Immediate fast path for Panning/Scrolling - absolutely no other calculations/reflows!
    if (isPanActive) {
      if (panStartRef.current && containerRef.current) {
        // Manually pan ONLY for mouse. Touch uses native scrolling because of touchAction: pan-x pan-y
        if (!("touches" in e)) {
          const dx = clientX - panStartRef.current.x;
          const dy = clientY - panStartRef.current.y;
          containerRef.current.scrollLeft = panStartRef.current.scrollLeft - dx;
          containerRef.current.scrollTop = panStartRef.current.scrollTop - dy;
          canvasRectRef.current = null;
          panelRectRef.current = null;
        }
      }
      return;
    }

    // Ensure rects are cached
    if (!canvasRectRef.current || !panelRectRef.current) {
      updateCachedRects();
    }

    // Update Magnifier Coordinates on move (including hover)
    const coords = getCanvasCoordinates(clientX, clientY);
    const isPrecisionMode =
      workspaceMode === "chroma" ||
      workspaceMode === "smart" ||
      workspaceMode === "brush";

    if (coords) {
      activeCoordsRef.current = coords;
    }

    if (
      coords &&
      canvasRef.current &&
      panelRef.current &&
      (isPrecisionMode || isMagnifierActive)
    ) {
      const panelRect =
        panelRectRef.current || panelRef.current.getBoundingClientRect();
      const screenX = clientX - panelRect.left;
      const screenY = clientY - panelRect.top;
      if (isMagnifierActive) {
        drawMagnifier(screenX, screenY, coords.x, coords.y);
      } else {
        magnifierCoordsRef.current = {
          screenX,
          screenY,
          x: coords.x,
          y: coords.y,
        };
      }
    } else if (!isMagnifierActive) {
      magnifierCoordsRef.current = null;
    }

    if (!isDrawing) return;
    e.preventDefault();

    if (isMagnifierActive) {
      return; // If magnifier is active, do not apply automatic actions on drag
    }

    if (!coords || !canvasRef.current) return;

    if (workspaceMode === "brush" && brushMode !== "none" && brushMaskRef.current) {
      applyBrush(coords.x, coords.y);
    } else if (workspaceMode === "slice" && drawStart) {
      const x = Math.min(drawStart.x, coords.x);
      const y = Math.min(drawStart.y, coords.y);
      const width = Math.abs(drawStart.x - coords.x);
      const height = Math.abs(drawStart.y - coords.y);
      setDrawRect({ x, y, width, height });
    }
  };

  const handleEndInteraction = (
    e?:
      | React.MouseEvent<HTMLCanvasElement>
      | React.TouchEvent<HTMLCanvasElement>,
  ) => {
    if (e && !("touches" in e) && Date.now() - lastTouchTimeRef.current < 500) {
      return; // Ignore synthesized mouse events
    }

    setIsDrawing(false);

    if (e && "touches" in e) {
      if (e.touches.length < 2) {
        initialPinchDistanceRef.current = null;
      }
    } else {
      initialPinchDistanceRef.current = null;
    }

    if (isPanActive) {
      if (canvasRef.current) canvasRef.current.style.cursor = "";
      panStartRef.current = null;
      return;
    }

    if (isMagnifierActive) {
      return; // Keep magnifier visible so user can adjust pixel-perfectly and tap buttons below
    }

    magnifierCoordsRef.current = null;

    const finalCoords = activeCoordsRef.current;
    activeCoordsRef.current = null; // Reset for next gesture

    if (!finalCoords) return;

    // Normal interactions - push historyRef.current before making changes
    pushToHistory();

    if (workspaceMode === "chroma") {
      // Commit Chroma Key selection and manual seed addition on release (making it incredibly precise)
      if (originalImageDataRef.current) {
        const idx =
          (finalCoords.y * originalImageDataRef.current.width + finalCoords.x) * 4;
        const r = originalImageDataRef.current.data[idx];
        const g = originalImageDataRef.current.data[idx + 1];
        const b = originalImageDataRef.current.data[idx + 2];
        setTransparentColor({ r, g, b });
        setLastPickedCoords({ x: finalCoords.x, y: finalCoords.y });

        if (contiguousMode) {
          setManualSeeds((prev) => {
            // Check for duplicate seed to avoid stacking
            const exists = prev.some(
              (s) =>
                Math.abs(s.x - finalCoords.x) < 4 &&
                Math.abs(s.y - finalCoords.y) < 4,
            );
            if (!exists) {
              return [...prev, { x: finalCoords.x, y: finalCoords.y }];
            }
            return prev;
          });
        }
      }
    } else if (workspaceMode === "smart") {
      // Detect connected component precisely on release
      if (processedImageDataRef.current) {
        const rect = findConnectedComponentAt(
          processedImageDataRef.current,
          finalCoords.x,
          finalCoords.y,
          1,
          padding,
        );
        if (rect) {
          setSlices((prev) => {
            const count =
              prev.filter((s) => s.id.startsWith("smart-")).length + 1;
            const newSlice: Slice = {
              id: `smart-${Date.now()}`,
              rect,
              label: `Умный объект ${count}`,
            };
            setSelectedSliceId(newSlice.id);
            return [...prev, newSlice];
          });
        }
      }
    } else if (workspaceMode === "slice") {
      if (drawRect && drawRect.width > 5 && drawRect.height > 5) {
        let finalRect = drawRect;
        if (snapToEdges && processedImageDataRef.current) {
          finalRect = trimTransparentMargins(processedImageDataRef.current, drawRect);
        }
        // Add custom slice
        setSlices((prev) => {
          const count =
            prev.filter((s) => s.id.startsWith("custom-")).length + 1;
          const newSlice: Slice = {
            id: `custom-${Date.now()}`,
            rect: finalRect,
            label: `Свой объект ${count}`,
          };
          setSelectedSliceId(newSlice.id);
          return [...prev, newSlice];
        });
      }
      setDrawRect(null);
      setDrawStart(null);
    } else {
      // Standard click to select slice bounding box on release
      const clickedSlice = slices.find((s) => {
        const r = s.rect;
        return (
          finalCoords.x >= r.x &&
          finalCoords.x <= r.x + r.width &&
          finalCoords.y >= r.y &&
          finalCoords.y <= r.y + r.height
        );
      });
      if (clickedSlice) {
        setSelectedSliceId(clickedSlice.id);
      }
    }
  };

  /**
   * Applies the brush mask onto coordinates inside the original resolution space.
   */
  const applyBrush = (cx: number, cy: number) => {
    if (!brushMaskRef.current || !originalImageDataRef.current || !processedImageDataRef.current) return;
    const { width, height } = originalImageDataRef.current;
    const updatedMask = new Uint8Array(brushMaskRef.current);
    const updatedProcessed = new ImageData(
      new Uint8ClampedArray(processedImageDataRef.current.data),
      width,
      height,
    );

    const radius = brushSize;
    const r2 = radius * radius;

    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;

      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;

        if (dx * dx + dy * dy <= r2) {
          const idx = y * width + x;
          const maskVal = brushMode === "erase" ? 0 : 1;
          updatedMask[idx] = maskVal;

          if (maskVal === 0) {
            updatedProcessed.data[idx * 4 + 3] = 0; // Erase
          } else {
            const pxIdx = idx * 4;
            updatedProcessed.data[pxIdx] = originalImageDataRef.current.data[pxIdx];
            updatedProcessed.data[pxIdx + 1] = originalImageDataRef.current.data[pxIdx + 1];
            updatedProcessed.data[pxIdx + 2] = originalImageDataRef.current.data[pxIdx + 2];
            updatedProcessed.data[pxIdx + 3] = originalImageDataRef.current.data[pxIdx + 3];
          }
        }
      }
    }
    brushMaskRef.current = updatedMask;
    processedImageDataRef.current = updatedProcessed;
    setDataVersion(v => v + 1);
  };

  /**
   * Reset manual paint mask.
   */
  const resetBrushMask = () => {
    if (!image) return;
    const mask = new Uint8Array(image.naturalWidth * image.naturalHeight);
    mask.fill(255);
    brushMaskRef.current = mask;
    setDataVersion(v => v + 1);
  };

  /**
   * Removes a slice by its ID and clears it from allTimeAutoSlicesRef cache.
   */
  const deleteSliceById = (idToDelete: string) => {
    const remaining = slices.filter((s) => s.id !== idToDelete);
    setSlices(remaining);
    
    // Clear from auto-slices cache to prevent reappearing
    allTimeAutoSlicesRef.current = allTimeAutoSlicesRef.current.filter((s) => s.id !== idToDelete);
    
    if (selectedSliceId === idToDelete) {
      setSelectedSliceId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  /**
   * Removes the selected slice.
   */
  const deleteSelectedSlice = () => {
    if (selectedSliceId) {
      deleteSliceById(selectedSliceId);
    }
  };

  /**
   * Clears all slices.
   */
  const clearAllSlices = () => {
    setSlices([]);
    setSelectedSliceId(null);
  };

  /**
   * Handles zoom steps and mode toggles.
   */
  const handleZoomChange = (direction: "in" | "out") => {
    const zoomLevels = [1, 1.12, 1.25, 1.5, 2];
    const currentIndex = zoomLevels.findIndex(
      (lvl) => Math.abs(lvl - zoom) < 0.1,
    );

    let nextIndex = currentIndex;
    if (direction === "in") {
      nextIndex = Math.min(zoomLevels.length - 1, currentIndex + 1);
    } else {
      nextIndex = Math.max(0, currentIndex - 1);
    }

    const nextZoom = zoomLevels[nextIndex];
    setZoom(nextZoom);

    if (nextZoom === 1) {
      setIsPanActive(false);
    }
  };

  return (
    <div
      id="workspace-container"
      className="w-full flex flex-col lg:flex-row gap-6 mt-2 max-w-7xl mx-auto items-stretch"
    >
      {/* Visual Canvas Panel */}
      <div
        ref={panelRef}
        className="flex-1 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 flex flex-col items-center justify-center relative min-h-[350px] lg:min-h-[500px]"
      >
        {/* Workspace Mode Badge Indicator */}
        <div className="absolute top-4 left-4 z-10 bg-neutral-950/80 backdrop-blur-md border border-neutral-800 px-3 py-1.5 rounded-full flex items-center gap-2 text-xs font-semibold text-neutral-300">
          <span
            className={`w-2.5 h-2.5 rounded-full animate-pulse ${
              workspaceMode === "chroma"
                ? "bg-cyan-500"
                : workspaceMode === "brush"
                  ? "bg-amber-500"
                  : workspaceMode === "slice"
                    ? "bg-emerald-500"
                    : "bg-violet-500"
            }`}
          ></span>
          {workspaceMode === "chroma" && "Выбор цвета фона"}
          {workspaceMode === "brush" &&
            `Ластик / Восстановление (${brushMode === "erase" ? "Ластик" : brushMode === "restore" ? "Кисть" : "Выкл"})`}
          {workspaceMode === "slice" && "Ручное выделение области"}
          {workspaceMode === "smart" && "Умное выделение кликом"}
        </div>

        {/* Action Controls Overlay (Top Right) */}
        <button
          id="btn-workspace-reset"
          onClick={onReset}
          className="absolute top-4 right-4 z-10 bg-neutral-950/80 hover:bg-neutral-950 hover:text-white backdrop-blur-md border border-neutral-800 text-neutral-400 p-2 rounded-xl transition-all shadow-md active:scale-95"
          title="Загрузить другое изображение"
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        {/* Scrollable Frame surrounding the Canvas */}
        <div
          ref={containerRef}
          className={`w-full h-full max-h-[550px] overflow-auto p-4 transition-all ${
            zoom > 1
              ? "flex items-start justify-start"
              : "flex items-center justify-center"
          }`}
        >
          <canvas
            id="workspace-canvas"
            ref={canvasRef}
            onMouseDown={handleStartInteraction}
            onMouseMove={handleMoveInteraction}
            onMouseUp={handleEndInteraction}
            onMouseLeave={handleEndInteraction}
            onTouchStart={handleStartInteraction}
            onTouchMove={handleMoveInteraction}
            onTouchEnd={handleEndInteraction}
            style={{
              width: zoom > 1 ? `${baseWidthRef.current * zoom}px` : "auto",
              height:
                zoom > 1
                  ? `${(baseWidthRef.current * zoom * (canvasRef.current?.height || 1)) / (canvasRef.current?.width || 1)}px`
                  : "auto",
              maxWidth: zoom > 1 ? "none" : "100%",
              maxHeight: zoom > 1 ? "none" : "480px",
              touchAction: isPanActive ? "pan-x pan-y" : "none",
              cursor: isPanActive
                ? isDrawing
                  ? "grabbing"
                  : "grab"
                : workspaceMode === "brush"
                  ? "none"
                  : "crosshair",
              backgroundImage: `
                linear-gradient(45deg, #e5e7eb 25%, transparent 25%), 
                linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), 
                linear-gradient(45deg, transparent 75%, #e5e7eb 75%), 
                linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)
              `,
              backgroundSize: "24px 24px",
              backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0px",
              backgroundColor: "#ffffff",
            }}
            className={`object-contain shadow-2xl border border-neutral-800 ${
              zoom > 1 ? "" : "max-w-full max-h-[480px]"
            }`}
          />
        </div>

        {/* Floating Magnifying Glass (Лупа) */}
        {isMagnifierActive && (
          <div
            ref={magnifierContainerRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "140px",
              height: "140px",
              pointerEvents: "none",
              zIndex: 50,
              willChange: "transform",
            }}
            className="rounded-full border-4 border-white shadow-2xl overflow-hidden bg-neutral-950 flex items-center justify-center transition-shadow ring-4 ring-neutral-950/20"
          >
            <canvas
              ref={magnifierCanvasRef}
              width={140}
              height={140}
              className="w-full h-full"
            />
            {/* Central Target Reticle */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              {/* Outer circle */}
              <div className="w-3.5 h-3.5 rounded-full border border-red-500 bg-red-500/20"></div>
              {/* Center point */}
              <div className="w-1 h-1 rounded-full bg-red-500"></div>
              {/* Horizontal Crosshair lines */}
              <div className="w-6 h-[1.5px] bg-red-500/60 absolute"></div>
              <div className="h-6 w-[1.5px] bg-red-500/60 absolute"></div>
            </div>
          </div>
        )}

        {/* Action buttons bar when Magnifier is Active */}
        {isMagnifierActive && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 bg-neutral-950/90 border border-neutral-800 p-3 rounded-2xl shadow-xl z-20 max-w-lg w-full animate-in fade-in slide-in-from-bottom-2 duration-200">
            {/* ПОСТАВИТЬ (Place) button */}
            <button
              id="btn-magnifier-place"
              onClick={() => {
                const coords = magnifierCoordsRef.current;
                if (!coords) return;
                pushToHistory(); // save historyRef.current before making changes
                const { x, y } = coords;
                if (workspaceMode === "chroma") {
                  if (originalImageDataRef.current) {
                    const idx = (y * originalImageDataRef.current.width + x) * 4;
                    const r = originalImageDataRef.current.data[idx];
                    const g = originalImageDataRef.current.data[idx + 1];
                    const b = originalImageDataRef.current.data[idx + 2];
                    setTransparentColor({ r, g, b });
                    setLastPickedCoords({ x, y });
                    if (contiguousMode) {
                      setManualSeeds((prev) => {
                        const exists = prev.some(
                          (s) => Math.abs(s.x - x) < 4 && Math.abs(s.y - y) < 4,
                        );
                        if (!exists) {
                          return [...prev, { x, y }];
                        }
                        return prev;
                      });
                    }
                  }
                } else if (workspaceMode === "smart") {
                  if (processedImageDataRef.current) {
                    const rect = findConnectedComponentAt(
                      processedImageDataRef.current,
                      x,
                      y,
                      1,
                      padding,
                    );
                    if (rect) {
                      setSlices((prev) => {
                        const count =
                          prev.filter((s) => s.id.startsWith("smart-")).length +
                          1;
                        const newSlice: Slice = {
                          id: `smart-${Date.now()}`,
                          rect,
                          label: `Умный объект ${count}`,
                        };
                        setSelectedSliceId(newSlice.id);
                        return [...prev, newSlice];
                      });
                    }
                  }
                } else if (workspaceMode === "brush") {
                  applyBrush(x, y);
                }
              }}
              className="flex-1 min-w-[100px] bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-4 rounded-xl shadow-lg transition-all text-xs flex items-center justify-center gap-2 active:scale-95"
            >
              <Check className="w-4 h-4" />
              <span>Поставить</span>
            </button>

            {/* НАЗАД (Undo) button */}
            <button
              id="btn-magnifier-undo"
              onClick={handleUndo}
              disabled={historyCount === 0}
              className="flex-1 min-w-[100px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40 disabled:hover:bg-neutral-800 font-bold py-2 px-4 rounded-xl transition-all text-xs flex items-center justify-center gap-2 active:scale-95"
            >
              <Undo className="w-4 h-4" />
              <span>Назад</span>
            </button>

            {/* СОХРАНИТЬ (Save) button */}
            <button
              id="btn-magnifier-save"
              onClick={() => {
                setIsMagnifierActive(false);
              }}
              className="flex-1 min-w-[100px] bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-4 rounded-xl shadow-lg transition-all text-xs flex items-center justify-center gap-2 active:scale-95"
            >
              <Save className="w-4 h-4" />
              <span>Сохранить</span>
            </button>

            {/* ОТМЕНА (Cancel) button */}
            <button
              id="btn-magnifier-cancel"
              onClick={() => {
                if (magnifierBackupRef.current) {
                  setSlices(magnifierBackupRef.current.slices);
                  setManualSeeds(magnifierBackupRef.current.manualSeeds);
                  setTransparentColor(magnifierBackupRef.current.transparentColor);
                  if (magnifierBackupRef.current.brushMask) {
                    brushMaskRef.current = new Uint8Array(magnifierBackupRef.current.brushMask);
                  } else {
                    brushMaskRef.current = null;
                  }
                  setDataVersion(v => v + 1);
                }
                setIsMagnifierActive(false);
                magnifierCoordsRef.current = null;
              }}
              className="flex-1 min-w-[100px] bg-rose-600 hover:bg-rose-500 text-white font-bold py-2 px-4 rounded-xl transition-all text-xs flex items-center justify-center gap-2 active:scale-95"
            >
              <X className="w-4 h-4" />
              <span>Отмена</span>
            </button>
          </div>
        )}

        {/* Floating Zoom & Pan Control Bar Overlay */}
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-neutral-950/90 backdrop-blur-md border border-neutral-800 px-3 py-1.5 rounded-full shadow-2xl text-white select-none">
          <button
            id="btn-zoom-pan-toggle"
            onClick={() => setIsPanActive((prev) => !prev)}
            className={`p-1.5 rounded-lg transition-all ${
              isPanActive
                ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
            }`}
            title={
              isPanActive
                ? "Выключить перемещение"
                : "Включить перемещение (панорамирование)"
            }
          >
            <Move className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-neutral-800" />

          {/* Magnifier zoom & activation button */}
          <button
            id="btn-magnifier-zoom"
            onMouseDown={handleMagnifierButtonPressStart}
            onMouseUp={handleMagnifierButtonPressEnd}
            onMouseLeave={handleMagnifierButtonPressCancel}
            onTouchStart={handleMagnifierButtonPressStart}
            onTouchEnd={handleMagnifierButtonPressEnd}
            onTouchCancel={handleMagnifierButtonPressCancel}
            className={`p-1.5 rounded-lg transition-all flex items-center gap-1 select-none touch-none ${
              isMagnifierActive
                ? "bg-amber-500 text-neutral-950 shadow-lg shadow-amber-500/20 scale-95 font-semibold"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
            }`}
            title="Зажмите для включения/выключения Лупы, нажмите для изменения масштаба"
          >
            <Search
              className={`w-4 h-4 ${isMagnifierActive ? "text-neutral-950" : "text-amber-400"}`}
            />
            <span
              className={`text-[10px] font-mono font-bold ${isMagnifierActive ? "text-neutral-950" : "text-neutral-300"}`}
            >
              {magnifierZoom}x
            </span>
          </button>

          <div className="w-px h-4 bg-neutral-800" />

          <button
            id="btn-zoom-out"
            onClick={() => handleZoomChange("out")}
            className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white transition-all disabled:opacity-35"
            disabled={zoom <= 1}
            title="Отдалить"
          >
            <Minus className="w-4 h-4" />
          </button>

          <span className="text-[10px] font-mono font-bold px-1 min-w-[36px] text-center text-neutral-300">
            {Math.round(zoom * 100)}%
          </span>

          <button
            id="btn-zoom-in"
            onClick={() => handleZoomChange("in")}
            className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white transition-all disabled:opacity-35"
            disabled={zoom >= 2}
            title="Приблизить"
          >
            <Plus className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-neutral-800" />

          <button
            id="btn-zoom-reset"
            onClick={() => {
              setZoom(1);
              setIsPanActive(false);
            }}
            className="px-2 py-1 text-[10px] font-semibold text-neutral-400 hover:bg-neutral-800 hover:text-white rounded-md transition-all"
            title="Сбросить масштаб"
          >
            Сброс
          </button>
        </div>

        {/* Workspace Helper hint footer inside canvas frame */}
        <div className="text-center text-xs text-neutral-500 mt-2 px-6 py-1 border-t border-neutral-800/50 w-full min-h-[32px] flex items-center justify-center">
          {isPanActive ? (
            <span className="text-blue-400 font-semibold animate-pulse">
              🖐️ Режим перемещения активен. Перетаскивайте изображение мышкой
              или пальцем для навигации.
            </span>
          ) : (
            <span>
              {workspaceMode === "chroma" &&
                "Нажмите на любой цвет на изображении, чтобы сделать его прозрачным"}
              {workspaceMode === "brush" &&
                "Проведите пальцем или мышью по холсту, чтобы стереть детали или восстановить фон"}
              {workspaceMode === "slice" &&
                "Зажмите и ведите пальцем, чтобы вручную создать новую рамку кадрирования"}
              {workspaceMode === "smart" &&
                "Нажмите прямо на объект, чтобы мгновенно распознать его контуры и выделить"}
            </span>
          )}
        </div>
      </div>

      {/* Control Panels Tab Sidebar */}
      <div
        id="controls-sidebar"
        className="w-full lg:w-[380px] flex flex-col gap-5"
      >
        {/* Step-by-Step Workflow Tabs */}
        <div className="bg-white border border-neutral-100 rounded-2xl p-1 flex shadow-sm gap-1">
          <button
            id="tab-step-bg"
            onClick={() => setActiveStep("bg")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 px-1.5 rounded-xl font-bold text-[10px] sm:text-xs transition-all ${
              activeStep === "bg"
                ? "bg-neutral-900 text-white shadow-sm"
                : "text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50"
            }`}
          >
            <Wand2 className="w-4 h-4" />
            <span>1. Фон</span>
          </button>
          <button
            id="tab-step-slice"
            onClick={() => setActiveStep("slice")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 px-1.5 rounded-xl font-bold text-[10px] sm:text-xs transition-all ${
              activeStep === "slice"
                ? "bg-neutral-900 text-white shadow-sm"
                : "text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50"
            }`}
          >
            <Grid className="w-4 h-4" />
            <span>2. Нарезка</span>
          </button>
          <button
            id="tab-step-objects"
            onClick={() => setActiveStep("objects")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 px-1.5 rounded-xl font-bold text-[10px] sm:text-xs transition-all ${
              activeStep === "objects"
                ? "bg-neutral-900 text-white shadow-sm"
                : "text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50"
            }`}
          >
            <div className="relative">
              <SlidersHorizontal className="w-4 h-4" />
              {slices.length > 0 && (
                <span className="absolute -top-1.5 -right-2 bg-blue-500 text-white text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center border border-white">
                  {slices.length}
                </span>
              )}
            </div>
            <span>3. Объекты</span>
          </button>
        </div>

        {/* Step 1: Background Cleanup */}
        {activeStep === "bg" && (
          <div className="flex flex-col gap-4">
            {/* Sub-mode selector: Chroma Key vs Brush */}
            <div className="bg-neutral-100/80 border border-neutral-200/50 rounded-xl p-1 flex gap-1">
              <button
                onClick={() => setBgSubMode("chroma")}
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold transition-all ${
                  bgSubMode === "chroma"
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                🧹 Пипетка цвета
              </button>
              <button
                onClick={() => setBgSubMode("brush")}
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold transition-all ${
                  bgSubMode === "brush"
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                🖌️ Кисть / Ластик
              </button>
            </div>

            {bgSubMode === "chroma" ? (
              /* Chroma Key Panel */
              <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4">
                <h4 className="font-bold text-neutral-800 text-sm flex items-center gap-2 border-b border-neutral-100 pb-2.5">
                  <Wand2 className="w-4 h-4 text-cyan-500" />
                  Удаление фона по цвету
                </h4>

                {/* Current picked color swatch */}
                <div className="flex items-center justify-between p-3 bg-neutral-50 rounded-xl border border-neutral-100">
                  <span className="text-xs text-neutral-500 font-medium">
                    Ключевой цвет:
                  </span>
                  <div className="flex items-center gap-2">
                    {transparentColor ? (
                      <>
                        <div
                          className="w-5 h-5 rounded-md border border-neutral-200 shadow-inner"
                          style={{
                            backgroundColor: `rgb(${transparentColor.r}, ${transparentColor.g}, ${transparentColor.b})`,
                          }}
                        />
                        <span className="font-mono text-xs text-neutral-800 font-semibold uppercase">
                          rgb({transparentColor.r}, {transparentColor.g},{" "}
                          {transparentColor.b})
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-neutral-400 italic">
                        Не выбран
                      </span>
                    )}
                  </div>
                </div>

                {/* Chroma tolerance slider */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold text-neutral-700">
                    <span>Допуск по цвету (Чувствительность)</span>
                    <span className="text-neutral-500 font-mono">{tolerance}</span>
                  </div>
                  <input
                    id="input-tolerance"
                    type="range"
                    min="5"
                    max="150"
                    value={tolerance}
                    onChange={(e) => setTolerance(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                  />
                  <p className="text-[10px] text-neutral-400 leading-normal">
                    Увеличьте значение, если фон удаляется не полностью (например,
                    есть градиент или тени), или уменьшите, если пропадают части
                    логотипа.
                  </p>
                </div>

                {/* Edge softness/feathering slider */}
                <div className="flex flex-col gap-1.5 pb-2 border-b border-neutral-100">
                  <div className="flex justify-between text-xs font-semibold text-neutral-700">
                    <span>Мягкость краев (Сглаживание)</span>
                    <span className="text-neutral-500 font-mono">
                      {edgeSoftness} px
                    </span>
                  </div>
                  <input
                    id="input-edge-softness"
                    type="range"
                    min="0"
                    max="30"
                    value={edgeSoftness}
                    onChange={(e) => setEdgeSoftness(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                  />
                  <p className="text-[10px] text-neutral-400 leading-normal">
                    Позволяет размыть жесткую границу перехода, устраняя
                    ступенчатость (пиксельные кубики). При 0 краям возвращается
                    максимальная резкость.
                  </p>
                </div>

                {/* In-panel protection toggle for maximum discoverability */}
                <div className="bg-emerald-50/50 border border-emerald-100/70 rounded-xl p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span className="text-xs font-bold text-neutral-800">
                        Защита монет и алмазов
                      </span>
                    </div>
                    <button
                      id="btn-toggle-contiguous-mode-panel"
                      onClick={() => setContiguousMode((prev) => !prev)}
                      type="button"
                      className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-all shrink-0 cursor-pointer ${
                        contiguousMode
                          ? "bg-emerald-500 justify-end"
                          : "bg-neutral-200 justify-start"
                      }`}
                    >
                      <span className="w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all" />
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-500 leading-normal">
                    {contiguousMode
                      ? "✓ ВКЛЮЧЕНА. Стирается только ВНЕШНИЙ фон. Детали внутри монет/алмазов защищены."
                      : "✗ ВЫКЛЮЧЕНА. Цвет фона сотрется и внутри объектов, если встретится похожий оттенок."}
                  </p>
                  {contiguousMode && (
                    <div className="border-t border-emerald-100/50 pt-2 flex flex-col gap-1.5 mt-1">
                      <span className="text-[9px] text-emerald-700 font-medium leading-relaxed">
                        💡 Кликните внутри замкнутых ушек ключей, колец или дырок,
                        чтобы также очистить их от фона, не затрагивая алмазы!
                      </span>
                      {manualSeeds.length > 0 && (
                        <div className="flex items-center justify-between bg-white/80 border border-emerald-100 px-2 py-1 rounded-lg">
                          <span className="text-[10px] text-neutral-600 font-semibold">
                            Ручных точек: {manualSeeds.length}
                          </span>
                          <button
                            id="btn-clear-seeds"
                            onClick={() => setManualSeeds([])}
                            type="button"
                            className="text-[9px] bg-neutral-50 hover:bg-red-50 hover:text-red-600 text-neutral-500 border border-neutral-200 hover:border-red-200 px-1.5 py-0.5 rounded transition-all font-bold cursor-pointer"
                          >
                            Сбросить
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Trigger auto bg button */}
                <button
                  id="btn-auto-bg"
                  onClick={() => {
                    if (originalImageDataRef.current) {
                      const autoColor = detectBackgroundColor(originalImageDataRef.current);
                      setTransparentColor(autoColor);
                      setLastPickedCoords({ x: 0, y: 0 });
                    }
                  }}
                  className="mt-2 text-xs py-2.5 px-3 border border-neutral-200 hover:border-neutral-300 text-neutral-600 rounded-xl transition-all font-semibold hover:bg-neutral-50/50 flex items-center justify-center gap-1.5 active:scale-95"
                >
                  Авто-определение из углов
                </button>
              </div>
            ) : (
              /* Brush Panel */
              <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4">
                <h4 className="font-bold text-neutral-800 text-sm flex items-center gap-2 border-b border-neutral-100 pb-2.5">
                  <Eraser className="w-4 h-4 text-amber-500" />
                  Точечное стирание / Восстановление
                </h4>

                {/* Brush Sub-Mode Selector */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    id="btn-brush-erase"
                    onClick={() => setBrushMode("erase")}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all border ${
                      brushMode === "erase"
                        ? "bg-amber-50 border-amber-200 text-amber-700 font-bold"
                        : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                    }`}
                  >
                    <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                    Режим Ластика
                  </button>
                  <button
                    id="btn-brush-restore"
                    onClick={() => setBrushMode("restore")}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all border ${
                      brushMode === "restore"
                        ? "bg-blue-50 border-blue-200 text-blue-700 font-bold"
                        : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                    }`}
                  >
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    Восстановление
                  </button>
                </div>

                {/* Brush size slider */}
                <div className="flex flex-col gap-1.5 mt-1">
                  <div className="flex justify-between text-xs font-semibold text-neutral-700">
                    <span>Размер кисти</span>
                    <span className="text-neutral-500 font-mono">
                      {brushSize}px
                    </span>
                  </div>
                  <input
                    id="input-brush-size"
                    type="range"
                    min="5"
                    max="100"
                    value={brushSize}
                    onChange={(e) => setBrushSize(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                  />
                </div>

                {/* Action buttons inside Brush */}
                <button
                  id="btn-reset-mask"
                  onClick={resetBrushMask}
                  className="mt-1 text-xs py-2.5 px-3 border border-neutral-200 hover:border-neutral-300 text-neutral-600 rounded-xl transition-all font-semibold hover:bg-neutral-50/50 flex items-center justify-center gap-1.5 active:scale-95"
                >
                  <Undo className="w-3.5 h-3.5" />
                  Сбросить изменения кисти
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Object Slicing */}
        {activeStep === "slice" && (
          <div className="flex flex-col gap-4">
            {/* Auto-detect slices toggle panel */}
            <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-neutral-100 pb-2.5">
                <h4 className="font-bold text-neutral-800 text-sm flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-neutral-600" />
                  Автоматическая нарезка
                </h4>
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={autoDetectEnabled}
                      onChange={(e) => setAutoDetectEnabled(e.target.checked)}
                    />
                    <div
                      className={`block w-9 h-5 rounded-full transition-colors ${autoDetectEnabled ? "bg-indigo-500" : "bg-neutral-300"}`}
                    ></div>
                    <div
                      className={`dot absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform ${autoDetectEnabled ? "transform translate-x-4" : ""}`}
                    ></div>
                  </div>
                </label>
              </div>

              {autoDetectEnabled ? (
                <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                  {/* Merge Distance slider */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs font-semibold text-neutral-700">
                      <span>Дистанция объединения (Сцепка)</span>
                      <span className="text-neutral-500 font-mono">
                        {mergeDistance}px
                      </span>
                    </div>
                    <input
                      id="input-merge-dist"
                      type="range"
                      min="0"
                      max="100"
                      value={mergeDistance}
                      onChange={(e) => setMergeDistance(parseInt(e.target.value))}
                      className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                    />
                    <p className="text-[10px] text-neutral-400">
                      Увеличьте, чтобы объединить буквы/детали в один логотип, или
                      уменьшите, чтобы разрезать их на отдельные ассеты.
                    </p>
                  </div>

                  {/* Padding slider */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs font-semibold text-neutral-700">
                      <span>Отступы внутри рамок (Внутренний люфт)</span>
                      <span className="text-neutral-500 font-mono">+{padding}px</span>
                    </div>
                    <input
                      id="input-padding"
                      type="range"
                      min="0"
                      max="30"
                      value={padding}
                      onChange={(e) => setPadding(parseInt(e.target.value))}
                      className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                    />
                  </div>

                  {/* Minimum size filter */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs font-semibold text-neutral-700">
                      <span>Минимальный размер объекта</span>
                      <span className="text-neutral-500 font-mono">{minSize}px</span>
                    </div>
                    <input
                      id="input-min-size"
                      type="range"
                      min="2"
                      max="100"
                      value={minSize}
                      onChange={(e) => setMinSize(parseInt(e.target.value))}
                      className="w-full h-1.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-neutral-900"
                    />
                    <p className="text-[10px] text-neutral-400">
                      Исключает мелкие соринки, шумы или пылинки на фоне из результатов
                      нарезки.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-neutral-500 leading-relaxed">
                  Автоматическая нарезка отключена. Вы можете выделять объекты вручную с помощью инструментов ниже.
                </p>
              )}
            </div>

            {/* Manual tools panel */}
            <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4">
              <h4 className="font-bold text-neutral-800 text-sm flex items-center gap-2 border-b border-neutral-100 pb-2.5">
                <Grid className="w-4 h-4 text-emerald-500" />
                Ручные инструменты выделения
              </h4>

              {/* Manual Sub-Mode Selector */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSliceSubMode("manual")}
                  className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all border ${
                    sliceSubMode === "manual"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-700 font-bold"
                      : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                  }`}
                >
                  <Grid className="w-3.5 h-3.5" />
                  Рамка вручную
                </button>
                <button
                  onClick={() => setSliceSubMode("smart")}
                  className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all border ${
                    sliceSubMode === "smart"
                      ? "bg-violet-50 border-violet-200 text-violet-700 font-bold"
                      : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Умный клик
                </button>
              </div>

              {sliceSubMode === "manual" ? (
                <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                  {/* Edge snapping toggle */}
                  <div className="flex items-center justify-between p-3 bg-violet-50/50 border border-violet-100 rounded-xl">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-neutral-800 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-violet-600" />
                        Притягивать к краям (Магнит)
                      </span>
                      <span className="text-[10px] text-neutral-500 leading-tight mt-0.5">
                        Стянет рамку ровно по краям объекта внутри выделенной зоны.
                      </span>
                    </div>
                    <button
                      id="btn-toggle-snap"
                      onClick={() => setSnapToEdges((prev) => !prev)}
                      className={`w-10 h-6 flex items-center rounded-full p-1 transition-all ${
                        snapToEdges
                          ? "bg-violet-600 justify-end"
                          : "bg-neutral-200 justify-start"
                      }`}
                    >
                      <span className="w-4 h-4 rounded-full bg-white shadow-sm transition-all" />
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-400 leading-normal">
                    Зажмите палец или мышь на изображении и ведите в сторону, чтобы вручную создать рамку кадрирования.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                  <div className="bg-violet-50/50 border border-violet-100 rounded-xl p-3.5 flex flex-col gap-2">
                    <span className="text-xs font-bold text-violet-800 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 animate-pulse text-violet-600" />
                      Как это работает?
                    </span>
                    <p className="text-xs text-neutral-600 leading-relaxed">
                      Просто нажмите на любой объект на картинке слева. Алгоритм автоматически распознает его форму по прозрачности и выделит рамкой.
                    </p>
                  </div>
                </div>
              )}

              <button
                id="btn-clear-slices"
                onClick={clearAllSlices}
                className="text-xs py-2.5 px-3 border border-red-100 hover:border-red-200 text-red-600 hover:bg-red-50/50 rounded-xl transition-all font-semibold flex items-center justify-center gap-1.5 active:scale-95"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Удалить ВСЕ рамки
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Objects List */}
        {activeStep === "objects" && (
          <div className="bg-white border border-neutral-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4">
            <h4 className="font-bold text-neutral-800 text-sm flex items-center gap-2 border-b border-neutral-100 pb-2.5">
              <SlidersHorizontal className="w-4 h-4 text-neutral-600" />
              Список выделенных объектов
            </h4>

            {/* Bounding Box Info / Active Slices List */}
            <div className="flex flex-col gap-1 bg-neutral-50 p-3 rounded-xl border border-neutral-100">
              <div className="flex justify-between text-xs font-semibold text-neutral-700">
                <span>Всего объектов:</span>
                <span className="text-neutral-800 bg-neutral-200/60 rounded px-1.5 py-0.5 font-bold font-mono">
                  {slices.length}
                </span>
              </div>
            </div>

            {slices.length > 0 ? (
              <div className="flex flex-col gap-3">
                {/* Scrollable list of slices */}
                <div className="max-h-[200px] overflow-y-auto border border-neutral-100 rounded-xl p-2 flex flex-col gap-1 bg-neutral-50/50">
                  {slices.map((slice) => {
                    const isSelected = slice.id === selectedSliceId;
                    return (
                      <div
                        key={slice.id}
                        onClick={() => setSelectedSliceId(slice.id)}
                        className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all text-xs ${
                          isSelected
                            ? "bg-neutral-900 text-white font-bold shadow-sm"
                            : "hover:bg-neutral-100 text-neutral-700"
                        }`}
                      >
                        <span className="truncate max-w-[200px]">{slice.label}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSliceById(slice.id);
                          }}
                          className={`p-1 rounded transition-all ${
                            isSelected
                              ? "text-red-400 hover:text-red-300 hover:bg-neutral-800"
                              : "text-neutral-400 hover:text-red-600 hover:bg-red-50"
                          }`}
                          title="Удалить рамку"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Selected slice editor */}
                {selectedSliceId && (
                  <div className="bg-neutral-50 border border-neutral-100 rounded-xl p-3.5 flex flex-col gap-2.5 animate-in fade-in duration-200">
                    <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                      Редактирование объекта
                    </span>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-neutral-700">
                        Название ассета
                      </label>
                      <input
                        type="text"
                        value={slices.find((s) => s.id === selectedSliceId)?.label || ""}
                        onChange={(e) => {
                          const newLabel = e.target.value;
                          setSlices((prev) =>
                            prev.map((s) =>
                              s.id === selectedSliceId ? { ...s, label: newLabel } : s
                            )
                          );
                        }}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-neutral-900 bg-white"
                        placeholder="Например, coin_gold"
                      />
                    </div>
                    <button
                      onClick={deleteSelectedSlice}
                      className="text-xs py-2 px-3 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg transition-all font-semibold flex items-center justify-center gap-1.5 active:scale-95"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Удалить этот объект
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-neutral-500 italic text-center py-4">
                Нет выделенных объектов. Перейдите на шаг **2. Нарезка**, чтобы добавить их.
              </p>
            )}

            <button
              id="btn-clear-slices"
              onClick={clearAllSlices}
              className="text-xs py-2.5 px-3 border border-red-100 hover:border-red-200 text-red-600 hover:bg-red-50/50 rounded-xl transition-all font-semibold flex items-center justify-center gap-1.5 active:scale-95"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Удалить ВСЕ рамки
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
