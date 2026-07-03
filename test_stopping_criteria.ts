// Comparing original vs fixed contour tracing stopping criteria with a bowtie starting at the pinch point

const dirs = [
  [-1, -1], [0, -1], [1, -1],
  [1, 0],   [1, 1],  [0, 1],
  [-1, 1],  [-1, 0]
];

function runTracingAt(
  width: number,
  height: number,
  opaqueCoords: [number, number][],
  startX: number,
  startY: number,
  useJacobsCriterion: boolean
): [number, number][] {
  const data = new Uint8Array(width * height);
  for (const [x, y] of opaqueCoords) {
    data[y * width + x] = 1;
  }

  const isOpaque = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return data[y * width + x] === 1;
  };

  const contour: [number, number][] = [[startX, startY]];
  let cx = startX;
  let cy = startY;
  let backdir = 7;
  let loopEnded = false;
  let iterLimit = 100;

  let secondX = -1;
  let secondY = -1;

  while (!loopEnded && iterLimit-- > 0) {
    let foundNext = false;
    for (let d = 0; d < 8; d++) {
      const checkDir = (backdir + d) % 8;
      const nx = cx + dirs[checkDir][0];
      const ny = cy + dirs[checkDir][1];

      if (isOpaque(nx, ny)) {
        if (useJacobsCriterion) {
          // Jacob's Stopping Criterion
          if (cx === startX && cy === startY && nx === secondX && ny === secondY) {
            loopEnded = true;
            break;
          }
        } else {
          // Old stopping criterion: terminates immediately when cx === startX && cy === startY
          // Wait, is it checked before moving or after moving?
          // If after moving (nx === startX && ny === startY), or on cx === startX && cy === startY.
          // Let's test both variants.
          if (nx === startX && ny === startY) {
            loopEnded = true;
            contour.push([nx, ny]);
            break;
          }
        }

        if (contour.length === 1) {
          secondX = nx;
          secondY = ny;
        }

        cx = nx;
        cy = ny;
        contour.push([cx, cy]);
        backdir = (checkDir + 5) % 8;
        foundNext = true;
        break;
      }
    }

    if (loopEnded) break;
    if (!foundNext) break;
  }

  return contour;
}

// Bowtie (Pinch Point) sharing (2,2)
const bowtie: [number, number][] = [
  [0, 0], [1, 0], [2, 0],
  [0, 1], [1, 1], [2, 1],
  [2, 2],
  [2, 3], [3, 3], [4, 3],
  [2, 4], [3, 4], [4, 4]
];

console.log("Tracing Bowtie starting at pinch point (2,2):");
console.log("Tracing with Old stopping criterion:");
const oldResult = runTracingAt(5, 5, bowtie, 2, 2, false);
console.log("  Result length:", oldResult.length);
console.log("  Contour:", JSON.stringify(oldResult));

console.log("\nTracing with Jacob's Stopping Criterion:");
const newResult = runTracingAt(5, 5, bowtie, 2, 2, true);
console.log("  Result length:", newResult.length);
console.log("  Contour:", JSON.stringify(newResult));
