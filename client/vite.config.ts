import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolveWebDevPorts } from '../server/dev-ports'

export default defineConfig(({ mode }) => {
  const devPorts = resolveWebDevPorts(process.env)

  return {
    plugins: [tailwindcss(), react()],
    define: {
      __WS_URL__: mode === 'development'
        ? JSON.stringify(devPorts.wsUrl)
        : JSON.stringify(''),
    },
    server: {
      port: devPorts.clientPort,
      proxy: {
        '/api': devPorts.serverOrigin,
        '/hooks': devPorts.serverOrigin,
      },
    },
  }
})
