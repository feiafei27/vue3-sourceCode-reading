import {
  Component,
  ConcreteComponent,
  currentInstance,
  ComponentInternalInstance,
  ComponentOptions
} from './component'
import { isFunction } from '@vue/shared'
import { ComponentPublicInstance } from './componentPublicInstance'
import { createVNode, VNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { ref } from '@vue/reactivity'
import { handleError, ErrorCodes } from './errorHandling'
import { isKeepAlive } from './components/KeepAlive'
import { queueJob } from './scheduler'

export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  loader: AsyncComponentLoader<T>
  loadingComponent?: Component
  errorComponent?: Component
  delay?: number
  timeout?: number
  suspensible?: boolean
  onError?: (
    error: Error,
    retry: () => void,
    fail: () => void,
    attempts: number
  ) => any
}

export const isAsyncWrapper = (i: ComponentInternalInstance | VNode): boolean =>
  !!(i.type as ComponentOptions).__asyncLoader

// 定义异步组件，返回值是一个组件，组件的本质是一个对象
export function defineAsyncComponent<
  T extends Component = { new (): ComponentPublicInstance }
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // source 有可能是函数，也有可能是对象
  // 如果 source 是函数类型的话，将 source 包装成对象形式
  if (isFunction(source)) {
    source = { loader: source }
  }

  // 从 source 配置对象中获取异步组件的配置信息
  const {
    loader,
    loadingComponent,
    errorComponent,
    delay = 200,
    timeout, // undefined = never times out
    onError: userOnError
  } = source

  let pendingRequest: Promise<ConcreteComponent> | null = null
  let resolvedComp: ConcreteComponent | undefined

  // 请求重试次数
  let retries = 0
  // 重新进行异步组件的请求
  const retry = () => {
    // 请求次数加一
    retries++
    // 重置 pendingRequest
    pendingRequest = null
    // 重新执行 load 函数
    return load()
  }

  // 加载异步组件的工具函数，返回值是一个 Promise
  const load = (): Promise<ConcreteComponent> => {
    // 因为异步组件的请求需要不少时间，所以有可能页面中渲染了多次异步组件，并且异步组件还没有成功返回。
    // 渲染了多次就会多次执行 load 函数，但没必要真的多次向后端发送请求，只需要等第一个请求即可
    return (
      // 如果 pendingRequest Promise 存在的话，说明之前已经发送了异步组件的请求，此时直接返回 pendingRequest 这个 Promise 变量即可
      pendingRequest ||
      // 如果 pendingRequest 不存在的话，说明此时是第一次进行异步组件的请求，接下来进行请求
      // 执行 loader 函数，这个函数是用户配置的异步请求加载函数，返回值是一个 Promise，将返回的 Promise 设置到 pendingRequest 变量上
      (pendingRequest =
        loader()
          .catch(err => {
            // 组件异步请求失败
            err = err instanceof Error ? err : new Error(String(err))
            if (userOnError) {
              // 如果用户配置了 onError 函数的话，则返回一个新的 Promise，并将能够触发 resolve 和 reject 的函数作为参数执行 onError 函数
              // 在 userRetry 函数中，我们能够进行组件异步请求的重试。
              return new Promise((resolve, reject) => {
                const userRetry = () => resolve(retry())
                const userFail = () => reject(err)
                userOnError(err, userRetry, userFail, retries + 1)
              })
            } else {
              // 如果没有配置用户 onError 函数的话，直接抛出错误即可
              throw err
            }
          })
          .then((comp: any) => {
            // 组件异步请求成功，将 comp 设置到 resolvedComp 变量上
            resolvedComp = comp
            return comp
          }))
    )
  }

  // 返回包装后的组件
  return defineComponent({
    name: 'AsyncComponentWrapper',

    __asyncLoader: load,

    get __asyncResolved() {
      return resolvedComp
    },
    // setup 函数会在组件挂载的时候执行一次，如果 setup 函数的返回值是一个函数的话，
    // 则这个函数就会成为组件的 render 函数
    setup() {
      // 在执行组件 setup 函数前，Vue 会将当前的组件实例设置到全局的 currentInstance 变量上
      // 获取当前的组件实例
      const instance = currentInstance!

      // 加载完的组件会保存在 resolvedComp 变量上
      // 如果 resolvedComp 存在的话，说明异步组件已经加载完成了，此时直接返回一个 render 函数即可
      if (resolvedComp) {
        // 返回的函数是组件的 render 函数，render 函数的作用是创建并返回 VNode
        return () => createInnerComp(resolvedComp!, instance)
      }

      // 代码执行到这里，说明异步组件还没有加载完成，接下来进行异步组件的加载
      const onError = (err: Error) => {
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */
        )
      }

      // 接下来，声明一系列的标识变量，并且这些变量是响应式数据，这些变量会在下面返回的 render 函数中使用
      // 用于标识异步组件是否加载完成的标识
      const loaded = ref(false)
      const error = ref()
      // delay 参数的作用是：delay ms 后再显示 loading 组件
      // delayed 是一个 boolean 值，一开始为 true
      const delayed = ref(!!delay)

      // 如果设置了 delay 的话，进行 setTimeout 计时
      if (delay) {
        // delay ms 之后，将 delayed 的值设为 false，当值为 false 时，就可以显示 loading 组件了
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

      // timeout 参数的作用：如果 timeout ms 后，组件还没有加载完成的话，就显示 error 组件
      if (timeout != null) {
        setTimeout(() => {
          // timeout ms 之后，如果组件还没有加载完成并且错误信息还没有被设置的话，进行错误信息的处理
          if (!loaded.value && !error.value) {
            // new 一个 Error 对象
            const err = new Error(
              `Async component timed out after ${timeout}ms.`
            )
            // 调用用户传递 onError 回调函数
            onError(err)
            // 将 err 设置到 error 上面
            error.value = err
          }
        }, timeout)
      }

      // 进行异步组件的请求加载
      load()
        .then(() => {
          // 异步组件加载完成后，将 loaded 标识设置为 true
          loaded.value = true
          // 如果当前异步组件的父组件是 keep-alive 的话，则执行父组件 keep-alive 的更新
          if (instance.parent && isKeepAlive(instance.parent.vnode)) {
            queueJob(instance.parent.update)
          }
        })
        .catch(err => {
          // 如果异步组件加载失败的话，执行 onError 回调函数，并将错误设置到 error 标识变量上
          onError(err)
          error.value = err
        })

      // 返回的 render 函数，这个 render 函数就是异步组件的 render 函数
      // 在这个 render 函数中，使用了 loaded、error、delayed 等响应式数据，等异步组件的加载状态发生变化时，
      // 就会变更这些响应式数据，响应式数据发生了变化，就会重新执行 render 函数，重新渲染异步组件。
      // 例如一开始异步组件渲染的是 loading 组件，异步组件加载完成后，变更响应式数据，重新执行 render 函数渲染真正的组件。
      return () => {
        // render 函数根据标识变量，渲染不同的内容
        // 如果 loaded 为 true，说明异步组件已经加载完成了，如果 resolvedComp 也有的话，返回异步组件的 VNode
        if (loaded.value && resolvedComp) {
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) {
          // error 变量是标识异步组件加载是否出错的变量，如果 error 中有错误信息，并且有 error 组件的话，
          // 返回 Error 组件的 VNode
          return createVNode(errorComponent as ConcreteComponent, {
            error: error.value
          })
        } else if (loadingComponent && !delayed.value) {
          // delayed 是标识是否显示 loading 组件的变量，当 delayed 的值为 false 并且 loading 组件配置了的话
          // 返回 loading 组件的 VNode
          return createVNode(loadingComponent as ConcreteComponent)
        }
      }
    }
  }) as T
}

function createInnerComp(
  comp: ConcreteComponent,
  {
    vnode: { ref, props, children, shapeFlag },
    parent
  }: ComponentInternalInstance
) {
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  vnode.ref = ref
  return vnode
}
