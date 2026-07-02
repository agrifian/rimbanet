# RimbaNet Neural Engine v2.0 — Web App Setup

## Prasyarat
Sebelum memulai, pastikan Windows Anda memenuhi syarat berikut untuk menghindari eror DLL (`c10.dll`):
- **Python 3.11 atau 3.12** (**JANGAN** menggunakan Python 3.14 karena tidak stabil untuk PyTorch)
- **Microsoft Visual C++ Redistributable (x64)** versi 2015-2022 terinstal di Windows

Run di terminal untuk menjalankan aplikasi:
- venv\Scripts\activate
- python app.py

## Struktur Folder
```text
RimbaNet-Web/
├── app.py                                           ← Flask server utama
├── requirements.txt
├── credentials/
│   └── upheld-producer-488308-q3-9c85dc4356a4.json  ← TARUH DI SINI
├── models/
│   └── Model_SwinV2.pth                             ← TARUH DI SINI
├── static/
│   ├── css/style.css
│   ├── js/script.js
│   └── images
│       └──input images here in .jpg or .png
└── templates/
    └── index.html
```