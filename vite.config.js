import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import process from 'process'

const projectRoot = process.cwd()
const publicRoot = path.join(projectRoot, 'public')
const distRoot = path.join(projectRoot, 'dist')

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function copyPublicWithoutSlides() {
  return {
    name: 'copy-public-without-slides',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(publicRoot)) return

      const copyEntry = (source, target) => {
        const stat = fs.statSync(source)

        if (stat.isDirectory()) {
          if (path.basename(source) === 'slides') return

          fs.mkdirSync(target, { recursive: true })
          for (const entry of fs.readdirSync(source)) {
            copyEntry(path.join(source, entry), path.join(target, entry))
          }
          return
        }

        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
      }

      for (const entry of fs.readdirSync(publicRoot)) {
        copyEntry(path.join(publicRoot, entry), path.join(distRoot, entry))
      }
    },
  }
}

function servePublicWithoutSlides() {
  return {
    name: 'serve-public-without-slides',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.startsWith('/api') || req.url.startsWith('/slides')) {
          next()
          return
        }

        const pathname = decodeURIComponent(req.url.split('?')[0])
        const filePath = path.resolve(publicRoot, pathname.slice(1))

        if (!isInside(publicRoot, filePath) || !fs.existsSync(filePath)) {
          next()
          return
        }

        const stat = fs.statSync(filePath)
        if (!stat.isFile()) {
          next()
          return
        }

        res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}

export default defineConfig({
  publicDir: false,
  plugins: [react(), copyPublicWithoutSlides(), servePublicWithoutSlides()],
  server: {
    host: '0.0.0.0',
    allowedHosts: [
      '.trycloudflare.com',
      'random-name.trycloudflare.com',
    ],
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/slides': 'http://127.0.0.1:4000',
    },
    watch: {
      ignored: [
        '**/public/slides/**',
        '**/raw-slides/**',
      ],
    },
  },
})
