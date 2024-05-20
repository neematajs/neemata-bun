import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  APP_COMMAND,
  Application,
  WorkerType,
  defer,
  importDefault,
} from '@neematajs/application'
import { ApplicationServer, providerWorkerOptions } from '@neematajs/server'
import { config } from 'dotenv'

export const run = async (scriptPath: string) => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      entry: {
        type: 'string',
        multiple: false,
      },
      watch: {
        type: 'boolean',
        multiple: false,
        default: false,
      },
      timeout: {
        type: 'string',
        multiple: false,
      },
      env: {
        type: 'string',
        multiple: true,
        default: [],
      },
    },
  })

  const [command, ...args] = positionals
  const { env: envPaths, watch, entry, swc, timeout, ...kwargs } = values

  const shutdownTimeout =
    (typeof timeout === 'string' ? Number.parseInt(timeout) : undefined) || 1000

  for (const env of envPaths as string[]) {
    if (typeof env === 'string') {
      const { error } = config({ path: env })
      if (error) console.warn(error)
    }
  }

  if (watch) {
    const args = process.argv.slice(2).filter((arg) => arg !== '--watch')
    if (globalThis.Bun) {
      // TODO: execArgv for fork does not work with Bun...
      const runtime = process.argv[0]
      spawnSync(
        runtime,
        [...process.execArgv, '--watch', fileURLToPath(scriptPath), ...args],
        {
          env: process.env,
          stdio: 'inherit',
        },
      )
    } else {
      fork(fileURLToPath(scriptPath), args, {
        execArgv: process.execArgv,
        env: process.env,
        stdio: 'inherit',
      })
    }
  } else {
    const entryPath = resolve(
      process.env.NEEMATA_ENTRY ||
        (typeof entry === 'string' ? entry : swc ? 'index.ts' : 'index.js'),
    )

    let exitTimeout: Timer | undefined = undefined

    const exitProcess = () => {
      if (exitTimeout) clearTimeout(exitTimeout)
      process.exit(0)
    }

    const tryExit = async (cb: any) => {
      if (exitTimeout) return
      exitTimeout = setTimeout(exitProcess, shutdownTimeout)
      try {
        await cb()
      } catch (error) {
        logger.error(error)
      } finally {
        exitProcess()
      }
    }

    const entryApp = await import(entryPath).then((module) => module.default)
    const isCorrectInstance =
      entryApp instanceof ApplicationServer || entryApp instanceof Application

    if (!isCorrectInstance) {
      throw new Error(
        'Invalid entry module. Must be an instance of Application or ApplicationServer',
      )
    }

    const { logger } = entryApp

    process.on('uncaughtException', (error) => logger.error(error))
    process.on('unhandledRejection', (error) => logger.error(error))

    const loadApp = async (workerType: WorkerType, workerOptions = {}) => {
      let app: Application

      if (entryApp instanceof ApplicationServer) {
        const { applicationPath } = entryApp.options

        const options: Parameters<typeof providerWorkerOptions>[0] = {
          id: 0,
          workerType,
          isServer: false,
          workerOptions,
        }
        providerWorkerOptions(options)
        app = await importDefault(applicationPath)
      } else {
        app = entryApp as Application
      }

      return app
    }

    const commands = {
      async start() {
        const terminate = () => tryExit(() => entryApp.stop())
        process.on('SIGTERM', terminate)
        process.on('SIGINT', terminate)
        await entryApp.start()
      },
      async execute() {
        const app = await loadApp(WorkerType.Task)

        const [inputCommand, ...commandArgs] = args

        let [extension, commandName] = inputCommand.split(':')

        if (!commandName) {
          commandName = extension
          // @ts-ignore
          extension = undefined
        }

        const terminate = () => tryExit(() => defer(() => app.stop()))

        process.on('SIGTERM', terminate)
        process.on('SIGINT', terminate)

        await app.initialize()

        const command = app.registry.commands
          .get(extension ?? APP_COMMAND)
          ?.get(commandName)

        if (!command)
          throw new Error(`Unknown application command: ${commandName}`)

        try {
          await command({ args: commandArgs, kwargs })
        } finally {
          terminate()
        }
      },
    }

    if (command in commands === false)
      throw new Error(`Unknown CLI command: ${command}`)

    commands[command]()
  }
}
