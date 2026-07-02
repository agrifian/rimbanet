"""
RimbaNet Neural Engine v2.0 — Flask Backend
Porting dari Gradio (Google Colab) ke Flask Web App
"""

import os
import re
import cv2
import ee
import geemap
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import torchvision.transforms as transforms
import timm
import base64
from io import BytesIO
from PIL import Image, ImageDraw
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from collections import Counter
import json
import time

app = Flask(__name__)

# ── 1. AUTHENTICATION ──────────────────────────────────────────────────────────
# Credentials are loaded from the GEE_CREDENTIALS_JSON env var when present
# (used on Railway / any host where you don't want a secret file in the repo).
# If that env var isn't set, falls back to a local file for dev on your machine —
# put your service account JSON at credentials/<filename>.json and keep that
# folder in .gitignore. Never commit the JSON file itself.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

GEE_CREDENTIALS_JSON = os.environ.get('GEE_CREDENTIALS_JSON')
SA_EMAIL = os.environ.get('GEE_SA_EMAIL', 'deforestatinapi@upheld-producer-488308-q3.iam.gserviceaccount.com')

try:
    if GEE_CREDENTIALS_JSON:
        # Deployed: build credentials straight from the env var, no file needed.
        service_account_info = json.loads(GEE_CREDENTIALS_JSON)
        SA_EMAIL = service_account_info.get('client_email', SA_EMAIL)
        credentials = ee.ServiceAccountCredentials(SA_EMAIL, key_data=GEE_CREDENTIALS_JSON)
    else:
        # Local dev fallback: reads from credentials/ folder (gitignored).
        LOCAL_JSON_PATH = os.path.join(
            BASE_DIR, 'credentials', 'upheld-producer-488308-q3-9c85dc4356a4.json'
        )
        credentials = ee.ServiceAccountCredentials(SA_EMAIL, LOCAL_JSON_PATH)

    ee.Initialize(credentials)
    print("✅ Earth Engine: Online.")
    GEE_ONLINE = True
except Exception as e:
    print(f"⚠️  Earth Engine Warning: {e}")
    GEE_ONLINE = False

# ── 2. AI MODEL ────────────────────────────────────────────────────────────────
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

class DynamicDualStream(nn.Module):
    def __init__(self, backbone_name, num_classes=4):
        super().__init__()
        self.rgb_backbone = timm.create_model(backbone_name, pretrained=False, num_classes=0)
        self.ir_cnn = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True), nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True), nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(0.3)
        )
        self.fusion = nn.Sequential(
            nn.Linear(1000, 512), nn.BatchNorm1d(512), nn.ReLU(inplace=True),
            nn.Dropout(0.6), nn.Linear(512, num_classes)
        )

    def forward(self, rgb, ir):
        return self.fusion(torch.cat((self.rgb_backbone(rgb), self.ir_cnn(ir)), dim=1))

MODEL_PATH = os.path.join(BASE_DIR, 'models', 'Model_SwinV2.pth')
model = None
if os.path.exists(MODEL_PATH):
    try:
        state_dict = torch.load(MODEL_PATH, map_location=device, weights_only=False)
        dim_kabel  = state_dict['fusion.0.weight'].shape[1]
        model = DynamicDualStream("swinv2_base_window12to24_192to384.ms_in22k_ft_in1k")
        model.fusion = nn.Sequential(
            nn.Linear(dim_kabel, 512), nn.BatchNorm1d(512), nn.ReLU(inplace=True),
            nn.Dropout(0.6), nn.Linear(512, 4)
        )
        model.load_state_dict(state_dict)
        model.to(device).eval()
        print("✅ SwinV2 AI Model: Online.")
    except Exception as e:
        print(f"⚠️  Model load error: {e}")
else:
    print("⚠️  Model file not found at:", MODEL_PATH)

