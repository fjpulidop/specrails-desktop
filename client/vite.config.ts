import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolveWebDevPorts } from '../server/dev-ports'

export default defineConfig(({ mode }) => {
  const devPorts = resolveWebDevPorts(process.env)

  return {
    plugins: [tailwindcss(), react()],
    define: {
      __API_ORIGIN__: mode === 'development'
        ? JSON.stringify(devPorts.serverOrigin)
        : JSON.stringify(''),
      __WS_URL__: mode === 'development'
        ? JSON.stringify(devPorts.wsUrl)
        : JSON.stringify(''),
    },
    server: {
      port: devPorts.clientPort,
      strictPort: true,
      proxy: {
        '/api': devPorts.serverOrigin,
        '/hooks': devPorts.serverOrigin,
      },
    },
  }
})
