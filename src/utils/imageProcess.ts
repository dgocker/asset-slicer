/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Rect, ColorRGB } from '../types';

export function findConnectedComponentAt(
  imageData: ImageData,
  startX: number,
  startY: number,
  alphaThreshold = 1,
  paddingAmount = 4
): Rect | null {
  const { width, height, data } = imageData;

  let sx = Math.round(startX);
  let sy = Math.round(startY);

  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return null;

  // Use a higher threshold for connectivity to avoid leaking through
  // semi-transparent edge pixels between adjacent assets
  const connectThreshold = Math.max(alphaThreshold, 20);

  const isPixelOpaque = (px: number, py: number): boolean => {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const idx = (py * width + px) * 4;
    return data[idx + 3] >= alphaThreshold;
  };

  const isPixelConnected = (px: number, py: number): boolean => {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const idx = (py * width + px) * 4;
    return data[idx + 3] >= connectThreshold;
  };

  // If clicked pixel is transparent, find nearest opaque pixel
  if (!isPixelOpaque(sx, sy)) {
    const maxSearchRadius = 60;
    let closestX = -1;
    let closestY = -1;
    let minDistanceSq = maxSearchRadius * maxSearchRadius + 1;

    for (let dy = -maxSearchRadius; dy <= maxSearchRadius; dy++) {
      if (dy * dy >= minDistanceSq) continue;
      const testY = sy + dy;
      if (testY < 0 || testY >= height) continue;

      const maxDx = Math.floor(Math.sqrt(minDistanceSq - dy * dy));
      for (let dx = -maxDx; dx <= maxDx; dx++) {
        const testX = sx + dx;
        if (testX < 0 || testX >= width) continue;

        const distSq = dx * dx + dy * dy;
        if (distSq < minDistanceSq) {
          if (isPixelConnected(testX, testY)) {
            minDistanceSq = distSq;
            closestX = testX;
            closestY = testY;
          }
        }
      }
    }

    if (closestX !== -1 && closestY !== -1) {
      sx = closestX;
      sy = closestY;
    } else {
      return null;
    }
  }

  // BFS flood fill using connectThreshold for traversal
  const visited = new Uint8Array(width * height);
  const queue: [number, number][] = [[sx, sy]];
  visited[sy * width + sx] = 1;

  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;

  const maxPixels = 5000000;
  let pixelCount = 0;
  let head = 0;

  while (head < queue.length && pixelCount < maxPixels) {
    const [cx, cy] = queue[head++];
    pixelCount++;

    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);

    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
      [cx + 1, cy + 1],
      [cx - 1, cy - 1],
      [cx + 1, cy - 1],
      [cx - 1, cy + 1],
    ];

    for (let i = 0; i < neighbors.length; i++) {
      const [nx, ny] = neighbors[i];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const idx = ny * width + nx;
        if (visited[idx] === 0 && isPixelConnected(nx, ny)) {
          visited[idx] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }

  // Expand bounding box to include adjacent low-alpha pixels (the soft edge fringe)
  const expandBy = 2;
  minX = Math.max(0, minX - expandBy);
  minY = Math.max(0, minY - expandBy);
  maxX = Math.min(width - 1, maxX + expandBy);
  maxY = Math.min(height - 1, maxY + expandBy);

  const rx = Math.max(0, minX - paddingAmount);
  const ry = Math.max(0, minY - paddingAmount);
  const rMaxX = Math.min(width - 1, maxX + paddingAmount);
  const rMaxY = Math.min(height - 1, maxY + paddingAmount);

  const rw = rMaxX - rx + 1;
  const rh = rMaxY - ry + 1;

  return { x: rx, y: ry, width: rw, height: rh };
}

/**
 * Detects the dominant background color of an image by sampling its corners.
 */
