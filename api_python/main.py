import io
import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

app = FastAPI(title="Asset Cleaner API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def apply_smart_edge_cleanup(img: np.ndarray, erode_amount: int = 1) -> np.ndarray:
    out = img.copy()
    h, w = out.shape[:2]
    alpha = out[:, :, 3].astype(np.float32)

    # Step 1: Smooth Alpha Erosion — shrink mask near transparent boundaries
    if erode_amount > 0:
        kernel_size = erode_amount * 2 + 1
        is_transparent = (alpha == 0).astype(np.float32)
        kernel = np.ones((kernel_size, kernel_size), dtype=np.float32)
        kernel[kernel_size//2, kernel_size//2] = 0
        # BORDER_REPLICATE: don't treat image edges as transparent
        transparent_neighbors = cv2.filter2D(is_transparent, -1, kernel, borderType=cv2.BORDER_REPLICATE)
        total_neighbors = kernel_size * kernel_size - 1

        ratio = 1.0 - (transparent_neighbors / total_neighbors) * 0.7
        ratio = np.clip(ratio, 0, 1)

        mask = alpha > 0
        new_alpha = alpha.copy()
        new_alpha[mask] = alpha[mask] * ratio[mask]
        out[:, :, 3] = np.clip(np.round(new_alpha), 0, 255).astype(np.uint8)

    # Step 2: Alpha Anti-Aliasing (BEFORE decontamination so new semi-transparent pixels get cleaned)
    alpha = out[:, :, 3].astype(np.float32)
    is_not_255 = (alpha < 255).astype(np.uint8)
    has_not_255_neighbor = cv2.dilate(is_not_255, np.ones((3, 3), np.uint8))
    is_edge = ((alpha > 0) & (alpha < 255)) | ((alpha == 255) & (has_not_255_neighbor == 1))

    # Weighted 3x3 smooth with REPLICATE border to avoid pulling in zeros from outside
    kernel = np.ones((3, 3), np.float32)
    kernel[1, 1] = 4
    kernel = kernel / 12.0

    smoothed_alpha = cv2.filter2D(alpha, -1, kernel, borderType=cv2.BORDER_REPLICATE)
    # Clamp: don't let AA increase alpha beyond original (prevents outward bleed)
    clamped = np.minimum(smoothed_alpha, alpha)
    out[:, :, 3] = np.where(is_edge, np.clip(np.round(clamped), 0, 255).astype(np.uint8), out[:, :, 3])

    # Step 3: Color Decontamination — replace semi-transparent edge pixel colors
    # with nearest fully opaque foreground color (NOT dilation which pulls background)
    final_alpha = out[:, :, 3]
    opaque_mask = (final_alpha >= 240)

    if np.any(opaque_mask):
        # Build distance map from opaque pixels — every semi-transparent pixel finds nearest opaque
        not_opaque = (~opaque_mask).astype(np.uint8)
        dist, labels = cv2.distanceTransformWithLabels(not_opaque, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)

        # labels maps each pixel to the index (in raster order) of the nearest opaque pixel
        # Only apply to semi-transparent pixels near the background edge
        bg_mask = (final_alpha == 0).astype(np.uint8)
        near_bg = cv2.dilate(bg_mask, np.ones((7, 7), np.uint8))
        semi_trans = (final_alpha > 0) & (final_alpha < 240)
        cond = semi_trans & (near_bg == 1) & (dist <= 6)

        if np.any(cond):
            ys, xs = np.where(cond)
            source_indices = labels[ys, xs]
            src_y = (source_indices - 1) // w
            src_x = (source_indices - 1) % w
            src_y = np.clip(src_y, 0, h - 1)
            src_x = np.clip(src_x, 0, w - 1)
            out[ys, xs, 0] = out[src_y, src_x, 0]
            out[ys, xs, 1] = out[src_y, src_x, 1]
            out[ys, xs, 2] = out[src_y, src_x, 2]

    return out

@app.post("/api/clean-asset")
async def clean_asset(image: UploadFile = File(...)):
    try:
        contents = await image.read()
        pil_image = Image.open(io.BytesIO(contents)).convert("RGBA")
        np_image = np.array(pil_image)
        
        # Process image
        processed_np = apply_smart_edge_cleanup(np_image, erode_amount=1)
        
        processed_pil = Image.fromarray(processed_np, "RGBA")
        
        img_byte_arr = io.BytesIO()
        processed_pil.save(img_byte_arr, format='PNG')
        img_byte_arr = img_byte_arr.getvalue()

        return Response(content=img_byte_arr, media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3000, reload=True)
