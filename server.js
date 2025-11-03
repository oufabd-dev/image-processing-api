const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
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

    // Process image: Remove ALL metadata and convert to WebP
    let webpBuffer;
    try {
      webpBuffer = await sharp(req.file.buffer)
        .withMetadata(false) // ← Remove ALL metadata (EXIF, GPS, etc.)
        .webp({ 
          quality: quality,
          effort: 4 // Balance between compression time and file size
        })
        .toBuffer();
    } catch (sharpError) {
      return res.status(400).json({ 
        error: 'Invalid or corrupted image file. Please upload a valid JPG or PNG image.',
        details: sharpError.message 
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