export function detectBackgroundColor(imageData: ImageData): ColorRGB {
  const { width, height, data } = imageData;
  const corners = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  const colorCounts: { [key: string]: { color: ColorRGB; count: number } } = {};

  corners.forEach(({ x, y }) => {
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];

    // If the corner is already transparent, ignore it
    if (a < 50) return;

    // Bucket colors slightly to handle noise
    const rBucket = Math.round(r / 8) * 8;
    const gBucket = Math.round(g / 8) * 8;
    const bBucket = Math.round(b / 8) * 8;
    const key = `${rBucket},${gBucket},${bBucket}`;

    if (colorCounts[key]) {
      colorCounts[key].count++;
    } else {
      colorCounts[key] = { color: { r, g, b }, count: 1 };
    }
  });

  let maxCount = -1;
  let dominantColor: ColorRGB = { r: 255, g: 255, b: 255 };

  Object.values(colorCounts).forEach(({ color, count }) => {
    if (count > maxCount) {
      maxCount = count;
      dominantColor = color;
    }
  });

  return dominantColor;
}

/**
 * Calculates color distance in RGB space.
 */
export function getColorDistance(c1: ColorRGB, c2: ColorRGB): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Automatically detects distinct objects (slices) in the image based on alpha transparency.
 * Uses a grid-based Connected Component Labeling (CCL) approach for speed on mobile.
 */
export function detectSlices(
  imageData: ImageData,
  minSizeThreshold = 10,
  mergeDistance = 12,
  paddingAmount = 4,
  alphaThreshold = 1
): Rect[] {
  const { width, height, data } = imageData;
  
  // Downsample grid for scanning speed on mobile (prevents frame freezes on large camera files)
  const step = Math.max(1, Math.min(
    Math.floor(Math.min(width, height) / 250),
    Math.max(1, Math.floor(minSizeThreshold / 3))
  ));
  const gridW = Math.ceil(width / step);
  const gridH = Math.ceil(height / step);

  // Helper to check if a grid cell has any opaque pixels
  const isCellOpaque = (gx: number, gy: number): boolean => {
    const startX = gx * step;
    const startY = gy * step;
    const endX = Math.min(width, startX + step);
    const endY = Math.min(height, startY + step);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4;
        if (data[idx + 3] >= alphaThreshold) { // Alpha threshold for being considered part of an object
          return true;
        }
      }
    }
    return false;
  };

  // Build a binary grid of active cells
  const grid = new Uint8Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (isCellOpaque(gx, gy)) {
        grid[gy * gridW + gx] = 1;
      }
    }
  }

  // Connected Component Labeling using simple BFS
  const visited = new Uint8Array(gridW * gridH);
  const initialBoxes: Rect[] = [];

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      if (grid[idx] === 1 && visited[idx] === 0) {
        // Start a component search
        let minCellX = gx;
        let maxCellX = gx;
        let minCellY = gy;
        let maxCellY = gy;

        const queue: [number, number][] = [[gx, gy]];
        visited[idx] = 1;
        let head = 0;

        while (head < queue.length) {
          const [cx, cy] = queue[head++];

          minCellX = Math.min(minCellX, cx);
          maxCellX = Math.max(maxCellX, cx);
          minCellY = Math.min(minCellY, cy);
          maxCellY = Math.max(maxCellY, cy);

          // Check 4-connected neighbors
          const neighbors = [
            [cx + 1, cy],
            [cx - 1, cy],
            [cx, cy + 1],
            [cx, cy - 1],
          ];

          neighbors.forEach(([nx, ny]) => {
            if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
              const nIdx = ny * gridW + nx;
              if (grid[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          });
        }

        // Convert grid cell coordinates back to original pixel coordinates
        const x = minCellX * step;
        const y = minCellY * step;
        const w = (maxCellX - minCellX + 1) * step;
        const h = (maxCellY - minCellY + 1) * step;

        // Skip tiny elements (noise filter)
        if (w >= minSizeThreshold && h >= minSizeThreshold) {
          initialBoxes.push({ x, y, width: Math.min(width - x, w), height: Math.min(height - y, h) });
        }
      }
    }
  }

  // Iteratively merge boxes that are closer than mergeDistance
  let mergedBoxes = [...initialBoxes];
  let hasMerged = true;

  const boxesDistance = (b1: Rect, b2: Rect): number => {
    // Horizontal gap
    const xGap = b1.x + b1.width < b2.x 
      ? b2.x - (b1.x + b1.width) 
      : b2.x + b2.width < b1.x 
        ? b1.x - (b2.x + b2.width) 
        : 0;

    // Vertical gap
    const yGap = b1.y + b1.height < b2.y 
      ? b2.y - (b1.y + b1.height) 
      : b2.y + b2.height < b1.y 
        ? b1.y - (b2.y + b2.height) 
        : 0;

    // If they overlap on projection, the distance is the gap on the other axis
    if (xGap === 0) return yGap;
    if (yGap === 0) return xGap;
    // Otherwise, Euclidean gap distance
    return Math.sqrt(xGap * xGap + yGap * yGap);
  };

  while (hasMerged) {
    hasMerged = false;
    const nextList: Rect[] = [];
    const skipped = new Set<number>();

    for (let i = 0; i < mergedBoxes.length; i++) {
      if (skipped.has(i)) continue;
      let currentBox = mergedBoxes[i];

      for (let j = i + 1; j < mergedBoxes.length; j++) {
        if (skipped.has(j)) continue;
        const targetBox = mergedBoxes[j];

        if (boxesDistance(currentBox, targetBox) <= mergeDistance) {
          // Merge them!
          const x = Math.min(currentBox.x, targetBox.x);
          const y = Math.min(currentBox.y, targetBox.y);
          const r = Math.max(currentBox.x + currentBox.width, targetBox.x + targetBox.width);
          const b = Math.max(currentBox.y + currentBox.height, targetBox.y + targetBox.height);
          
          currentBox = { x, y, width: r - x, height: b - y };
          skipped.add(j);
          hasMerged = true;
        }
      }
      nextList.push(currentBox);
    }
    mergedBoxes = nextList;
  }

  return mergedBoxes.map(box => {
    const trimmed = trimTransparentMargins(imageData, box, alphaThreshold);
    const pad = paddingAmount;
    const x = Math.max(0, trimmed.x - pad);
    const y = Math.max(0, trimmed.y - pad);
    const w = Math.min(width - x, trimmed.width + pad * 2);
    const h = Math.min(height - y, trimmed.height + pad * 2);
    return { x, y, width: w, height: h };
  });
}

