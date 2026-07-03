import io
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import rembg
import uvicorn

app = FastAPI(title="Background Removal API")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session cache to avoid re-initializing models
sessions = {}

def get_session(model_name: str):
    if model_name not in sessions:
        print(f"Initializing rembg session for model: {model_name}...")
        try:
            sessions[model_name] = rembg.new_session(model_name)
            print(f"rembg session for {model_name} initialized successfully.")
        except Exception as e:
            print(f"Failed to initialize rembg session for {model_name}: {e}. Falling back to default model.")
            if "default" not in sessions:
                sessions["default"] = rembg.new_session()
            return sessions["default"]
    return sessions[model_name]

# Pre-initialize the default model
get_session("bria-rmbg")

@app.post("/api/remove-bg")
async def remove_background(
    model: str = "bria-rmbg",
    threshold: int = 0,
    file: UploadFile = File(...)
):
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    try:
        # Read image bytes
        contents = await file.read()
        input_image = Image.open(io.BytesIO(contents))

        # Get session for the requested model
        session = get_session(model)

        if threshold > 0:
            # Get only the mask from rembg
            mask = rembg.remove(input_image, session=session, only_mask=True)

            # Binarize the mask: if pixel > threshold, make it 255, else 0
            mask_bin = mask.point(lambda p: 255 if p > threshold else 0)

            # Apply cutout using the binarized mask to preserve original colors at the edges
            empty = Image.new("RGBA", input_image.size, 0)
            output_image = Image.composite(input_image, empty, mask_bin)
        else:
            # Process normally with soft edges
            output_image = rembg.remove(input_image, session=session)

        # Save output to bytes buffer, preserving the ICC profile
        output_buffer = io.BytesIO()
        icc_profile = input_image.info.get("icc_profile")
        if icc_profile:
            output_image.save(output_buffer, format="PNG", icc_profile=icc_profile)
        else:
            output_image.save(output_buffer, format="PNG")
        output_bytes = output_buffer.getvalue()

        return Response(content=output_bytes, media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process image: {str(e)}")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=False)
