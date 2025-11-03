const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const piexifjs = require('piexifjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG and PNG are allowed.'));
    }
  }
});

// Fixed EXIF metadata
const FIXED_EXIF = {
  "Make": "Canon",
  "Model": "Canon EOS 5D Mark IV",
  "Software": "Adobe Photoshop Lightroom",
  "GPSLatitude": 40.748817,
  "GPSLongitude": -73.985428
};

// Convert decimal GPS coordinates to EXIF format
function convertGPSToExif(lat, lng) {
  const latRef = lat >= 0 ? 'N' : 'S';
  const lngRef = lng >= 0 ? 'E' : 'W';
  
  const absLat = Math.abs(lat);
  const absLng = Math.abs(lng);
  
  const latDeg = Math.floor(absLat);
  const latMin = Math.floor((absLat - latDeg) * 60);
  const latSec = ((absLat - latDeg - latMin / 60) * 3600).toFixed(2);
  
  const lngDeg = Math.floor(absLng);
  const lngMin = Math.floor((absLng - lngDeg) * 60);
  const lngSec = ((absLng - lngDeg - lngMin / 60) * 3600).toFixed(2);
  
  return {
    latRef,
    lngRef,
    lat: [[latDeg, 1], [latMin, 1], [Math.round(parseFloat(latSec) * 100), 100]],
    lng: [[lngDeg, 1], [lngMin, 1], [Math.round(parseFloat(lngSec) * 100), 100]]
  };
}

// Inject EXIF metadata into JPEG image (BEFORE WebP conversion)
function injectExifIntoJpeg(jpegBuffer) {
  try {
    // Convert JPEG buffer to base64 data URL
    const base64Image = jpegBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;
    
    // Create EXIF object
    const zeroth = {};
    const exif = {};
    const gps = {};
    
    // Add basic EXIF data
    zeroth[piexifjs.ImageIFD.Make] = FIXED_EXIF.Make;
    zeroth[piexifjs.ImageIFD.Model] = FIXED_EXIF.Model;
    zeroth[piexifjs.ImageIFD.Software] = FIXED_EXIF.Software;
    
    // Add GPS data
    const gpsData = convertGPSToExif(FIXED_EXIF.GPSLatitude, FIXED_EXIF.GPSLongitude);
    gps[piexifjs.GPSIFD.GPSLatitudeRef] = gpsData.latRef;
    gps[piexifjs.GPSIFD.GPSLatitude] = gpsData.lat;
    gps[piexifjs.GPSIFD.GPSLongitudeRef] = gpsData.lngRef;
    gps[piexifjs.GPSIFD.GPSLongitude] = gpsData.lng;
    
    const exifObj = {
      "0th": zeroth,
      "Exif": exif,
      "GPS": gps
    };
    
    // Generate EXIF bytes
    const exifBytes = piexifjs.dump(exifObj);
    
    // Insert EXIF into JPEG
    const newDataUrl = piexifjs.insert(exifBytes, dataUrl);
    
    // Convert back to buffer
    const base64Data = newDataUrl.replace(/^data:image\/jpeg;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  } catch (error) {
    console.error('EXIF injection error:', error);
    throw new Error('Failed to inject EXIF metadata into image');
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main image processing endpoint
app.post('/process', upload.single('image'), async (req, res) => {
  try {
    // Validate image upload
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No image file provided. Please upload an image in the "image" field.' 
      });
    }

    // Get quality parameter (default 75)
    let quality = parseInt(req.body.quality) || 75;
    if (quality < 0 || quality > 100) {
      quality = 75;
    }

    // Get original filename and create new filename
    const originalName = req.file.originalname;
    const baseName = path.parse(originalName).name;
    const newFilename = `${baseName}.webp`;

    // STEP 1: Convert input image to JPEG (if PNG)
    // This ensures we always work with JPEG for EXIF injection
    let jpegBuffer;
    try {
      jpegBuffer = await sharp(req.file.buffer)
        .jpeg({ quality: 95 }) // High quality for intermediate JPEG
        .toBuffer();
    } catch (sharpError) {
      return res.status(400).json({ 
        error: 'Invalid or corrupted image file. Please upload a valid JPG or PNG image.' 
      });
    }

    // STEP 2: Inject EXIF metadata into JPEG
    let jpegWithExif;
    try {
      jpegWithExif = injectExifIntoJpeg(jpegBuffer);
    } catch (exifError) {
      return res.status(500).json({ 
        error: 'Failed to inject EXIF metadata',
        message: exifError.message 
      });
    }

    // STEP 3: Convert JPEG with EXIF to WebP
    let webpBuffer;
    try {
      webpBuffer = await sharp(jpegWithExif)
        .webp({ 
          quality: quality,
          // Preserve metadata during conversion
          effort: 4 // Balance between compression time and file size
        })
        .toBuffer();
    } catch (conversionError) {
      return res.status(500).json({ 
        error: 'Failed to convert image to WebP',
        message: conversionError.message 
      });
    }

    // Set response headers
    res.set({
      'Content-Type': 'image/webp',
      'Content-Disposition': `attachment; filename="${newFilename}"`,
      'Content-Length': webpBuffer.length
    });

    // Send the processed image
    res.send(webpBuffer);

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ 
      error: 'Internal server error during image processing',
      message: error.message 
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ error: error.message });
  }
  
  if (error.message === 'Invalid file type. Only JPG and PNG are allowed.') {
    return res.status(400).json({ error: error.message });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Image Processing API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Process endpoint: POST http://localhost:${PORT}/process`);
});

module.exports = app;
