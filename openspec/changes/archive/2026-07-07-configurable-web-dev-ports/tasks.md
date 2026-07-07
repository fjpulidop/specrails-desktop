## Tasks

- [x] Add a shared, testable dev-port parser for positive integer port environment values.
- [x] Update `server/index.ts` so `SPECRAILS_DEV_SERVER_PORT` controls the default backend dev port while preserving `--port` precedence and the `4200` fallback.
- [x] Update `client/vite.config.ts` so `SPECRAILS_DEV_CLIENT_PORT` controls Vite's port and `SPECRAILS_DEV_SERVER_PORT` controls proxy/`__WS_URL__` targets.
- [x] Add focused tests for server port resolution and Vite default/custom port configuration.
- [x] Run typecheck and relevant server/client tests.
