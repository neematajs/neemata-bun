import type { BaseServerFormat } from '@neematajs/common'
import { Api, type BaseParser } from './api'
import { Hook, Scope, WorkerType } from './constants'
import { Container, Provider } from './container'
import { EventManager } from './events'
import type { BaseExtension } from './extension'
import { Format } from './format'
import { type Logger, type LoggingOptions, createLogger } from './logger'
import { APP_COMMAND, Registry, printRegistry } from './registry'
import {
  type BaseSubscriptionManager,
  BasicSubscriptionManager,
} from './subscription'
import { type BaseTaskRunner, Tasks } from './tasks'
import type { BaseTransport, BaseTransportConnection } from './transport'
import type {
  AnyModule,
  ClassConstructor,
  ExecuteFn,
  ExtensionApplication,
  Merge,
} from './types'
import { merge } from './utils/functions'

export type ApplicationOptions = {
  type: WorkerType
  api: {
    timeout: number
    formats: BaseServerFormat[]
  }
  tasks: {
    timeout: number
    runner?: BaseTaskRunner
  }
  events?: {
    parser?: BaseParser
  }
  logging?: LoggingOptions
}

export class Application<AppModules extends Record<string, AnyModule> = {}> {
  static logger = new Provider<Logger>().withDescription('Logger')
  static execute = new Provider<ExecuteFn>().withDescription('Task execution')
  static eventManager = new Provider<EventManager>().withDescription(
    'Event manager',
  )

  readonly api: Api
  readonly tasks: Tasks
  readonly logger: Logger
  readonly registry: Registry
  readonly container: Container
  readonly eventManager: EventManager
  readonly format: Format
  subManager!: BaseSubscriptionManager

  readonly modules = {} as AppModules
  readonly transports = new Set<BaseTransport>()
  readonly extensions = new Set<BaseExtension>()
  readonly connections = new Map<string, BaseTransportConnection>()

  constructor(readonly options: ApplicationOptions) {
    this.logger = createLogger(
      this.options.logging,
      `${this.options.type}Worker`,
    )

    this.registry = new Registry(this)
    this.eventManager = new EventManager(this)
    this.format = new Format(this.options.api.formats)

    // create unexposed container for internal providers, which never gets disposed
    const container = new Container(this)

    container.provide(Application.logger, this.logger)
    container.provide(Application.eventManager, this.eventManager)
    container.provide(Application.execute, this.execute.bind(this))

    // create a global container for rest of the application
    // including transports, extensions, etc.
    this.container = container.createScope(Scope.Global)

    this.api = new Api(this, this.options.api)
    this.tasks = new Tasks(this, this.options.tasks)

    this.withSubscriptionManager(BasicSubscriptionManager)
  }

  async initialize() {
    await this.registry.hooks.call(Hook.BeforeInitialize, { concurrent: false })
    this.initializeEssential()
    await this.registry.load()
    await this.container.load()
    await this.registry.hooks.call(Hook.AfterInitialize, { concurrent: false })
  }

  async start() {
    await this.initialize()
    await this.registry.hooks.call(Hook.BeforeStart, { concurrent: false })
    if (this.isApiWorker) {
      for (const transport of this.transports) {
        await transport
          .start()
          .catch((cause) =>
            this.logger.error(new Error('Transport start error', { cause })),
          )
      }
    }
    await this.registry.hooks.call(Hook.AfterStart, { concurrent: false })
  }

  async stop() {
    await this.registry.hooks.call(Hook.BeforeStop, { concurrent: false })
    if (this.isApiWorker) {
      for (const transport of this.transports) {
        await transport
          .stop()
          .catch((cause) =>
            this.logger.error(new Error('Transport stop error', { cause })),
          )
      }
    }
    await this.registry.hooks.call(Hook.AfterStop, { concurrent: false })
    await this.terminate()
  }

  async terminate() {
    await this.registry.hooks.call(Hook.BeforeTerminate, {
      concurrent: false,
      reverse: true,
    })
    await this.container.dispose()
    this.registry.clear()
    await this.registry.hooks.call(Hook.AfterTerminate, {
      concurrent: false,
      reverse: true,
    })
  }

  execute: ExecuteFn = (task, ...args: any[]) => {
    return this.tasks.execute(task, ...args)
  }

  withTransport<
    T extends ClassConstructor<BaseTransport>,
    I extends InstanceType<T>,
  >(
    transportClass: T,
    ...args: null extends I['_']['options'] ? [] : [I['_']['options']]
  ) {
    const [options] = args
    const transport = this.initializeExtension(transportClass, options) as I
    this.transports.add(transport)
    return this
  }

  withExtension<
    T extends ClassConstructor<BaseExtension>,
    I extends InstanceType<T>,
  >(
    extenstionClass: T,
    ...args: null extends I['_']['options'] ? [] : [I['_']['options']]
  ) {
    const [options] = args
    const extension = this.initializeExtension(extenstionClass, options) as I
    this.extensions.add(extension)
    return this
  }

  withSubscriptionManager(
    subManagerClass: ClassConstructor<BaseSubscriptionManager>,
  ) {
    this.subManager = this.initializeExtension(
      subManagerClass,
    ) as BaseSubscriptionManager
    return this
  }

  withModules<T extends Record<string, AnyModule>>(modules: T) {
    // @ts-expect-error
    this.modules = merge(this.modules, modules)
    return this as unknown as Application<Merge<AppModules, T>>
  }

  private get isApiWorker() {
    return this.options.type === WorkerType.Api
  }

  private initializeExtension<
    T extends ClassConstructor<BaseExtension>,
    I extends InstanceType<T>,
  >(extensionClass: T, options?: I['_']['options']) {
    const logger = this.logger.child({})
    const app: ExtensionApplication = {
      logger,
      type: this.options.type,
      api: this.api,
      format: this.format,
      container: this.container,
      registry: this.registry,
      connections: {
        add: this.addConnection.bind(this),
        remove: this.removeConnection.bind(this),
        get: this.getConnection.bind(this),
      },
    }
    const instance = new extensionClass(app, options)
    app.logger.setBindings({ $group: instance.name })
    instance.initialize?.()
    return instance
  }

  private initializeEssential() {
    const taskCommand = this.tasks.command.bind(this.tasks)
    this.registry.registerCommand(APP_COMMAND, 'task', (arg) =>
      taskCommand(arg).then(({ error }) => {
        if (error) this.logger.error(error)
      }),
    )
    this.registry.registerCommand(APP_COMMAND, 'registry', () => {
      printRegistry(this.registry)
    })
  }

  private addConnection(connection: BaseTransportConnection) {
    this.connections.set(connection.id, connection)
    this.registry.hooks.call(
      Hook.OnConnection,
      { concurrent: true },
      connection,
    )
  }

  private removeConnection(connectionOrId: BaseTransportConnection | string) {
    const connection =
      typeof connectionOrId === 'string'
        ? this.connections.get(connectionOrId)
        : connectionOrId
    if (connection) {
      this.connections.delete(connection.id)
      this.registry.hooks.call(
        Hook.OnDisconnection,
        { concurrent: true },
        connection,
      )
    }
  }

  private getConnection(id: string) {
    return this.connections.get(id)
  }
}