/**
 * Extracts a cropped ImageData region from a source ImageData without needing an intermediate Canvas.
 */
export function cropImageData(source: ImageData, rect: Rect): ImageData {
  const cropped = new ImageData(rect.width, rect.height);
  const srcData = source.data;
  const dstData = cropped.data;
  
  for (let y = 0; y < rect.height; y++) {
    const srcY = rect.y + y;
    if (srcY < 0 || srcY >= source.height) continue;
    
    for (let x = 0; x < rect.width; x++) {
      const srcX = rect.x + x;
      if (srcX < 0 || srcX >= source.width) continue;
      
      const srcIdx = (srcY * source.width + srcX) * 4;
      const dstIdx = (y * rect.width + x) * 4;
      
      dstData[dstIdx] = srcData[srcIdx];
      dstData[dstIdx + 1] = srcData[srcIdx + 1];
      dstData[dstIdx + 2] = srcData[srcIdx + 2];
      dstData[dstIdx + 3] = srcData[srcIdx + 3];
    }
  }
  return cropped;
}

/**
 * Removes fragments of neighboring objects from a rect crop.
 * A connected component is foreign when it touches the crop border and continues
 * in the source image beyond the rect (by more than `overhang` px) — meaning the
 * rect sliced through an object that mostly lies outside it. Components that end
 * at the border (the selected object under a tight/trimmed rect) are kept.
 */