# ── 3. CONSTANTS ───────────────────────────────────────────────────────────────
KELAS = {0: 'Plantation', 1: 'Smallholder agriculture', 2: 'Grassland shrubland', 3: 'Other'}
WARNA_KELAS = {
    'Plantation':             '#10b981',
    'Smallholder agriculture':'#eab308',
    'Grassland shrubland':    '#f97316',
    'Other':                  '#ef4444',
}
LABEL_SINGKAT = {
    'Plantation':             'PLT',
    'Smallholder agriculture':'SHF',
    'Grassland shrubland':    'GRS',
    'Other':                  'OTH',
}
DESKRIPSI_KELAS = {
    'Plantation':             'Dense forest or structured plantations with a healthy canopy.',
    'Smallholder agriculture':'Small-scale lands with fragmented plot sizes or mixed-texture areas.',
    'Grassland shrubland':    'Open areas dominated by grasslands, shrubs, or low-lying vegetation.',
    'Other':                  'Barren land, deforested areas, cleared sites, or infrastructure.',
}
TILE_SIZE = 384

# ── 4. IMAGE HELPERS ───────────────────────────────────────────────────────────
def stretch_channel(arr):
    p2, p98 = np.percentile(arr, 2), np.percentile(arr, 98)
    if p98 <= p2:
        return np.zeros_like(arr, dtype=np.uint8)
    out = (arr.astype(np.float32) - p2) / (p98 - p2)
    return np.clip(out * 255, 0, 255).astype(np.uint8)

def prepare_rgb(citra_rgb):
    rgb = np.stack([
        stretch_channel(citra_rgb[:, :, 0]),
        stretch_channel(citra_rgb[:, :, 1]),
        stretch_channel(citra_rgb[:, :, 2]),
    ], axis=2)
    return np.clip(np.power(rgb / 255.0, 0.75) * 255, 0, 255).astype(np.uint8)

def prepare_ir(citra_ir):
    ch = citra_ir[:, :, 0] if citra_ir.ndim == 3 else citra_ir
    return stretch_channel(ch)

def split_tiles(arr, grid_n, tile_size=TILE_SIZE):
    h, w = arr.shape[:2]
    tiles = []
    for i in range(grid_n):
        row = []
        for j in range(grid_n):
            r0 = int(i * h / grid_n);  r1 = int((i + 1) * h / grid_n)
            c0 = int(j * w / grid_n);  c1 = int((j + 1) * w / grid_n)
            tile = arr[r0:r1, c0:c1]
            tile_h, tile_w = tile.shape[:2]
            interp = cv2.INTER_AREA if (tile_h >= tile_size and tile_w >= tile_size) else cv2.INTER_CUBIC
            resized = cv2.resize(tile, (tile_size, tile_size), interpolation=interp)
            row.append(resized)
        tiles.append(row)
    return tiles

def draw_grid_overlay(rgb_full, grid_n, grid_results, target_size=TILE_SIZE):
    img  = Image.fromarray(rgb_full.astype(np.uint8)).convert('RGBA')
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    h, w = rgb_full.shape[:2]
    for i in range(grid_n):
        for j in range(grid_n):
            x0 = int(j * w / grid_n);  x1 = int((j + 1) * w / grid_n)
            y0 = int(i * h / grid_n);  y1 = int((i + 1) * h / grid_n)
            key = f"{i},{j}"
            if key in grid_results:
                cls   = grid_results[key]['class']
                hx    = WARNA_KELAS[cls]
                r, g, b = int(hx[1:3], 16), int(hx[3:5], 16), int(hx[5:7], 16)
                draw.rectangle([x0, y0, x1, y1], fill=(r, g, b, 55), outline=(r, g, b, 210))
                label  = LABEL_SINGKAT[cls]
                cx, cy = (x0 + x1) // 2 - 10, (y0 + y1) // 2 - 6
                draw.text((cx, cy), label, fill=(r, g, b, 230))
    composite = Image.alpha_composite(img, over).convert('RGB')
    return np.array(composite.resize((target_size, target_size), Image.LANCZOS))

def numpy_ke_base64(arr):
    try:
        if arr is None: return None
        pil = Image.fromarray(arr.astype(np.uint8))
        buf = BytesIO()
        pil.save(buf, format='PNG')
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None

# ── 5. GEE DATA FETCH ──────────────────────────────────────────────────────────
def ambil_data_gee_full(lon, lat, luas_km=3.84, res=10):
    radius_m = (luas_km * 1000.0) / 2.0
    area_roi = ee.Geometry.Point([lon, lat]).buffer(radius_m).bounds()
    dataset  = (
        ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(area_roi)
        .filterDate('2023-01-01', '2024-01-01')
        .sort('CLOUDY_PIXEL_PERCENTAGE')
        .first()
    )
    citra_rgb = geemap.ee_to_numpy(
        dataset.select(['B4', 'B3', 'B2']).clip(area_roi),
        region=area_roi, scale=res
    )
    citra_ir = geemap.ee_to_numpy(
        dataset.select(['B8']).clip(area_roi),
        region=area_roi, scale=res
    )
    return citra_rgb, citra_ir

