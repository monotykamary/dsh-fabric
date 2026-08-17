import path from 'node:path'
import ts from 'typescript'
import type { CodeBindingNamespace } from '@monotykamary/dsh-code-runtime'

/** One model-feedable TypeScript diagnostic. */
export interface QuickJsTypeError {
  line: number
  column: number
  message: string
}

/** Checked JavaScript or source diagnostics. */
export type QuickJsCompileResult =
  | { code: string }
  | { errors: readonly QuickJsTypeError[] }

// Ported from pi-fabric's type-error-guidance: a syntax error in a program
// that calls edit/write is often embedded payload text, not bad code.
const PAYLOAD_CALL_PATTERN = /\btools\.(?:edit|write)\s*\(/
const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i

/**
 * One recovery hint for syntax-shaped diagnostics when the program embeds
 * edit/write payloads, mirroring pi-fabric's guest-side error magic.
 * @param code - the submitted program text.
 * @param errors - the diagnostics that failed the check.
 * @returns the hint to append, or undefined when the pattern does not apply.
 */
export function typeErrorRecoveryHint(code: string, errors: readonly QuickJsTypeError[]): string | undefined {
  if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined
  if (!errors.some(error => SYNTAX_ERROR_PATTERN.test(error.message))) return undefined
  return 'Recovery hint: if edit/write payload text embedded in the program caused the syntax error, build the payload as a separate string value (for example a const assembled from smaller pieces, or JSON.stringify of an object) instead of inlining it inside the call.'
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  useUnknownInCatchVariables: false,
  noEmit: false,
  skipLibCheck: true,
  lib: ['lib.es2022.d.ts'],
}

let nextCheckerId = 0

/** Typecheck one program against exactly the namespaces supplied to CodeRuntime.run(). */
export function compileQuickJsProgram(
  program: string,
  bindings: readonly CodeBindingNamespace[],
): QuickJsCompileResult {
  const prelude = declarationsFor(bindings)
  const parameters = parametersFor(bindings)
  const typeParameters = typeParametersFor(bindings)
  const id = ++nextCheckerId
  const sourcePath = normalize(path.resolve(`/__dsh_fabric_guest_${id}.ts`))
  const sourceText = [
    prelude,
    `function __dsh_main__${typeParameters}(${parameters.join(', ')}) {`,
    '  return async function () {',
    program,
    '  }',
    '}',
    '',
  ].join('\n')
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.ES2022, true)
  const base = ts.createCompilerHost(compilerOptions, true)
  const canonical = (value: string) => base.getCanonicalFileName(normalize(value))
  const libraryRoot = `${canonical(path.dirname(ts.getDefaultLibFilePath(compilerOptions)))}/`
  const permitted = (file: string): boolean => {
    const value = canonical(file)
    return value === canonical(sourcePath) || value.startsWith(libraryRoot)
  }
  const host: ts.CompilerHost = {
    ...base,
    fileExists: file => permitted(file) && (canonical(file) === canonical(sourcePath) || base.fileExists(file)),
    readFile: file => canonical(file) === canonical(sourcePath)
      ? sourceText
      : permitted(file) ? base.readFile(file) : undefined,
    getSourceFile: (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (canonical(file) === canonical(sourcePath)) return source
      return permitted(file) ? base.getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile) : undefined
    },
  }
  const compiler = ts.createProgram({ rootNames: [sourcePath], options: compilerOptions, host })
  const diagnostics = [
    ...compiler.getSyntacticDiagnostics(source),
    ...compiler.getSemanticDiagnostics(source),
  ]
  if (diagnostics.length > 0) {
    const errors = diagnostics.map(diagnostic => diagnosticOf(diagnostic, source))
    const hint = typeErrorRecoveryHint(program, errors)
    return { errors: hint === undefined ? errors : [...errors, { line: 0, column: 0, message: hint }] }
  }

  let code: string | undefined
  compiler.emit(source, (file, content) => {
    if (file.endsWith('.js')) code = content
  })
  return code === undefined
    ? { errors: [{ line: 0, column: 0, message: 'TypeScript compiler emitted no JavaScript' }] }
    : { code }
}

function declarationsFor(_bindings: readonly CodeBindingNamespace[]): string {
  return [
    'type DshCodeJson = null | boolean | number | string | DshCodeJson[] | { [key: string]: DshCodeJson };',
    'type __dsh_main__ = Error;',
  ].join('\n')
}

function typeParametersFor(bindings: readonly CodeBindingNamespace[]): string {
  const parameters = bindings.flatMap(namespace => namespace.errorClass === undefined
    ? []
    : [`${namespace.errorClass.name} extends __dsh_main__ & { readonly ${JSON.stringify(namespace.errorClass.memberNameProperty)}: string }`])
  return parameters.length === 0 ? '' : `<${parameters.join(', ')}>`
}

function parametersFor(bindings: readonly CodeBindingNamespace[]): string[] {
  const parameters = [
    'console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void }',
  ]
  for (const namespace of bindings) {
    const members = Object.keys(namespace.functions)
      .map(name => `readonly ${JSON.stringify(name)}: (args: DshCodeJson) => any`)
      .join('; ')
    parameters.push(`${namespace.global}: { ${members} }`)
    if (namespace.errorClass !== undefined) {
      parameters.push(`${namespace.errorClass.name}: { new(message?: string): ${namespace.errorClass.name} }`)
    }
  }
  return parameters
}

function diagnosticOf(diagnostic: ts.Diagnostic, source: ts.SourceFile): QuickJsTypeError {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (diagnostic.file !== source || diagnostic.start === undefined) return { line: 0, column: 0, message }
  const position = source.getLineAndCharacterOfPosition(diagnostic.start)
  return {
    line: Math.max(1, position.line),
    column: position.character + 1,
    message,
  }
}

function normalize(file: string): string {
  return file.replaceAll('\\', '/')
}
