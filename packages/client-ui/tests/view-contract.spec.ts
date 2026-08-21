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

  it('keeps the infinite canvas scroll-free and captures touch pinch gestures', async () => {
    const [view, styles] = await Promise.all([
      readFile(new URL('../src/client/FabricView.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/client/fabric.module.css', import.meta.url), 'utf8'),
    ])

    expect(view).toContain('onTouchStart={beginTouchGesture}')
    expect(view).toContain('onTouchMove={moveTouchGesture}')
    expect(view).toContain("gesture.kind === 'pinch'")
    expect(view).toContain('onDoubleClick={zoomOnDoubleClick}')
    expect(view).toContain('x: (viewport.width - model.layout.width * fitScale) / 2')
    expect(styles).toContain('overflow: hidden;')
    expect(styles).toContain('touch-action: none;')
    expect(styles).toContain('transition: transform 180ms')
    expect(styles).toContain('.canvasColumn { padding-bottom: var(--dsh-fabric-bottom-clearance); }')
    expect(styles).not.toContain('padding: 24px;')
    expect(styles).not.toContain('.canvas { min-height: 360px; overflow: auto; }')
  })
})
