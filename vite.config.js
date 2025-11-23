import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    include: ['delaunator', 'd3-contour']
  }
});

