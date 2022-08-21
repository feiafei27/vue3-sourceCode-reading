import { isObject, toRawType, def } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from './collectionHandlers'
import type { UnwrapRefSimple, Ref, RawSymbol } from './ref'

export const enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw'
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.IS_SHALLOW]?: boolean
  [ReactiveFlags.RAW]?: any
}

export const reactiveMap = new WeakMap<Target, any>()
export const shallowReactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()
export const shallowReadonlyMap = new WeakMap<Target, any>()

const enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2
}

function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

// only unwrap nested ref
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

/**
 * Creates a reactive copy of the original object.
 *
 * The reactive conversion is "deep"—it affects all nested properties. In the
 * ES2015 Proxy based implementation, the returned proxy is **not** equal to the
 * original object. It is recommended to work exclusively with the reactive
 * proxy and avoid relying on the original object.
 *
 * A reactive object also automatically unwraps refs contained in it, so you
 * don't need to use `.value` when accessing and mutating their value:
 *
 * ```js
 * const count = ref(0)
 * const obj = reactive({
 *   count
 * })
 *
 * obj.count++
 * obj.count // -> 1
 * count.value // -> 1
 * ```
 */
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // 如果当前的 target 参数是只读数据的话，直接 return target。
  // 只读数据无需转换成响应式的，因为只读数据不会变更，进而也就不会触发依赖执行，响应式的特征没有意义
  if (isReadonly(target)) {
    return target
  }
  // 调用 createReactiveObject 函数完成响应式数据的转换
  return createReactiveObject(
    // 转换的目标对象
    target,
    // 是否是只读的
    false,
    // 用于处理 Object 和 Array 数据类型的 Proxy handler
    mutableHandlers,
    // 用于处理 Map、Set、WeakMap、WeakSet 数据类型的 Proxy handler
    mutableCollectionHandlers,
    // 一个 Map 数据，键是转换成响应式的原生对象，值是其对应的响应式对象。
    // 这个数据起到一个响应式对象缓存的作用
    reactiveMap
  )
}

export declare const ShallowReactiveMarker: unique symbol

export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

/**
 * Return a shallowly-reactive copy of the original object, where only the root
 * level properties are reactive. It also does not auto-unwrap refs (even at the
 * root level).
 */
export function shallowReactive<T extends object>(
  target: T
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends WeakMap<infer K, infer V>
  ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends Set<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends ReadonlySet<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends WeakSet<infer U>
  ? WeakSet<DeepReadonly<U>>
  : T extends Promise<infer U>
  ? Promise<DeepReadonly<U>>
  : T extends Ref<infer U>
  ? Readonly<Ref<DeepReadonly<U>>>
  : T extends {}
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : Readonly<T>

/**
 * Creates a readonly copy of the original object. Note the returned copy is not
 * made reactive, but `readonly` can be called on an already reactive object.
 */
// 实现功能的重点在 readonlyHandlers 和 readonlyCollectionHandlers
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  )
}

/**
 * Returns a reactive-copy of the original object, where only the root level
 * properties are readonly, and does NOT unwrap refs nor recursively convert
 * returned properties.
 * This is used for creating the props proxy object for stateful components.
 */
export function shallowReadonly<T extends object>(target: T): Readonly<T> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  )
}

function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>
) {
  // 判断 target 是不是对象类型，如果不是的话，直接 return target
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // 如果 target 已经是一个代理数据的话，直接返回它。
  // 例外情况：readonly 类型的数据也会被当做响应式对象，直接返回。
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // 查看当前的 target 是不是已经被转化成响应式数据了，如果已经被转化成响应式数据的话，
  // 则直接返回缓存中的对应代理对象。
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // 获取当前 target 的数据类型，数据类型有三大类，第一类是常规代理数据，如：Object、Array
  // 第二大类是收集类，如：Map、Set、WeakMap、WeakSet
  // 第三大类是非法类，也就是说除了上面 6 种数据类型，其他数据都无法转换成响应式的。
  const targetType = getTargetType(target)
  // 如果当前的数据类型是 INVALID 的话，直接返回 target
  if (targetType === TargetType.INVALID) {
    return target
  }
  // 创建 Proxy 对象，并且根据 target 数据类型使用不同的 handler
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  // 将当前转换的响应式数据缓存到 proxyMap 中
  proxyMap.set(target, proxy)
  // 返回代理响应式数据
  return proxy
}

// 判断 value 是不是通过 reactive() 或者 shallowReactive() 创建出来的
export function isReactive(value: unknown): boolean {
  // 我们可能将一个响应式对象作为 readonly 函数的参数创建出一个只读的代理对象
  // 像这种只读对象 isReactive 函数也认为它是通过 reactive 或者 shallowReactive 创建出来的
  // 判断 value 是不是只读的
  if (isReadonly(value)) {
    // 如果是的话，将 value[ReactiveFlags.RAW] 作为 isReactive 函数的参数递归进行判断
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  // 判断 value 中的 [ReactiveFlags.IS_REACTIVE] 属性标志位是否为 true 即可。
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

// 判断 value 是不是只读的
// 判断 value[ReactiveFlags.IS_READONLY] 属性标志位是否为 true 即可。
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

// 判断 value 是不是一个代理对象
export function isProxy(value: unknown): boolean {
  // 使用的是 ||，所以下面的两个条件只要一个为 true，value 就会被判断为是一个代理对象。
  return isReactive(value) || isReadonly(value)
}

export function toRaw<T>(observed: T): T {
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

export function markRaw<T extends object>(
  value: T
): T & { [RawSymbol]?: true } {
  def(value, ReactiveFlags.SKIP, true)
  return value
}

export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

export const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value
