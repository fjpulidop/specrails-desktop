import { it } from 'vitest'
import { writeFileSync } from 'fs'
import { createHarness } from './__fixtures__/harness'
import { registerV2Surface } from './index'
import { buildToolSpecs } from '../tools/catalog'
it('dump', async () => {
  const h = createHarness(); registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  const c = await h.connect(); const r = await c.listTools()
  writeFileSync('/private/tmp/claude-501/-Users-javi-repos-specrails/fa372690-cb3b-4969-b66b-6aef7a25d808/scratchpad/v2-tools.json', JSON.stringify(r.tools, null, 1))
})
