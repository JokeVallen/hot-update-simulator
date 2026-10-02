// frontend/vite.config.js
import { defineConfig, loadEnv } from 'vite'
import path from 'path'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, path.resolve(__dirname, '..'))

    return {
        server: {
            port: parseInt(env.VITE_PORT) || 5173,
            proxy: {
                '/api': env.VITE_API_BASE_URL || 'http://localhost:5500',
                '/assets': env.VITE_API_BASE_URL || 'http://localhost:5500',
                '/docs': env.VITE_API_BASE_URL || 'http://localhost:5500',
            }
        },
        build: {
            outDir: '../dist',
            emptyOutDir: true,
        }
    }
})