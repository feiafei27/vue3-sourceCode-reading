import {
  ConcreteComponent,
  getCurrentInstance,
  SetupContext,
  ComponentInternalInstance,
  LifecycleHooks,
  currentInstance,
  getComponentName,
  ComponentOptions
} from '../component'
import {
  VNode,
  isVNode,
  VNodeProps,
  invokeVNodeHook
} from '../vnode'
import { warn } from '../warning'
import {
  onBeforeUnmount,
  injectHook,
  onUnmounted,
  onMounted,
  onUpdated
} from '../apiLifecycle'
import {
  isString,
  isArray,
  ShapeFlags,
  remove,
  invokeArrayFns
} from '@vue/shared'
import { watch } from '../apiWatch'
import {
  RendererInternals,
  queuePostRenderEffect,
  MoveType,
  RendererElement,
  RendererNode
} from '../renderer'
import { ComponentRenderContext } from '../componentPublicInstance'
import { isAsyncWrapper } from '../apiAsyncComponent'

type MatchPattern = string | RegExp | (string | RegExp)[]

export interface KeepAliveProps {
  include?: MatchPattern
  exclude?: MatchPattern
  max?: number | string
}

type CacheKey = string | number | symbol | ConcreteComponent
type Cache = Map<CacheKey, VNode>
type Keys = Set<CacheKey>

export interface KeepAliveContext extends ComponentRenderContext {
  renderer: RendererInternals
  activate: (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    isSVG: boolean,
    optimized: boolean
  ) => void
  deactivate: (vnode: VNode) => void
}

export const isKeepAlive = (vnode: VNode): boolean =>
  (vnode.type as any).__isKeepAlive

