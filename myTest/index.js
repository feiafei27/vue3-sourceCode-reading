let { effect, reactive, computed, effectScope } = require("../packages/reactivity/dist/reactivity.cjs")
let { watch } = require("../packages/runtime-core/dist/runtime-core.cjs")

const scope = effectScope()

let person = reactive({
  age: 20
})

scope.run(() => {
  effect(() => {
    console.log(`现在的年龄是 ${person.age}`)
  })
})

person.age++
scope.stop()
person.age++
person.age++