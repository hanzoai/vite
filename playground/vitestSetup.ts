import type * as http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-chromium'
import type {
  ConfigEnv,
  InlineConfig,
  Logger,
  PluginOption,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
} from 'vite'
import {
  build,
  createBuilder,
  createServer,
  loadConfigFromFile,
  mergeConfig,
  preview,
} from 'vite'
import type { Browser, Page } from 'playwright-chromium'
import type {
  RolldownWatcher,
  RolldownWatcherEvent,
  RollupError,
} from 'rolldown'
import { afterEach, beforeAll, expect, inject, vi } from 'vitest'

// #region serializer

export const sourcemapSnapshot = Symbol()

const generateVisualizationLink = (code: string, map: string) => {
  const utf16ToUTF8 = (x) => unescape(encodeURIComponent(x))
  const convertedCode = utf16ToUTF8(code)
  const convertedMap = utf16ToUTF8(map)
  const hash = `${convertedCode.length}\0${convertedCode}${convertedMap.length}\0${convertedMap}`
  return `https://evanw.github.io/source-map-visualization/#${btoa(hash)}`
}

expect.addSnapshotSerializer({
  serialize(val, config, indentation, depth, refs, printer) {
    const options = val[sourcemapSnapshot]
    const map = { ...val.map }
    if (options.withoutContent) {
      delete map.sourcesContent
    }

    return `${indentation}SourceMap {
${indentation}${config.indent}content: ${printer(map, config, indentation + config.indent, depth, refs)},
${indentation}${config.indent}visualization: ${JSON.stringify(generateVisualizationLink(val.code, JSON.stringify(val.map)))}
${indentation}}`
  },
  test(val) {
    return typeof val === 'object' && val && val[sourcemapSnapshot]
  },
})

// #endregion

// #region env

export const workspaceRoot = path.resolve(import.meta.dirname, '../')

export const isBuild = !!process.env.VITE_TEST_BUILD
export const isServe = !isBuild
/**
 * Serve mode with `experimental.bundledDev` force-enabled for every playground
 * (`VITE_TEST_BUNDLED_DEV=1`). `isServe` stays `true` in this mode; use
 * `test.skipIf(isBundledDev)` / `describe.skipIf(isBundledDev)` for cases that
 * don't pass under bundled dev yet.
 */
export const isBundledDev = isServe && !!process.env.VITE_TEST_BUNDLED_DEV
export const isBundled = isBuild || isBundledDev
export const isWindows = process.platform === 'win32'
export const viteBinPath = path.posix.join(
  workspaceRoot,
  'packages/vite/bin/vite.js',
)

// #endregion

// #region context

let server: ViteDevServer | http.Server

/**
 * Vite Dev Server when testing serve
 */
export let viteServer: ViteDevServer
/**
 * Root of the Vite fixture
 */
export let rootDir: string
/**
 * Path to the current test file
 */
export let testPath: string
/**
 * Path to the test folder
 */
export let testDir: string
/**
 * Test folder name
 */
export let testName: string

export const serverLogs: string[] = []
export const browserLogs: string[] = []
export const browserErrors: Error[] = []

export let page: Page = undefined!
export let browser: Browser = undefined!
export let viteTestUrl: string = ''
export let watcher: RolldownWatcher | undefined = undefined

export function setViteUrl(url: string): void {
  viteTestUrl = url
}

function throwHtmlParseError() {
  return {
    name: 'vite-plugin-throw-html-parse-error',
    configResolved(config: ResolvedConfig) {
      const warn = config.logger.warn
      config.logger.warn = (msg, opts) => {
        // convert HTML parse warnings to make it easier to test
        if (msg.includes('Unable to parse HTML;')) {
          throw new Error(msg)
        }
        warn.call(config.logger, msg, opts)
      }
    },
  }
}
// #endregion

