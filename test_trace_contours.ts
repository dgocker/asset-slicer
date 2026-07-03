import { traceContours } from './src/utils/imageProcess';

// Mock ImageData
function createMockImageData(width: number, height: number, opaqueCoords: [number, number][]): any {
  const data = new Uint8ClampedArray(width * height * 4);
  // Default to transparent (0 alpha)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;     // R
    data[i+1] = 0;   // G
    data[i+2] = 0;   // B
    data[i+3] = 0;   // A
  }

  // Set opaque pixels (alpha = 255)
  for (const [x, y] of opaqueCoords) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = (y * width + x) * 4;
      data[idx] = 255;
      data[idx+1] = 255;
      data[idx+2] = 255;
      data[idx+3] = 255;
    }
  }

  return { width, height, data };
}

function runTest(name: string, width: number, height: number, opaqueCoords: [number, number][]) {
  console.log(`Running test: ${name}`);
  const imgData = createMockImageData(width, height, opaqueCoords);
  const start = Date.now();
  try {
    const contours = traceContours(imgData, 120);
    const duration = Date.now() - start;
    console.log(`  Success! Found ${contours.length} contours in ${duration}ms`);
    for (let i = 0; i < contours.length; i++) {
      console.log(`  Contour ${i}: length = ${contours[i].length}, points = ${JSON.stringify(contours[i])}`);
    }
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }
  console.log('----------------------------------------');
}

// 1. Simple 3x3 square
runTest('Solid 3x3 Square', 5, 5, [
  [1, 1], [2, 1], [3, 1],
  [1, 2], [2, 2], [3, 2],
  [1, 3], [2, 3], [3, 3]
]);

// 2. Single isolated pixel
runTest('Single Pixel', 3, 3, [
  [1, 1]
]);

// 3. Horizontal line
runTest('Horizontal Line', 5, 3, [
  [1, 1], [2, 1], [3, 1]
]);

// 4. Bowtie (Pinch Point) sharing (2,2)
// Row 0: 1 1 1 0 0
// Row 1: 1 1 1 0 0
// Row 2: 0 0 1 0 0
// Row 3: 0 0 1 1 1
// Row 4: 0 0 1 1 1
runTest('Bowtie Pinch Point', 5, 5, [
  [0, 0], [1, 0], [2, 0],
  [0, 1], [1, 1], [2, 1],
  [2, 2],
  [2, 3], [3, 3], [4, 3],
  [2, 4], [3, 4], [4, 4]
]);

// 5. Hole inside a square (hollow box)
runTest('Hollow Box', 5, 5, [
  [1, 1], [2, 1], [3, 1],
  [1, 2],         [3, 2],
  [1, 3], [2, 3], [3, 3]
]);

// 6. Chessboard 2x2 pattern
runTest('Chessboard 2x2', 4, 4, [
  [0, 0], [2, 0],
  [1, 1], [3, 1],
  [0, 2], [2, 2],
  [1, 3], [3, 3]
]);

// 7. Large complex shape (100x100)
const largeOpaque: [number, number][] = [];
for (let x = 10; x < 90; x++) {
  for (let y = 10; y < 90; y++) {
    // Make a circle
    const dx = x - 50;
    const dy = y - 50;
    if (dx*dx + dy*dy <= 1600) {
      largeOpaque.push([x, y]);
    }
  }
}
runTest('Large Circle (100x100)', 100, 100, largeOpaque);
