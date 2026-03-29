// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useState, useCallback, useEffect } from 'react';

interface ImagePreviewProps {
  /** Thumbnail URLs (small) */
  thumbnails: string[];
  /** Full-size image URLs, parallel to thumbnails */
  images: string[];
}

/**
 * Shows a clickable thumbnail that opens a full-screen lightbox overlay
 * with forward/back navigation and close button.
 */
const ImagePreview: React.FC<ImagePreviewProps> = ({ thumbnails, images }) => {
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const goNext = useCallback(() => {
    setLightboxIndex((prev) => (prev !== null ? (prev + 1) % images.length : null));
  }, [images.length]);

  const goPrev = useCallback(() => {
    setLightboxIndex((prev) => (prev !== null ? (prev - 1 + images.length) % images.length : null));
  }, [images.length]);

  // Keyboard navigation
  useEffect(() => {
    if (lightboxIndex === null) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lightboxIndex, closeLightbox, goNext, goPrev]);

  if (thumbnails.length === 0) return null;

  return (
    <>
      <div className="addon-thumb-row">
        <img
          className="addon-thumb"
          src={thumbnails[0]}
          alt="Preview"
          onLoad={() => setThumbLoaded(true)}
          onClick={(e) => {
            e.stopPropagation();
            openLightbox(0);
          }}
          style={{ display: thumbLoaded ? 'block' : 'none', cursor: 'pointer' }}
        />
        {!thumbLoaded && <span className="thumb-loading">Loading preview…</span>}
        {thumbnails.length > 1 && thumbLoaded && (
          <span className="thumb-count" onClick={(e) => { e.stopPropagation(); openLightbox(0); }}>
            +{thumbnails.length - 1} more
          </span>
        )}
      </div>

      {lightboxIndex !== null && (
        <div className="lightbox-overlay" onClick={closeLightbox}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={closeLightbox} title="Close">✕</button>
            {images.length > 1 && (
              <button className="lightbox-nav lightbox-prev" onClick={goPrev} title="Previous">‹</button>
            )}
            <img
              className="lightbox-img"
              src={images[lightboxIndex]}
              alt={`Preview ${lightboxIndex + 1} of ${images.length}`}
            />
            {images.length > 1 && (
              <button className="lightbox-nav lightbox-next" onClick={goNext} title="Next">›</button>
            )}
            {images.length > 1 && (
              <div className="lightbox-counter">
                {lightboxIndex + 1} / {images.length}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default ImagePreview;