// eslint-disable-next-line no-empty-pattern
beforeAll(async ({}, suite) => {
  testPath = suite.file.filepath!
  testName = slash(testPath).match(/playground\/([\w-]+)\//)?.[1]
  testDir = path.dirname(testPath)
  if (testName) {
    testDir = path.resolve(workspaceRoot, 'playground-temp', testName)
  }

  // skip browser setup for hmr-ssr playground
  if (testName === 'hmr-ssr') {
    return
  }

  const wsEndpoint = inject('wsEndpoint')
  if (!wsEndpoint) {
    throw new Error('wsEndpoint not found')
  }

  browser = await chromium.connect(wsEndpoint)
  page = await browser.newPage()

  try {
    page.on('console', (msg) => {
      // ignore favicon request in headed browser
      if (
        process.env.VITE_DEBUG_SERVE &&
        msg.text().includes('Failed to load resource:') &&
        msg.location().url.includes('favicon.ico')
      ) {
        return
      }
      browserLogs.push(msg.text())
    })
    page.on('pageerror', (error) => {
      browserErrors.push(error)
    })

    // if this is a test placed under playground/xxx/__tests__
    // start a vite server in that directory.
    if (testName) {
      // when `root` dir is present, use it as vite's root
      const testCustomRoot = path.resolve(testDir, 'root')
      rootDir = fs.existsSync(testCustomRoot) ? testCustomRoot : testDir

      // separate rootDir for variant
      const variantName = path.basename(path.dirname(testPath))
      if (variantName !== '__tests__') {
        const variantTestDir = testDir + '__' + variantName
        if (fs.existsSync(variantTestDir)) {
          rootDir = testDir = variantTestDir
        }
      }

      const testCustomServe = [
        path.resolve(path.dirname(testPath), 'serve.ts'),
        path.resolve(path.dirname(testPath), 'serve.js'),
      ].find((i) => fs.existsSync(i))

      if (testCustomServe) {
        // test has custom server configuration.
        const mod = await import(testCustomServe)
        const serve = mod.serve || mod.default?.serve
        const preServe = mod.preServe || mod.default?.preServe
        if (preServe) {
          await preServe()
        }
        if (serve) {
          server = await serve()
          viteServer = mod.viteServer
        }
      } else {
        await startDefaultServe()
      }
    }
  } catch (e) {
    // Closing the page since an error in the setup, for example a runtime error
    // when building the playground should skip further tests.
    // If the page remains open, a command like `await page.click(...)` produces
    // a timeout with an exception that hides the real error in the console.
    await page.close()
    await server?.close()
    throw e
  }

  return async () => {
    serverLogs.length = 0
    await page?.close()
    await server?.close()
    await watcher?.close()
    if (browser) {
      await browser.close()
    }
  }
})

async function loadConfig(configEnv: ConfigEnv) {
  let config: UserConfig | null = null

  // config file named by convention as the *.spec.ts folder
  const variantName = path.basename(path.dirname(testPath))
  if (variantName !== '__tests__') {
    const configVariantPath = path.resolve(
      rootDir,
      `vite.config-${variantName}.js`,
    )
    if (fs.existsSync(configVariantPath)) {
      const res = await loadConfigFromFile(configEnv, configVariantPath)
      if (res) {
        config = res.config
      }
    }
  }
  // config file from test root dir
  if (!config) {
    const res = await loadConfigFromFile(configEnv, undefined, rootDir)
    if (res) {
      config = res.config
    }
  }

  const options: InlineConfig = {
    root: rootDir,
    logLevel: 'silent',
    configFile: false,
    server: {
      watch: {
        // During tests we edit the files too fast and sometimes chokidar
        // misses change events, so enforce polling for consistency
        usePolling: true,
        interval: 100,
      },
    },
    build: {
      // esbuild do not minify ES lib output since that would remove pure annotations and break tree-shaking
      // skip transpilation during tests to make it faster
      target: 'esnext',
    },
    customLogger: createInMemoryLogger(serverLogs),
    plugins: [throwHtmlParseError()],
  }
  let merged = mergeConfig(options, config || {})
  // applied after the merge so the playground's own config cannot turn it off —
  // the whole point of the bundled-dev run is to force the mode everywhere
  if (isBundledDev) {
    merged = mergeConfig(merged, { experimental: { bundledDev: true } })
  }
  return merged
}

/** playgrounds that assert the bundling-fallback page itself — exempt from settle guards */
const FALLBACK_ASSERTING_PLAYGROUNDS = ['hmr-full-bundle-mode']

/** bumped by editFile/addFile/removeFile (test-utils) */
export let fileMutationCount = 0
export function noteFileMutation(): void {
  fileMutationCount++
}

/**
 * Waits until bundled dev has finished processing the latest change and the
 * page is at rest. Every condition is a definite state, not a timing guess,
 * so slow builds just make it wait longer:
 *   - the server saw a change past `afterHmrEventCount`
 *      (if passed, has the dev engine seen the latest file edit yet?)
 *   - no full reload is waiting to be sent (server) or started (page marker)
 *   - the page is loaded and not the fallback page (unless the build errored,
 *     which keeps the fallback up legitimately)
 *   - the page's client registered after the latest reload send
 * A loaded page without the client runtime (e.g. SSR) counts as settled.
 * Prefer `withPageReload` (test-utils) over calling this directly.
 */
export async function waitForBundledDevSettled(opts?: {
  /** first wait until the server has seen a change past this count */
  afterHmrEventCount?: number
  timeout?: number
}): Promise<void> {
  if (!isBundledDev || !page) return
  // not public API — reached via `as any`
  const tracker = (viteServer as any)?.environments?.client?.bundledDev
    ?.testTracker
  if (!tracker) return
  const deadline = performance.now() + (opts?.timeout ?? 40_000)
  const remaining = () => Math.max(1, deadline - performance.now())
  if (opts?.afterHmrEventCount !== undefined) {
    await vi.waitUntil(
      () => tracker.getState().hmrEventCount > opts.afterHmrEventCount!,
      { timeout: remaining(), interval: 20 },
    )
  }
  await vi.waitUntil(
    async () => {
      try {
        if (tracker.getState().hasUnsentFullReload) return false
        if (page.isClosed()) return true
        const state = await page
          .evaluate(() => ({
            loaded: document.readyState === 'complete',
            pendingReload: !!(globalThis as any).__vite_pending_reload__,
            isFallback: !!(globalThis as any).__vite_is_fallback_page__,
            hasRuntime: !!(globalThis as any).__rolldown_runtime__,
            clientId: (globalThis as any).__rolldown_runtime__?.clientId as
              | string
              | undefined,
          }))
          .catch(() => undefined)
        if (!state || !state.loaded || state.pendingReload) return false
        if (state.isFallback) return tracker.getState().hasBuildError
        if (
          state.hasRuntime &&
          (!state.clientId || !tracker.isClientCurrent(state.clientId))
        ) {
          return false
        }
        return !tracker.getState().hasUnsentFullReload
      } catch {
        // transient server-side errors (e.g. engine closing) — keep polling
        return false
      }
    },
    { timeout: remaining(), interval: 20 },
  )
}

export function getBundledDevHmrEventCount(): number | undefined {
  return (
    viteServer as any
  )?.environments?.client?.bundledDev?.testTracker.getState().hmrEventCount
}

// settle-guard bookkeeping: what the last guard pass had already seen
let guardSeenMutations = 0
let guardSeenHmrEvents = 0

afterEach(async (ctx) => {
  // No test may hand the next one a page with updates or navigations still
  // in flight. Reload-expecting tests should still use `withPageReload`.
  if (
    !isBundledDev ||
    FALLBACK_ASSERTING_PLAYGROUNDS.includes(testName) ||
    !page ||
    page.isClosed()
  ) {
    return
  }
  if (fileMutationCount > guardSeenMutations) {
    // best-effort only: a mutation of an unwatched file never produces an event
    const seen = guardSeenHmrEvents
    await vi
      .waitUntil(() => (getBundledDevHmrEventCount() ?? seen + 1) > seen, {
        timeout: 2_000,
        interval: 20,
      })
      .catch(() => {})
  }
  try {
    await waitForBundledDevSettled({ timeout: 10_000 })
  } catch {
    console.warn(
      `[bundled-dev settle guard] "${ctx.task.name}" did not settle within 10s — later tests may see its trailing updates`,
    )
  }
  guardSeenMutations = fileMutationCount
  guardSeenHmrEvents = getBundledDevHmrEventCount() ?? guardSeenHmrEvents
})

export async function startDefaultServe(): Promise<void> {
  setupConsoleWarnCollector(serverLogs)

  if (!isBuild) {
    process.env.VITE_INLINE = 'inline-serve'
    const config = await loadConfig({ command: 'serve', mode: 'development' })
    viteServer = server = await (await createServer(config)).listen()
    viteTestUrl = stripTrailingSlashIfNeeded(
      server.resolvedUrls.local[0],
      server.config.base,
    )
    await page.goto(viteTestUrl)
    // bundled dev serves a self-reloading fallback page until the first
    // bundle completes; tests must not assert against that placeholder.
    // Wait server-side for the first build to settle (success or error) so
    // slow builds (e.g. many HTML inputs) don't race a fixed page timeout.
    // A playground whose first bundle fails keeps the fallback page, and its
    // tests are expected to handle that state themselves.
    // hmr-full-bundle-mode is exempt — it asserts the fallback page itself.
    if (isBundledDev && testName !== 'hmr-full-bundle-mode') {
      const tracker = (server.environments.client.bundledDev as any)
        ?.testTracker
      if (tracker) {
        await vi.waitUntil(
          () => {
            const s = tracker.getState()
            return s.initialBuildCompleted || s.hasBuildError
          },
          { timeout: 40_000 },
        )
      }
      if (tracker?.getState().initialBuildCompleted) {
        await page
          .waitForFunction(
            () => !(globalThis as any).__vite_is_fallback_page__,
            undefined,
            { timeout: 15_000 },
          )
          .catch(() => {})
        // TODO: workaround — an edit fired while no client is connected is
        // dropped (vitejs/vite#23028). Remove this settle once the server
        // buffers updates for clients that connect later.
        await waitForBundledDevSettled()
      }
    }
  } else {
    process.env.VITE_INLINE = 'inline-build'
    let resolvedConfig: ResolvedConfig
    // determine build watch
    const resolvedPlugin: () => PluginOption = () => ({
      name: 'vite-plugin-watcher',
      configResolved(config) {
        resolvedConfig = config
      },
    })
    const buildConfig = mergeConfig(
      await loadConfig({ command: 'build', mode: 'production' }),
      {
        plugins: [resolvedPlugin()],
      },
    )
    if (buildConfig.builder) {
      const builder = await createBuilder(buildConfig)
      await builder.buildApp()
    } else {
      const rollupOutput = await build(buildConfig)
      const isWatch = !!resolvedConfig!.build.watch
      // in build watch,call startStaticServer after the build is complete
      if (isWatch) {
        watcher = rollupOutput as RolldownWatcher
        await notifyRebuildComplete(watcher)
      }
      if (buildConfig.__test__) {
        buildConfig.__test__()
      }
    }

    const previewConfig = await loadConfig({
      command: 'serve',
      mode: 'development',
      isPreview: true,
    })
    const _nodeEnv = process.env.NODE_ENV
    const previewServer = await preview(previewConfig)
    // prevent preview change NODE_ENV
    process.env.NODE_ENV = _nodeEnv
    viteTestUrl = stripTrailingSlashIfNeeded(
      previewServer.resolvedUrls.local[0],
      previewServer.config.base,
    )
    await page.goto(viteTestUrl)
  }
}

/**
 * Send the rebuild complete message in build watch
 */
export async function notifyRebuildComplete(
  watcher: RolldownWatcher,
): Promise<void> {
  let resolveFn: undefined | (() => void)
  const callback = (event: RolldownWatcherEvent): void => {
    if (event.code === 'END') {
      resolveFn?.()
    }
  }
  watcher.on('event', callback)
  await new Promise<void>((resolve) => {
    resolveFn = resolve
  })

  watcher.off('event', callback)
}

export function createInMemoryLogger(logs: string[]): Logger {
  const loggedErrors = new WeakSet<Error | RollupError>()
  const warnedMessages = new Set<string>()

  const logger: Logger = {
    hasWarned: false,
    hasErrorLogged: (err) => loggedErrors.has(err),
    clearScreen: () => {},
    info(msg) {
      logs.push(msg)
    },
    warn(msg) {
      logs.push(msg)
      logger.hasWarned = true
    },
    warnOnce(msg) {
      if (warnedMessages.has(msg)) return
      logs.push(msg)
      logger.hasWarned = true
      warnedMessages.add(msg)
    },
    error(msg, opts) {
      logs.push(msg)
      if (opts?.error) {
        loggedErrors.add(opts.error)
      }
    },
  }

  return logger
}

function setupConsoleWarnCollector(logs: string[]) {
  const warn = console.warn
  console.warn = (...args) => {
    logs.push(args.join(' '))
    return warn.call(console, ...args)
  }
}

export function slash(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTrailingSlashIfNeeded(url: string, base: string): string {
  if (base === '/') {
    return url.replace(/\/$/, '')
  }
  return url
}

declare module 'vite' {
  export interface UserConfig {
    /**
     * special test only hook
     *
     * runs after build and before preview
     */
    __test__?: () => void
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    wsEndpoint: string
  }
}