export function removeForeignFragments(
  cropped: ImageData,
  source: ImageData,
  rect: Rect,
  alphaThreshold = 20,
  overhang = 3
): ImageData {
  const { width: sw, height: sh, data: src } = source;
  const rx0 = Math.max(0, rect.x);
  const ry0 = Math.max(0, rect.y);
  const rx1 = Math.min(sw - 1, rect.x + rect.width - 1);
  const ry1 = Math.min(sh - 1, rect.y + rect.height - 1);
  if (rx1 < rx0 || ry1 < ry0) return cropped;

  // BFS is bounded to the rect grown by overhang+1 — cost stays local to the crop
  const ex0 = Math.max(0, rx0 - overhang - 1);
  const ey0 = Math.max(0, ry0 - overhang - 1);
  const ex1 = Math.min(sw - 1, rx1 + overhang + 1);
  const ey1 = Math.min(sh - 1, ry1 + overhang + 1);
  const ew = ex1 - ex0 + 1;
  const eh = ey1 - ey0 + 1;

  const visited = new Uint8Array(ew * eh);
  const stack: number[] = [];
  const component: number[] = [];

  const isOpaque = (x: number, y: number) => src[(y * sw + x) * 4 + 3] >= alphaThreshold;

  // A deliberately cropped fragment of a large object is itself "escaping"; never
  // erase a component that makes up the bulk of the crop's content.
  let opaqueTotal = 0;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      if (isOpaque(x, y)) opaqueTotal++;
    }
  }
  if (opaqueTotal === 0) return cropped;

  const collectBorderSeeds: [number, number][] = [];
  for (let x = rx0; x <= rx1; x++) {
    collectBorderSeeds.push([x, ry0], [x, ry1]);
  }
  for (let y = ry0 + 1; y < ry1; y++) {
    collectBorderSeeds.push([rx0, y], [rx1, y]);
  }

  for (const [bx, by] of collectBorderSeeds) {
    const seedIdx = (by - ey0) * ew + (bx - ex0);
    if (visited[seedIdx] || !isOpaque(bx, by)) continue;

    // Flood this component within the expanded window
    component.length = 0;
    stack.length = 0;
    stack.push(seedIdx);
    visited[seedIdx] = 1;
    let escapes = false;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      component.push(idx);
      const cx = (idx % ew) + ex0;
      const cy = Math.floor(idx / ew) + ey0;
      if (cx < rx0 - overhang || cx > rx1 + overhang || cy < ry0 - overhang || cy > ry1 + overhang) {
        escapes = true; // reached beyond the tolerated overhang → object continues outside
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < ex0 || nx > ex1 || ny < ey0 || ny > ey1) continue;
          const nIdx = (ny - ey0) * ew + (nx - ex0);
          if (!visited[nIdx] && isOpaque(nx, ny)) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }

    if (escapes) {
      let inCrop = 0;
      for (const idx of component) {
        const cx = (idx % ew) + ex0;
        const cy = Math.floor(idx / ew) + ey0;
        if (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) inCrop++;
      }
      if (inCrop >= opaqueTotal * 0.5) continue; // bulk of the crop — this is the subject

      for (const idx of component) {
        const cx = (idx % ew) + ex0;
        const cy = Math.floor(idx / ew) + ey0;
        if (cx < rx0 || cx > rx1 || cy < ry0 || cy > ry1) continue;
        const px = cx - rect.x;
        const py = cy - rect.y;
        cropped.data[(py * cropped.width + px) * 4 + 3] = 0;
      }
    }
  }
  return cropped;
}

/**
 * Trims empty transparent border pixels from an image region, returning a tighter crop bounding box.
 */
export function trimTransparentMargins(
  imageData: ImageData,
  rect: Rect,
  alphaThreshold = 1
): Rect {
  const { width, height, data } = imageData;
  
  const startX = Math.max(0, rect.x);
  const startY = Math.max(0, rect.y);
  const endX = Math.min(width, rect.x + rect.width);
  const endY = Math.min(height, rect.y + rect.height);

  let minX = endX;
  let maxX = startX;
  let minY = endY;
  let maxY = startY;
  let hasContent = false;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] >= alphaThreshold) { // If pixel has content (not transparent)
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasContent) {
    return rect; // Keep original if completely empty
  }

  // Add 1px safety padding, clamping symmetrically
  const padding = 1;
  const rx = Math.max(startX, minX - padding);
  const ry = Math.max(startY, minY - padding);
  const rMaxX = Math.min(endX - 1, maxX + padding);
  const rMaxY = Math.min(endY - 1, maxY + padding);
  
  const rw = rMaxX - rx + 1;
  const rh = rMaxY - ry + 1;

  return { x: rx, y: ry, width: rw, height: rh };
}

/**
 * Ramer-Douglas-Peucker algorithm for polyline/contour simplification.
 * Reduces SVG file size while preserving high visual shape fidelity.
 */