# ── 6. INFERENCE ───────────────────────────────────────────────────────────────
trans_rgb = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
])

def infer_tile(rgb_tile, ir_tile):
    with torch.no_grad():
        with torch.amp.autocast('cuda' if device.type == 'cuda' else 'cpu'):
            rgb_t = trans_rgb(rgb_tile).unsqueeze(0).to(device)
            ir_t  = transforms.ToTensor()(ir_tile).unsqueeze(0).to(device)
            probs = F.softmax(model(rgb_t, ir_t), dim=1)
            score, idx = torch.max(probs, dim=1)
    return KELAS[idx.item()], score.item()

# ── 7. CROP HELPER ─────────────────────────────────────────────────────────────
def crop_sector(rgb_full, ir_full, i, j, grid_n):
    """Crop and return a specific sector as base64 images."""
    if ir_full.ndim == 2:
        ir_3ch = np.stack([ir_full] * 3, axis=2)
    elif ir_full.shape[2] == 1:
        ir_3ch = np.concatenate([ir_full] * 3, axis=2)
    else:
        ir_3ch = ir_full

    h_rgb, w_rgb = rgb_full.shape[:2]
    h_ir,  w_ir  = ir_3ch.shape[:2]

    r0_rgb = int(i * h_rgb / grid_n);  r1_rgb = int((i + 1) * h_rgb / grid_n)
    c0_rgb = int(j * w_rgb / grid_n);  c1_rgb = int((j + 1) * w_rgb / grid_n)

    r0_ir = int(i * h_ir / grid_n);  r1_ir = int((i + 1) * h_ir / grid_n)
    c0_ir = int(j * w_ir / grid_n);  c1_ir = int((j + 1) * w_ir / grid_n)

    crop_rgb = cv2.resize(rgb_full[r0_rgb:r1_rgb, c0_rgb:c1_rgb], (512, 512), interpolation=cv2.INTER_CUBIC)
    crop_ir  = cv2.resize(ir_3ch[r0_ir:r1_ir, c0_ir:c1_ir], (512, 512), interpolation=cv2.INTER_CUBIC)

    return numpy_ke_base64(crop_rgb), numpy_ke_base64(crop_ir)

# ── 8. FLASK ROUTES ────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def api_status():
    return jsonify({
        'gee': GEE_ONLINE,
        'model': model is not None,
        'device': str(device)
    })