const KeepAliveImpl: ComponentOptions = {
  name: `KeepAlive`,

  // Marker for special handling inside the renderer. We are not using a ===
  // check directly on KeepAlive in the renderer, because importing it directly
  // would prevent it from being tree-shaken.
  __isKeepAlive: true,

  props: {
    include: [String, RegExp, Array],
    exclude: [String, RegExp, Array],
    max: [String, Number]
  },

  setup(props: KeepAliveProps, { slots }: SetupContext) {
    // 获取当前的 KeepAlive 组件实例
    const instance = getCurrentInstance()!
    // 获取组件实例的 ctx 属性，这个属性对象中存储有渲染器
    const sharedContext = instance.ctx as KeepAliveContext

    // 用于缓存组件的一个 Map 实例，键是组件 VNode 的 key，值是组件的 VNode
    const cache: Cache = new Map()
    // 用于存储缓存组件 key 的 Set 实例
    const keys: Keys = new Set()
    // 用于存储当前 KeepAlive 组件的子组件的 VNode
    let current: VNode | null = null

    const parentSuspense = instance.suspense

    // 获取 sharedContext 中保存的渲染器方法
    const {
      renderer: {
        p: patch,
        m: move,
        um: _unmount,
        o: { createElement }
      }
    } = sharedContext

    // 用于存储缓存组件 DOM 的容器
    const storageContainer = createElement('div')

    // 封装两个工具函数到 instance.ctx 中，这两个工具函数会在渲染器中的 processComponent 和 unmount 函数中使用
    // 当渲染器发现 VNode 是经过 KeepAlive 处理缓存过的话，会使用这两个自定义函数进行处理，不会使用渲染器中的默认操作进行处理
    sharedContext.activate = (vnode, container, anchor, isSVG, optimized) => {
      const instance = vnode.component!
      // 将之前已经渲染的 DOM 从 storageContainer 中移动到 container 中
      move(vnode, container, anchor, MoveType.ENTER, parentSuspense)
      // in case props have changed
      patch(
        instance.vnode,
        vnode,
        container,
        anchor,
        instance,
        parentSuspense,
        isSVG,
        vnode.slotScopeIds,
        optimized
      )
      queuePostRenderEffect(() => {
        instance.isDeactivated = false
        if (instance.a) {
          invokeArrayFns(instance.a)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeMounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
      }, parentSuspense)
    }
    sharedContext.deactivate = (vnode: VNode) => {
      const instance = vnode.component!
      // 将失活组件的真实 DOM 隐藏到 storageContainer 中
      move(vnode, storageContainer, null, MoveType.LEAVE, parentSuspense)
      queuePostRenderEffect(() => {
        if (instance.da) {
          invokeArrayFns(instance.da)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeUnmounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
        instance.isDeactivated = true
      }, parentSuspense)
    }

    function unmount(vnode: VNode) {
      // reset the shapeFlag so it can be properly unmounted
      resetShapeFlag(vnode)
      _unmount(vnode, instance, parentSuspense, true)
    }
    function pruneCache(filter?: (name: string) => boolean) {
      cache.forEach((vnode, key) => {
        const name = getComponentName(vnode.type as ConcreteComponent)
        if (name && (!filter || !filter(name))) {
          pruneCacheEntry(key)
        }
      })
    }
    function pruneCacheEntry(key: CacheKey) {
      const cached = cache.get(key) as VNode
      if (!current || cached.type !== current.type) {
        unmount(cached)
      } else if (current) {
        // current active instance should no longer be kept-alive.
        // we can't unmount it now but it might be later, so reset its flag now.
        resetShapeFlag(current)
      }
      cache.delete(key)
      keys.delete(key)
    }

    // 监控 include 和 exclude 响应式属性，当这两个属性发生变化的时候，对缓存的组件进行修剪。
    // 只有组件在 include 中，并不在 exclude 中时，组件才能够被 KeepAlive 缓存。
    watch(
      () => [props.include, props.exclude],
      ([include, exclude]) => {
        // 根据最新的 include 和 exclude 进行组件缓存的修剪
        include && pruneCache(name => matches(include, name))
        exclude && pruneCache(name => !matches(exclude, name))
      },
      // prune post-render after `current` has been updated
      { flush: 'post', deep: true }
    )

    // cache sub tree after render
    let pendingCacheKey: CacheKey | null = null
    // 缓存 VNode 的工具函数
    const cacheSubtree = () => {
      // fix #1621, the pendingCacheKey could be 0
      if (pendingCacheKey != null) {
        // 缓存的 VNode 是当前 KeepAlive 组件实例的 subTree 属性
        // KeepAlive 组件的 render 函数返回的 VNode 是子组件的 VNode，
        // 但是在渲染器的视角来看，是谁的 render 函数返回的 VNode，那么这个 VNode 就是属于那个组件实例，所以会将上次渲染的 VNode
        // 设置到当前 KeepAlive 组件实例的 subTree 属性上
        cache.set(pendingCacheKey, getInnerChild(instance.subTree))
      }
    }
    // 在组件挂载和组件升级的时候进行组件的缓存操作
    onMounted(cacheSubtree)
    onUpdated(cacheSubtree)
    onBeforeUnmount(() => {
      cache.forEach(cached => {
        const { subTree, suspense } = instance
        const vnode = getInnerChild(subTree)
        if (cached.type === vnode.type) {
          // current instance will be unmounted as part of keep-alive's unmount
          resetShapeFlag(vnode)
          // but invoke its deactivated hook here
          const da = vnode.component!.da
          da && queuePostRenderEffect(da, suspense)
          return
        }
        unmount(cached)
      })
    })

    // 返回 KeepAlive 的 render 函数，render 函数的作用是：返回 VNode，VNode 作为参数用于渲染器的渲染
    return () => {
      pendingCacheKey = null
      // 如果当前的 KeepAlive 组件没有子组件的话，直接 return 即可，不用做任何操作
      if (!slots.default) {
        return null
      }
      // 通过 slots.default() 获取当前 KeepAlive 的默认子组件信息
      const children = slots.default()
      // 获取第一个子组件
      const rawVNode = children[0]

      if (children.length > 1) {
        // 如果有多个子组件的话，则打印出警告，KeepAlive 只允许有一个子组件，如果有多个的话，则不进行缓存处理
        if (__DEV__) {
          warn(`KeepAlive should contain exactly one component child.`)
        }
        current = null
        // 直接返回子组件的 VNode
        return children
      } else if (
        !isVNode(rawVNode) ||
        (!(rawVNode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) &&
          !(rawVNode.shapeFlag & ShapeFlags.SUSPENSE))
      ) {
        current = null
        return rawVNode
      }

      // 接下来进行缓存的真正处理
      let vnode = getInnerChild(rawVNode)
      const comp = vnode.type as ConcreteComponent

      // 获取当前子组件的 name 名称
      const name = getComponentName(
        isAsyncWrapper(vnode)
          ? (vnode.type as ComponentOptions).__asyncResolved || {}
          : comp
      )

      const { include, exclude, max } = props

      // 根据 name、include、exclude 判断当前的子组件是否可以进行缓存
      if (
        (include && (!name || !matches(include, name))) ||
        (exclude && name && matches(exclude, name))
      ) {
        current = vnode
        // 当前的子组件不满足缓存要求，直接返回 rawVNode
        return rawVNode
      }

      // 获取当前缓存的 key
      const key = vnode.key == null ? comp : vnode.key
      // 从 cache 中获取缓存的 VNode
      const cachedVNode = cache.get(key)

      // 将 key 设置到 pendingCacheKey 变量上
      pendingCacheKey = key

      // 如果 cachedVNode 存在的话，说明这个组件之前已经被缓存了，此时直接将 cachedVNode 的 el 和 component 赋值到 vnode 上即可
      if (cachedVNode) {
        // copy over mounted state
        vnode.el = cachedVNode.el
        vnode.component = cachedVNode.component
        // 将 vnode 的 shapeFlag 属性设置为 COMPONENT_KEPT_ALIVE，
        // 在渲染器中，如果发现 vnode 的 shapeFlag 属性是 COMPONENT_KEPT_ALIVE 的话，
        // 会使用上面定义的 sharedContext.deactivate 函数进行处理
        vnode.shapeFlag |= ShapeFlags.COMPONENT_KEPT_ALIVE
        // make this key the freshest
        // 将 key 从 keys 中删除并重新添加 key，key 放在 keys 的最后意味着对应的组件是最新的
        // 当缓存的组件数量超过 max 时，会将缓存的最旧组件移除
        keys.delete(key)
        keys.add(key)
      } else {
        // 如果 cachedVNode 不存在的话，说明当前的子组件是第一个渲染在 KeepAlive 下面，此时需要进行缓存处理
        // 首先将缓存的 key 保存到 keys 中
        keys.add(key)
        // prune oldest entry
        // 如果当前 keys 的个数超过了 max 的话，需要将第一个 key 对应组件缓存移除掉
        if (max && keys.size > parseInt(max as string, 10)) {
          // 使用 pruneCacheEntry 函数将指定 key 对应的组件缓存移除掉
          pruneCacheEntry(keys.values().next().value)
        }
      }
      // 将 vnode 的 shapeFlag 标志设置为 COMPONENT_SHOULD_KEEP_ALIVE，这可以避免 vnode 被卸载
      vnode.shapeFlag |= ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
      // 将 vnode 设置到 current 变量上
      current = vnode
      // 最终返回用于渲染的 vnode
      return vnode
    }
  }
}

if (__COMPAT__) {
  KeepAliveImpl.__isBuildIn = true
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
export const KeepAlive = KeepAliveImpl as any as {
  __isKeepAlive: true
  new (): {
    $props: VNodeProps & KeepAliveProps
  }
}

function matches(pattern: MatchPattern, name: string): boolean {
  if (isArray(pattern)) {
    return pattern.some((p: string | RegExp) => matches(p, name))
  } else if (isString(pattern)) {
    return pattern.split(',').includes(name)
  } else if (pattern.test) {
    return pattern.test(name)
  }
  /* istanbul ignore next */
  return false
}

export function onActivated(
  hook: Function,
  target?: ComponentInternalInstance | null
) {
  registerKeepAliveHook(hook, LifecycleHooks.ACTIVATED, target)
}

export function onDeactivated(
  hook: Function,
  target?: ComponentInternalInstance | null
) {
  registerKeepAliveHook(hook, LifecycleHooks.DEACTIVATED, target)
}

function registerKeepAliveHook(
  hook: Function & { __wdc?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance | null = currentInstance
) {
  // cache the deactivate branch check wrapper for injected hooks so the same
  // hook can be properly deduped by the scheduler. "__wdc" stands for "with
  // deactivation check".
  const wrappedHook =
    hook.__wdc ||
    (hook.__wdc = () => {
      // only fire the hook if the target instance is NOT in a deactivated branch.
      let current: ComponentInternalInstance | null = target
      while (current) {
        if (current.isDeactivated) {
          return
        }
        current = current.parent
      }
      return hook()
    })
  injectHook(type, wrappedHook, target)
  // In addition to registering it on the target instance, we walk up the parent
  // chain and register it on all ancestor instances that are keep-alive roots.
  // This avoids the need to walk the entire component tree when invoking these
  // hooks, and more importantly, avoids the need to track child components in
  // arrays.
  if (target) {
    let current = target.parent
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current)
      }
      current = current.parent
    }
  }
}

function injectToKeepAliveRoot(
  hook: Function & { __weh?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance,
  keepAliveRoot: ComponentInternalInstance
) {
  // injectHook wraps the original for error handling, so make sure to remove
  // the wrapped version.
  const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */)
  onUnmounted(() => {
    remove(keepAliveRoot[type]!, injected)
  }, target)
}

function resetShapeFlag(vnode: VNode) {
  let shapeFlag = vnode.shapeFlag
  if (shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
    shapeFlag -= ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
  }
  if (shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
    shapeFlag -= ShapeFlags.COMPONENT_KEPT_ALIVE
  }
  vnode.shapeFlag = shapeFlag
}

function getInnerChild(vnode: VNode) {
  return vnode.shapeFlag & ShapeFlags.SUSPENSE ? vnode.ssContent! : vnode
}
