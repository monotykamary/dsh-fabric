import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Fabric topology node text', () => {
  it('keeps label and metadata rows inside the 164px node card', async () => {
    const [view, styles] = await Promise.all([
      readFile(new URL('../src/client/FabricView.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/client/fabric.module.css', import.meta.url), 'utf8'),
    ])

    expect(view).toContain('className={css.nodeLabelViewport} x="31" y="7" width="115"')
    expect(view).toContain('className={css.nodeMetaViewport} x="18" y="31" width="128"')
    expect(view).not.toContain('<text className={css.nodeLabel}')
    expect(styles).toContain('.nodeLabelViewport, .nodeMetaViewport { overflow: hidden; pointer-events: none; }')
    expect(styles).toContain('text-overflow: ellipsis;')
    expect(styles).toContain('.nodeMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; }')
  })
})