@app.route('/api/scan', methods=['POST'])
def api_scan():
    """
    SSE streaming endpoint — mengirim event JSON satu per satu:
      type: 'scanning'  → { i, j, grid_n, done, total, grid_results }
      type: 'done'      → { grid_results, rgb_overlay, rgb_pure, ir_pure, lat, lon, luas_km, grid_n }
      type: 'error'     → { message }
    """
    data    = request.get_json()
    coords  = data.get('coordinates', '')
    luas_km = float(data.get('luas_km', 3.84))
    grid_n  = int(data.get('grid_n', 3))

    nums = re.findall(r'-?\d+\.\d+', coords)
    if len(nums) < 2:
        return jsonify({'error': 'Invalid coordinate string.'}), 400

    lat = float(nums[0])
    lon = float(nums[1])

    def generate():
        grid_results = {}

        if model is None:
            yield f"data: {json.dumps({'type':'error','message':'AI Model Offline.'})}\n\n"
            return
        if not GEE_ONLINE:
            yield f"data: {json.dumps({'type':'error','message':'Earth Engine Offline.'})}\n\n"
            return

        try:
            # Ambil data dari GEE
            yield f"data: {json.dumps({'type':'status','message':'Contacting Sentinel-2 satellite...'})}\n\n"
            citra_rgb, citra_ir = ambil_data_gee_full(lon, lat, luas_km)
            rgb_full = prepare_rgb(citra_rgb)
            ir_full  = prepare_ir(citra_ir)

            rgb_tiles = split_tiles(rgb_full, grid_n)
            ir_tiles  = split_tiles(ir_full,  grid_n)

            total = grid_n * grid_n

            for i in range(grid_n):
                for j in range(grid_n):
                    cls, conf = infer_tile(rgb_tiles[i][j], ir_tiles[i][j])
                    key = f"{i},{j}"
                    grid_results[key] = {
                        'class': cls,
                        'conf':  round(conf * 100, 1),
                        'color': WARNA_KELAS[cls],
                        'label': LABEL_SINGKAT[cls],
                        'desc':  DESKRIPSI_KELAS[cls],
                    }
                    done = len(grid_results)
                    payload = {
                        'type':         'scanning',
                        'i':            i,
                        'j':            j,
                        'grid_n':       grid_n,
                        'done':         done,
                        'total':        total,
                        'grid_results': grid_results,
                    }
                    yield f"data: {json.dumps(payload)}\n\n"

            # Buat overlay dan gambar final
            yield f"data: {json.dumps({'type':'status','message':'Rendering final imagery...'})}\n\n"

            rgb_overlay_arr  = draw_grid_overlay(rgb_full, grid_n, grid_results)
            rgb_pure_display = cv2.resize(rgb_full, (512, 512), interpolation=cv2.INTER_CUBIC)
            ir_display_src   = ir_full if ir_full.ndim == 3 else ir_full[:, :, np.newaxis].repeat(3, axis=2)
            ir_pure_display  = cv2.resize(ir_display_src, (512, 512), interpolation=cv2.INTER_CUBIC)

            # Hitung distribusi
            counts   = Counter([v['class'] for v in grid_results.values()])
            avg_conf = round(np.mean([v['conf'] for v in grid_results.values()]), 1)
            dom_cls  = sorted(counts.items(), key=lambda x: x[1], reverse=True)[0][0]

            # Simpan full arrays ke session cache (base64 untuk transfer ke JS)
            rgb_full_b64 = numpy_ke_base64(rgb_pure_display)
            ir_full_b64  = numpy_ke_base64(ir_pure_display)

            final_payload = {
                'type':         'done',
                'lat':          lat,
                'lon':          lon,
                'luas_km':      luas_km,
                'grid_n':       grid_n,
                'grid_results': grid_results,
                'rgb_overlay':  numpy_ke_base64(rgb_overlay_arr),
                'rgb_pure':     rgb_full_b64,
                'ir_pure':      ir_full_b64,
                'dom_cls':      dom_cls,
                'dom_color':    WARNA_KELAS[dom_cls],
                'avg_conf':     avg_conf,
                'counts':       dict(counts),
                'warna_kelas':  WARNA_KELAS,
            }
            yield f"data: {json.dumps(final_payload)}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={
            'Cache-Control':   'no-cache',
            'X-Accel-Buffering':'no',
        }
    )

@app.route('/api/crop', methods=['POST'])
def api_crop():
    """Crop a specific sector from stored imagery."""
    data   = request.get_json()
    sector = data.get('sector', 'ALL')
    grid_n = int(data.get('grid_n', 3))
    rgb_b64 = data.get('rgb_full')
    ir_b64  = data.get('ir_full')

    if not rgb_b64 or not ir_b64:
        return jsonify({'error': 'No imagery stored.'}), 400

    # Decode base64 ke numpy
    def b64_to_numpy(b64str):
        raw  = base64.b64decode(b64str.split(',')[1])
        img  = Image.open(BytesIO(raw)).convert('RGB')
        return np.array(img)

    rgb_full = b64_to_numpy(rgb_b64)
    ir_full  = b64_to_numpy(ir_b64)

    if sector == 'ALL':
        rgb_out = cv2.resize(rgb_full, (512, 512), interpolation=cv2.INTER_CUBIC)
        ir_out  = cv2.resize(ir_full,  (512, 512), interpolation=cv2.INTER_CUBIC)
        return jsonify({'rgb': numpy_ke_base64(rgb_out), 'ir': numpy_ke_base64(ir_out)})

    try:
        i, j = map(int, sector.split(','))
        rgb_out_b64, ir_out_b64 = crop_sector(rgb_full, ir_full, i, j, grid_n)
        return jsonify({'rgb': rgb_out_b64, 'ir': ir_out_b64})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', 'true').lower() == 'true'
    app.run(debug=debug_mode, host='0.0.0.0', port=port, threaded=True)