# Public Assets Directory

This directory contains static assets served by the backend for report rendering.

## Directory Structure

```
public/
├── css/
│   ├── report-screen.css    # Digital viewing styles
│   └── report-print.css     # Physical print styles
├── images/
│   ├── logo.svg             # Sobhana logo (REQUIRED)
│   └── signatures/          # Doctor signature images
│       ├── dr-harish-kumar.png
│       └── dr-priya-sharma.png
└── fonts/                   # Custom fonts (optional)
```

## Required Assets

### 1. Logo (`images/logo.svg` or `images/logo.png`)
- Sobhana Diagnostics logo
- Used in report header (digital view)
- Recommended: SVG format, 200px width

### 2. Signature Images (`images/signatures/`)
- PNG format with transparent background
- Name format: `{doctor-code}.png` (lowercase, hyphenated)
- Size: ~200x80px
- Currently needed:
  - `dr-harish-kumar.png` (Pathologist)
  - `dr-priya-sharma.png` (Biochemist)

## Notes

- Images are served at `/images/{path}`
- CSS files are served at `/css/{path}`
- All paths are relative to the public directory