export function simplifyPoints(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length <= 2) return points;

  let dmax = 0;
  let index = 0;
  const end = points.length - 1;

  const getOrthoDist = (p: [number, number], lineStart: [number, number], lineEnd: [number, number]): number => {
    const [px, py] = p;
    const [sx, sy] = lineStart;
    const [ex, ey] = lineEnd;

    const normal = Math.sqrt(Math.pow(ex - sx, 2) + Math.pow(ey - sy, 2));
    if (normal === 0) return Math.sqrt(Math.pow(px - sx, 2) + Math.pow(py - sy, 2));

    return Math.abs((px - sx) * (ey - sy) - (py - sy) * (ex - sx)) / normal;
  };

  for (let i = 1; i < end; i++) {
    const d = getOrthoDist(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const results1 = simplifyPoints(points.slice(0, index + 1), epsilon);
    const results2 = simplifyPoints(points.slice(index), epsilon);
    return results1.slice(0, results1.length - 1).concat(results2);
  }

  return [points[0], points[end]];
}

/**
 * Robust contour tracing algorithm based on Moore-Neighbor Tracing (8-connected).
 * Extracts boundary polygons of alpha channel islands to build SVG paths.
 */
export function traceContours(imageData: ImageData, alphaThreshold = 127): [number, number][][] {
  const { width, height, data } = imageData;
  const visited = new Uint8Array(width * height);
  const contours: [number, number][][] = [];

  // Helper to check transparency bounds
  const isOpaque = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return data[(y * width + x) * 4 + 3] >= alphaThreshold;
  };

  // Neighborhood search offset list (8 directions clockwise starting from Top-Left)
  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [1, 0],   [1, 1],  [0, 1],
    [-1, 1],  [-1, 0]
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      // Look for a transition from transparent to opaque (potential outer boundary starting point)
      if (isOpaque(x, y) && !isOpaque(x - 1, y) && visited[idx] === 0) {
        // Start tracing contour
        const contour: [number, number][] = [[x, y]];
        visited[idx] = 1;

        // Trace boundary loop
        let cx = x;
        let cy = y;
        
        // Initial backtrack is to the left (transparent cell)
        let backdir = 7; // direction pointing to (cx - 1, cy - 1) or left
        let startDir = 7;
        let loopEnded = false;
        let iterLimit = width * height; // safety limit to prevent infinite loops

        let secondX = -1;
        let secondY = -1;

        while (!loopEnded && iterLimit-- > 0) {
          let foundNext = false;
          
          // Probe all 8 directions clockwise from the backtracked direction
          for (let d = 0; d < 8; d++) {
            const checkDir = (backdir + d) % 8;
            const nx = cx + dirs[checkDir][0];
            const ny = cy + dirs[checkDir][1];

            if (isOpaque(nx, ny)) {
              if (cx === x && cy === y && nx === secondX && ny === secondY) {
                loopEnded = true;
                break;
              }

              if (contour.length === 1) {
                secondX = nx;
                secondY = ny;
              }

              cx = nx;
              cy = ny;
              contour.push([cx, cy]);
              visited[cy * width + cx] = 1;

              // Update backtrack direction to point to previous pixel
              backdir = (checkDir + 5) % 8; // (checkDir + 180 degrees) clockwise
              foundNext = true;
              break;
            }
          }

          if (loopEnded) {
            break;
          }

          if (!foundNext) {
            // Isolate single pixel component
            break;
          }
        }

        if (contour.length > 2) {
          // Simplify the contour lines to reduce vertex count (epsilon = 0.8 pixel deviation)
          const simplified = simplifyPoints(contour, 0.7);
          contours.push(simplified);
        }
      }
    }
  }

  return contours;
}

/**
 * Builds a vector SVG for a monochrome silhouette of the asset.
 */
