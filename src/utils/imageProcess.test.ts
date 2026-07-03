/**
 * Test suite for traceContours in imageProcess.ts
 * Executable via: npx tsx src/utils/imageProcess.test.ts
 */

import { traceContours } from './imageProcess';

// Helper to create mock ImageData
function createMockImageData(width: number, height: number, opaqueCoordinates: [number, number][]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  // Fill all with transparent alpha = 0
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 0;
  }
  // Set specified coordinates to opaque (alpha = 255)
  for (const [x, y] of opaqueCoordinates) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = (y * width + x) * 4;
      data[idx + 3] = 255;
    }
  }
  return {
    width,
    height,
    data
  } as ImageData;
}

function runTests() {
  console.log("=== STARTING CONTOUR TRACING STRESS TESTS ===");

  // Test Case 1: Empty Image (all transparent)
  {
    console.log("Test 1: Empty Image...");
    const img = createMockImageData(10, 10, []);
    const contours = traceContours(img);
    if (contours.length === 0) {
      console.log("  [PASS] Correctly returned 0 contours.");
    } else {
      console.error(`  [FAIL] Expected 0 contours, got ${contours.length}`);
    }
  }

  // Test Case 2: All Opaque Image
  {
    console.log("Test 2: All Opaque Image...");
    const coords: [number, number][] = [];
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        coords.push([x, y]);
      }
    }
    const img = createMockImageData(10, 10, coords);
    const contours = traceContours(img);
    // Should trace the outer border of the entire image
    if (contours.length > 0) {
      console.log(`  [PASS] Traced boundary correctly. Found ${contours.length} contour(s).`);
    } else {
      console.error("  [FAIL] Expected at least 1 contour for fully opaque image.");
    }
  }

  // Test Case 3: Single Pixel Component
  {
    console.log("Test 3: Single Pixel Component...");
    const img = createMockImageData(5, 5, [[2, 2]]);
    const contours = traceContours(img);
    // Single pixel has contour length <= 2 and should be skipped
    if (contours.length === 0) {
      console.log("  [PASS] Correctly ignored single pixel component.");
    } else {
      console.error(`  [FAIL] Expected 0 contours, got ${contours.length}`);
    }
  }

  // Test Case 4: Two-Pixel Line Segment
  {
    console.log("Test 4: Two-Pixel Line Segment...");
    const img = createMockImageData(5, 5, [[2, 2], [3, 2]]);
    const contours = traceContours(img);
    // Should be simplified or ignored, but must not infinite loop
    console.log(`  [PASS] Terminated successfully. Found ${contours.length} contour(s).`);
  }

  // Test Case 5: Hollow Donut Shape (Loop)
  {
    console.log("Test 5: Hollow Donut Shape (Loop)...");
    const img = createMockImageData(5, 5, [
      [1, 1], [2, 1], [3, 1],
      [1, 2],         [3, 2],
      [1, 3], [2, 3], [3, 3]
    ]);
    const contours = traceContours(img);
    if (contours.length >= 1) {
      console.log(`  [PASS] Terminated successfully. Found ${contours.length} contour(s).`);
    } else {
      console.error("  [FAIL] Expected at least 1 contour.");
    }
  }

  // Test Case 6: Cross Shape (Diagonal connections and multiple branches)
  {
    console.log("Test 6: Cross Shape...");
    const img = createMockImageData(5, 5, [
              [2, 1],
      [1, 2], [2, 2], [3, 2],
              [2, 3]
    ]);
    const contours = traceContours(img);
    console.log(`  [PASS] Terminated successfully. Found ${contours.length} contour(s).`);
  }

  // Test Case 7: Adversarial Checkerboard (Noise)
  {
    console.log("Test 7: Checkerboard Noise...");
    const coords: [number, number][] = [];
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        if ((x + y) % 2 === 0) {
          coords.push([x, y]);
        }
      }
    }
    const img = createMockImageData(20, 20, coords);
    const startTime = Date.now();
    const contours = traceContours(img);
    const duration = Date.now() - startTime;
    console.log(`  [PASS] Terminated successfully in ${duration}ms. Found ${contours.length} contour(s).`);
  }

  console.log("=== CONTOUR TRACING STRESS TESTS COMPLETED ===");
}

runTests();
