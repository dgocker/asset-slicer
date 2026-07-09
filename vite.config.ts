import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(), 
      tailwindcss(),
      {
        name: 'apk-mime-plugin',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const urlPath = req.url ? req.url.split('?')[0] : '';
            const filename = urlPath.split('/').pop();
            if (filename && (filename.endsWith('.apk') || filename.endsWith('.onnx'))) {
              const filePath = path.join('/root/served_files', filename);
              if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const stat = fs.statSync(filePath);
                res.setHeader('Content-Length', stat.size.toString());
                if (filename.endsWith('.apk')) {
                  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
                } else if (filename.endsWith('.onnx')) {
                  res.setHeader('Content-Type', 'application/octet-stream');
                }
                fs.createReadStream(filePath).pipe(res);
                return;
              }
            }
            next();
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            const urlPath = req.url ? req.url.split('?')[0] : '';
            const filename = urlPath.split('/').pop();
            if (filename && (filename.endsWith('.apk') || filename.endsWith('.onnx'))) {
              const filePath = path.join('/root/served_files', filename);
              if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const stat = fs.statSync(filePath);
                res.setHeader('Content-Length', stat.size.toString());
                if (filename.endsWith('.apk')) {
                  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
                } else if (filename.endsWith('.onnx')) {
                  res.setHeader('Content-Type', 'application/octet-stream');
                }
                fs.createReadStream(filePath).pipe(res);
                return;
              }
            }
            next();
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        }
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
