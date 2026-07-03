use axum::{
    extract::Multipart,
    http::{header, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use image::{ImageFormat, RgbaImage};
use std::io::Cursor;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/api/clean-asset", post(clean_asset_handler))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://0.0.0.0:3000");
    axum::serve(listener, app).await.unwrap();
}

async fn clean_asset_handler(mut multipart: Multipart) -> impl IntoResponse {
    let mut image_data = None;

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        if field.name() == Some("image") {
            let data = field.bytes().await.unwrap();
            image_data = Some(data);
        }
    }

    if let Some(data) = image_data {
        match process_image(&data) {
            Ok(output_bytes) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "image/png")],
                    output_bytes,
                ).into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to process image: {}", e),
                ).into_response();
            }
        }
    }

    (StatusCode::BAD_REQUEST, "Missing 'image' field").into_response()
}

fn process_image(data: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let img = image::load_from_memory(data)?;
    let mut rgba_img = img.to_rgba8();

    let erode_amount = 1;
    rgba_img = apply_smart_edge_cleanup(rgba_img, erode_amount);

    let mut output = Cursor::new(Vec::new());
    rgba_img.write_to(&mut output, ImageFormat::Png)?;

    Ok(output.into_inner())
}

fn apply_smart_edge_cleanup(mut img: RgbaImage, erode_amount: i32) -> RgbaImage {
    let (width, height) = img.dimensions();
    let width = width as i32;
    let height = height as i32;
    
    // Step 1: Smooth Alpha Erosion
    if erode_amount > 0 {
        let mut out_img = img.clone();
        for y in 0..height {
            for x in 0..width {
                let pixel = img.get_pixel(x as u32, y as u32);
                let alpha = pixel[3];
                if alpha > 0 {
                    let mut near_transparent_count = 0;
                    let mut total_checked = 0;

                    for dy in -erode_amount..=erode_amount {
                        for dx in -erode_amount..=erode_amount {
                            if dx == 0 && dy == 0 {
                                continue;
                            }
                            let nx = x + dx;
                            let ny = y + dy;
                            total_checked += 1;
                            
                            if nx >= 0 && nx < width && ny >= 0 && ny < height {
                                let npixel = img.get_pixel(nx as u32, ny as u32);
                                if npixel[3] == 0 {
                                    near_transparent_count += 1;
                                }
                            } else {
                                near_transparent_count += 1;
                            }
                        }
                    }

                    if near_transparent_count > 0 {
                        let ratio = 1.0 - (near_transparent_count as f32 / total_checked as f32) * 0.7;
                        let new_alpha = (alpha as f32 * ratio).round() as u8;
                        let mut p = *pixel;
                        p[3] = new_alpha.max(0);
                        out_img.put_pixel(x as u32, y as u32, p);
                    }
                }
            }
        }
        img = out_img;
    }

    let eroded_src = img.clone();

    // Step 2: Intelligent Color Decontamination
    let search_radius = 4;
    for y in 0..height {
        for x in 0..width {
            let mut pixel = *eroded_src.get_pixel(x as u32, y as u32);
            let alpha = pixel[3];

            if alpha > 0 && alpha < 240 {
                let mut is_near_bg = false;
                let boundary_radius = 3;
                
                for dy in -boundary_radius..=boundary_radius {
                    for dx in -boundary_radius..=boundary_radius {
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx >= 0 && nx < width && ny >= 0 && ny < height {
                            if eroded_src.get_pixel(nx as u32, ny as u32)[3] == 0 {
                                is_near_bg = true;
                                break;
                            }
                        } else {
                            is_near_bg = true;
                            break;
                        }
                    }
                    if is_near_bg { break; }
                }

                if is_near_bg {
                    let mut best_x = -1;
                    let mut best_y = -1;
                    let mut min_dist = i32::MAX;

                    for dy in -search_radius..=search_radius {
                        for dx in -search_radius..=search_radius {
                            if dx == 0 && dy == 0 { continue; }
                            let nx = x + dx;
                            let ny = y + dy;
                            if nx >= 0 && nx < width && ny >= 0 && ny < height {
                                if eroded_src.get_pixel(nx as u32, ny as u32)[3] >= 240 {
                                    let d = dx * dx + dy * dy;
                                    if d < min_dist {
                                        min_dist = d;
                                        best_x = nx;
                                        best_y = ny;
                                    }
                                }
                            }
                        }
                    }

                    if best_x != -1 {
                        let best_pixel = eroded_src.get_pixel(best_x as u32, best_y as u32);
                        pixel[0] = best_pixel[0];
                        pixel[1] = best_pixel[1];
                        pixel[2] = best_pixel[2];
                        img.put_pixel(x as u32, y as u32, pixel);
                    }
                }
            }
        }
    }

    // Step 3: High-Quality Alpha Anti-Aliasing (Smoothing)
    let temp_alphas = img.clone();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let pixel = *temp_alphas.get_pixel(x as u32, y as u32);
            let alpha = pixel[3];

            let mut is_edge = false;
            if alpha > 0 && alpha < 255 {
                is_edge = true;
            } else if alpha == 255 {
                if temp_alphas.get_pixel((x - 1) as u32, y as u32)[3] < 255 ||
                   temp_alphas.get_pixel((x + 1) as u32, y as u32)[3] < 255 ||
                   temp_alphas.get_pixel(x as u32, (y - 1) as u32)[3] < 255 ||
                   temp_alphas.get_pixel(x as u32, (y + 1) as u32)[3] < 255 {
                    is_edge = true;
                }
            }

            if is_edge {
                let mut alpha_sum = 0;
                let mut weight_sum = 0;

                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let weight = if dx == 0 && dy == 0 { 4 } else { 1 };
                        let n_alpha = temp_alphas.get_pixel((x + dx) as u32, (y + dy) as u32)[3];
                        alpha_sum += n_alpha as i32 * weight;
                        weight_sum += weight;
                    }
                }

                let new_alpha = (alpha_sum as f32 / weight_sum as f32).round() as u8;
                let mut p = *img.get_pixel(x as u32, y as u32);
                p[3] = new_alpha;
                img.put_pixel(x as u32, y as u32, p);
            }
        }
    }

    img
}
