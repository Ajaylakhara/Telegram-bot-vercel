/* =========================================================
   Closeout Center – Email Template JS
   master.js
   ========================================================= */

/**
 * Ensures product image wrappers are correctly sized after load.
 * Useful for web-preview mode where CSS transform may need a nudge.
 */
(function () {
  'use strict';

  function initProductImages() {
    var wrappers = document.querySelectorAll('.product-image-wrapper');
    wrappers.forEach(function (wrapper) {
      var img = wrapper.querySelector('img');
      if (!img) return;

      // Enforce native 500×500 on the img, wrapper clips to 250×250
      img.style.width  = '500px';
      img.style.height = '500px';
      img.style.maxWidth = 'none';
      img.style.transform = 'scale(0.5)';
      img.style.transformOrigin = 'top left';
    });
  }

  /**
   * Responsive helper: adjusts icon-column left padding on very small screens.
   */
  function handleResize() {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var iconCells = document.querySelectorAll('.iconCell');
    var textCells = document.querySelectorAll('.textCell');

    if (vw <= 480) {
      iconCells.forEach(function (el) { el.style.paddingLeft = '16px'; });
      textCells.forEach(function (el) { el.style.paddingLeft = '16px'; });
    } else {
      // Reset to CSS-defined values
      iconCells.forEach(function (el) { el.style.paddingLeft = ''; });
      textCells.forEach(function (el) { el.style.paddingLeft = ''; });
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initProductImages();
      handleResize();
    });
  } else {
    initProductImages();
    handleResize();
  }

  // Re-run on resize
  window.addEventListener('resize', handleResize);
})();