export function generateSilhouetteSvg(imageData: ImageData, fillStyle = '#1f2937'): string {
  const { width, height } = imageData;
  const contours = traceContours(imageData, 120);

  if (contours.length === 0) {
    // Fallback if no contours found
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <!-- No contour data could be extracted -->
</svg>`;
  }

  // Map contours to SVG path d="..." string
  let pathD = '';
  contours.forEach(contour => {
    if (contour.length < 3) return;
    pathD += ` M ${contour[0][0]} ${contour[0][1]}`;
    for (let i = 1; i < contour.length; i++) {
      pathD += ` L ${contour[i][0]} ${contour[i][1]}`;
    }
    pathD += ' Z';
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <path d="${pathD.trim()}" fill="${fillStyle}" fill-rule="evenodd" />
</svg>`;
}

/**
 * Multi-color vectorization using color quantization/posterization + contour tracing.
 */
export function generateColorLayersSvg(imageData: ImageData, targetColorsCount = 4): string {
  const { width, height, data } = imageData;

  // 1. Quantize colors. Find top dominant RGB colors excluding fully transparent pixels.
  const colorBuckets: { [key: string]: { sumR: number; sumG: number; sumB: number; count: number } } = {};
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a < 100) continue; // Skip mostly transparent

    // Quantize heavily to group similar colors
    const qr = Math.round(r / 32) * 32;
    const qg = Math.round(g / 32) * 32;
    const qb = Math.round(b / 32) * 32;
    const key = `${qr},${qg},${qb}`;

    if (colorBuckets[key]) {
      colorBuckets[key].sumR += r;
      colorBuckets[key].sumG += g;
      colorBuckets[key].sumB += b;
      colorBuckets[key].count++;
    } else {
      colorBuckets[key] = { sumR: r, sumG: g, sumB: b, count: 1 };
    }
  }

  // Sort colors by abundance
  const sortedColors = Object.values(colorBuckets)
    .sort((a, b) => b.count - a.count)
    .slice(0, targetColorsCount)
    .map(bucket => ({
      r: Math.round(bucket.sumR / bucket.count),
      g: Math.round(bucket.sumG / bucket.count),
      b: Math.round(bucket.sumB / bucket.count),
    }));

  if (sortedColors.length === 0) {
    return generateSilhouetteSvg(imageData);
  }

  // Helper to format color to hex
  const rgbToHex = (c: ColorRGB) => {
    const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
  };

  // Pre-allocate masks for each color
  const colorMasks = sortedColors.map(() => new Uint8ClampedArray(width * height * 4));

  // Single pass to assign each pixel to its closest color mask
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 100) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    let bestColorIdx = -1;
    let minDist = Infinity;

    for (let j = 0; j < sortedColors.length; j++) {
      const color = sortedColors[j];
      const dist = (r - color.r) * (r - color.r) + 
                   (g - color.g) * (g - color.g) + 
                   (b - color.b) * (b - color.b); // Compare squared distance
      if (dist < minDist) {
        minDist = dist;
        bestColorIdx = j;
      }
    }

    if (bestColorIdx !== -1 && minDist < 14400) { // 120^2
      const maskData = colorMasks[bestColorIdx];
      const color = sortedColors[bestColorIdx];
      maskData[i] = color.r;
      maskData[i + 1] = color.g;
      maskData[i + 2] = color.b;
      maskData[i + 3] = 255;
    }
  }

  // For each quantized color, trace its mask contours
  let svgPaths = '';

  sortedColors.forEach((color, idx) => {
    const maskData = colorMasks[idx];
    const maskImgData = new ImageData(maskData, width, height);
    const contours = traceContours(maskImgData, 120);

    if (contours.length > 0) {
      let pathD = '';
      contours.forEach(contour => {
        if (contour.length < 3) return;
        pathD += ` M ${contour[0][0]} ${contour[0][1]}`;
        for (let i = 1; i < contour.length; i++) {
          pathD += ` L ${contour[i][0]} ${contour[i][1]}`;
        }
        pathD += ' Z';
      });

      const hex = rgbToHex(color);
      svgPaths += `  <path d="${pathD.trim()}" fill="${hex}" fill-rule="evenodd" />\n`;
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${svgPaths.trimEnd()}
</svg>`;
}

/**
 * Encapsulates the cropped high-quality transparent PNG in a scalable SVG wrapper.
 */
export function generateEmbeddedSvg(width: number, height: number, pngDataUrl: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <image href="${pngDataUrl}" x="0" y="0" width="${width}" height="${height}" />
</svg>`;
}

function boxBlurFloat(input: Float32Array, output: Float32Array, width: number, height: number) {
  const temp = new Float32Array(width * height);
  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) {
          sum += input[y * width + nx];
          count++;
        }
      }
      temp[y * width + x] = sum / count;
    }
  }
  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < height) {
          sum += temp[ny * width + x];
          count++;
        }
      }
      output[y * width + x] = sum / count;
    }
  }
}

