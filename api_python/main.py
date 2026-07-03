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
    alpha = out[:, :, 3].astype(np.float32)

    # Step 1: Smooth Alpha Erosion
    if erode_amount > 0:
        kernel_size = erode_amount * 2 + 1
        is_transparent = (alpha == 0).astype(np.float32)
        kernel = np.ones((kernel_size, kernel_size), dtype=np.float32)
        kernel[kernel_size//2, kernel_size//2] = 0
        transparent_neighbors = cv2.filter2D(is_transparent, -1, kernel, borderType=cv2.BORDER_CONSTANT)
        total_neighbors = kernel_size * kernel_size - 1
        
        ratio = 1.0 - (transparent_neighbors / total_neighbors) * 0.7
        ratio = np.clip(ratio, 0, 1)
        
        mask = alpha > 0
        new_alpha = alpha.copy()
        new_alpha[mask] = alpha[mask] * ratio[mask]
        out[:, :, 3] = np.clip(np.round(new_alpha), 0, 255).astype(np.uint8)

    eroded_alpha = out[:, :, 3].copy()

    # Step 2: Intelligent Color Decontamination
    opaque_mask = (eroded_alpha >= 240).astype(np.uint8)
    
    if np.any(opaque_mask):
        bgr = out[:, :, :3]
        dilated_bgr = bgr.copy()
        for _ in range(4): 
            kernel = np.ones((3, 3), np.uint8)
            dilated_r = cv2.dilate(dilated_bgr[:, :, 0], kernel)
            dilated_g = cv2.dilate(dilated_bgr[:, :, 1], kernel)
            dilated_b = cv2.dilate(dilated_bgr[:, :, 2], kernel)
            
            update_mask = (opaque_mask == 0)
            dilated_bgr[:, :, 0][update_mask] = dilated_r[update_mask]
            dilated_bgr[:, :, 1][update_mask] = dilated_g[update_mask]
            dilated_bgr[:, :, 2][update_mask] = dilated_b[update_mask]
        
        bg_mask = (eroded_alpha == 0).astype(np.uint8)
        near_bg = cv2.dilate(bg_mask, np.ones((7, 7), np.uint8))
        semi_trans = ((eroded_alpha > 0) & (eroded_alpha < 240)).astype(np.uint8)
        cond = (semi_trans == 1) & (near_bg == 1)
        out[:, :, :3][cond] = dilated_bgr[cond]

    # Step 3: High-Quality Alpha Anti-Aliasing
    alpha = out[:, :, 3].astype(np.float32)
    is_not_255 = (alpha < 255).astype(np.uint8)
    has_not_255_neighbor = cv2.dilate(is_not_255, np.ones((3, 3), np.uint8))
    is_edge = ((alpha > 0) & (alpha < 255)) | ((alpha == 255) & (has_not_255_neighbor == 1))
    
    kernel = np.ones((3, 3), np.float32)
    kernel[1, 1] = 4
    kernel = kernel / 12.0
    
    smoothed_alpha = cv2.filter2D(alpha, -1, kernel, borderType=cv2.BORDER_REPLICATE)
    out[:, :, 3] = np.where(is_edge, np.clip(np.round(smoothed_alpha), 0, 255).astype(np.uint8), out[:, :, 3])

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
