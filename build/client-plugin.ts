import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CSS_VIRTUAL_PREFIX = '\0dsh-fabric-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** Build one DSH browser plugin's host marker and lazy client bundle. */
export function clientPlugin(id: string): UserConfig[] {
  return [
    {
      name: id,
      entry: ['src/index.ts', 'src/invariant.ts'],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: false,
    },
    {
      name: `${id}/client`,
      entry: { client: 'src/client/index.ts' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2024',
      dts: false,
      sourcemap: true,
      clean: false,
      deps: {
        neverBundle: [...CLIENT_EXTERNALS],
        alwaysBundle: (source: string) =>
          CLIENT_EXTERNALS.includes(source as typeof CLIENT_EXTERNALS[number]) ? undefined : true,
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      },
      plugins: [
        {
          name: 'dsh-fabric-client-purity',
          resolveId(source: string) {
            if (!source.startsWith('@deepseek-ai/')) return null
            if (CLIENT_EXTERNALS.includes(source as typeof CLIENT_EXTERNALS[number])) return null
            throw new Error(
              `client bundle purity: "${source}" is not a DSH platform module; use a Cordis service or a type-only import`,
            )
          },
        },
        {
          name: 'dsh-fabric-css-modules-inline',
          resolveId(source: string, importer: string | undefined) {
            if (!source.endsWith('.module.css')) return null
            const absolute = importer === undefined ? source : sourceAssetPath(source, importer)
            return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
          },
          async load(virtualId: string) {
            if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
            const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
            this.addWatchFile(fileId)
            const source = await readFile(fileId)
            const result = transform({
              filename: fileId,
              code: source,
              cssModules: { pattern: '[hash]_[local]' },
              minify: true,
            })
            const classMap: Record<string, string> = {}
            for (const [local, value] of Object.entries(result.exports ?? {})) classMap[local] = value.name
            return [
              `const css = ${JSON.stringify(result.code.toString())};`,
              `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
              `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
              `  const tag = document.createElement('style');`,
              `  tag.dataset.plugin = ${JSON.stringify(id)};`,
              `  tag.dataset.pluginCss = tagId;`,
              `  tag.textContent = css;`,
              `  document.head.appendChild(tag);`,
              `}`,
              `export default ${JSON.stringify(classMap)};`,
            ].join('\n')
          },
        },
      ],
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}

function sourceAssetPath(source: string, importer: string): string {
  const direct = resolve(dirname(importer), source)
  if (existsSync(direct)) return direct
  const marker = '/lib/types/'
  const normalized = direct.replaceAll('\\', '/')
  const boundary = normalized.indexOf(marker)
  return boundary < 0
    ? direct
    : resolve(normalized.slice(0, boundary), 'src', normalized.slice(boundary + marker.length))
}
