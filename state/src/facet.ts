import {Transaction} from "./transaction"
import {EditorState} from "./state"

/// A facet is a value that is assicated with a state and can be
/// influenced by any number of extensions. Extensions can provide
/// input values for the facet, and the facet combines those into an
/// output value.
///
/// Examples of facets are the theme styles associated with an editor
/// (which are all stored) or the tab size (which is reduced to a
/// single value, using the input with the hightest precedence).
export type Facet<Input, Output> = (value: Input) => Extension

/// Config object passed to [`defineFacet`](#state.defineFacet).
export type FacetConfig<Input, Output> = {
  /// How to combine the input values into a single output value. When
  /// not given, the array of input values becomes the output. This
  /// will immediately be called on creating the facet, with an empty
  /// array, to compute the facet's default value when no inputs are
  /// present.
  combine?: (value: readonly Input[]) => Output,
  /// How to compare output values to determine whether the value of
  /// the facet changed. Defaults to comparing by `===` or, if no
  /// `combine` function was given, comparing each element of the
  /// array with `===`.
  compare?: (a: Output, b: Output) => boolean,
  /// How to compare input values to avoid recomputing the output
  /// value when no inputs changed. Defaults to comparing with `===`.
  compareInput?: (a: Input, b: Input) => boolean,
  /// Static facets can not contain dynamic inputs.
  static?: boolean
}

/// Define a new facet. The resulting value can be called with an
/// input value to create an extension that simply provides a value
/// for the facet, or passed to
/// [`EditorState.facet`](#state.EditorState.facet) to read the output
/// value of the facet for a given state.
export function defineFacet<Input, Output = readonly Input[]>(config: FacetConfig<Input, Output> = {}): Facet<Input, Output> {
  let data = new FacetData<Input, Output>(config.combine || ((a: any) => a) as any,
                                          config.compareInput || ((a, b) => a === b),
                                          config.compare || (!config.combine ? sameArray as any : (a, b) => a === b),
                                          !!config.static)
  let facet = function(value: Input) {
    return new FacetProvider<Input>([], data, Provider.Static, value)
  }
  ;(facet as any)._data = data
  return facet
}

/// Create an extension that computes a value for the given facet from
/// a state. You must take care to declare the parts of the state that
/// this value depends on, since your function is only called again
/// for a new state when one of those parts changed.
///
/// In most cases, you'll want to use
/// [`StateField.provide`](#state.StateField^provide) instead.
export function computedFacet<T>(facet: Facet<T, any>, depends: readonly Slot[],
                                 get: (state: EditorState) => T): Extension {
  let data = FacetData.get(facet)
  if (data.isStatic) throw new Error("Can't compute a static facet")
  return new FacetProvider<T>(depends, data, Provider.Single, get)
}

/// Create an extension that computes zero or more values for a given
/// facet from a state.
export function computedFacetN<T>(facet: Facet<T, any>, depends: readonly Slot[],
                                  get: (state: EditorState) => readonly T[]): Extension {
  let data = FacetData.get(facet)
  if (data.isStatic) throw new Error("Can't compute a static facet")
  return new FacetProvider<T>(depends, data, Provider.Multi, get)
}

let nextID = 0

export class FacetData<Input, Output> {
  readonly id = nextID++
  readonly default: Output

  constructor(
    readonly combine: (values: readonly Input[]) => Output,
    readonly compareInput: (a: Input, b: Input) => boolean,
    readonly compare: (a: Output, b: Output) => boolean,
    readonly isStatic: boolean
  ) {
    this.default = combine([])
  }

  static get<Input, Output>(f: Facet<Input, Output>): FacetData<Input, Output> {
    let value = (f as any)._data
    if (!value) throw new Error("No facet data for function " + f)
    return value
  }
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a == b || a.length == b.length && a.every((e, i) => e === b[i])
}

type Slot = Facet<any, any> | StateField<any> | "doc" | "selection"

/// Marks a value as an [`Extension`](#state.Extension).
declare const isExtension: unique symbol

const enum Provider { Static, Single, Multi }

class FacetProvider<Input> {
  readonly id = nextID++

  constructor(readonly dependencies: readonly Slot[],
              readonly facet: FacetData<Input, any>,
              readonly type: Provider,
              readonly value: ((state: EditorState) => Input) | ((state: EditorState) => readonly Input[]) | Input) {}

  dynamicSlot(addresses: {[id: number]: number}) {
    let getter: (state: EditorState) => any = this.value as any
    let compare = this.facet.compareInput
    let idx = addresses[this.id] >> 1
    let depDoc = false, depSel = false, depAddrs: number[] = []
    for (let dep of this.dependencies) {
      if (dep == "doc") depDoc = true
      else if (dep == "selection") depSel = true
      else {
        let id = dep instanceof StateField ? dep.id : FacetData.get(dep).id
        if ((addresses[id] & 1) == 0) depAddrs.push(addresses[id])
      }
    }

    return (state: EditorState, tr: Transaction | null) => {
      if (!tr || tr.reconfigured) {
        state.values[idx] = getter(state)
        return SlotStatus.Changed
      } else {
        let newVal
        let depChanged = (depDoc && tr!.docChanged) || (depSel && (tr!.docChanged || tr!.selectionSet)) || 
          depAddrs.some(addr => (ensureAddr(state, addr) & SlotStatus.Changed) > 0)
        if (!depChanged || compare(newVal = getter(state), tr!.startState.values[idx])) return 0
        state.values[idx] = newVal
        return SlotStatus.Changed
      }
    }
  }

  [isExtension]!: true
}

function dynamicFacetSlot<Input, Output>(
  addresses: {[id: number]: number},
  facet: FacetData<Input, Output>,
  providers: readonly FacetProvider<Input>[]
) {
  let providerAddrs = providers.map(p => addresses[p.id])
  let providerTypes = providers.map(p => p.type)
  let dynamic = providerAddrs.filter(p => !(p & 1))
  let idx = addresses[facet.id] >> 1

  return (state: EditorState, tr: Transaction | null) => {
    let oldAddr = !tr ? null : tr.reconfigured ? tr.startState.config.address[facet.id] : idx << 1
    let changed = oldAddr == null
    for (let dynAddr of dynamic) {
      if (ensureAddr(state, dynAddr) & SlotStatus.Changed) changed = true
    }
    if (!changed) return 0
    let values: Input[] = []
    for (let i = 0; i < providerAddrs.length; i++) {
      let value = getAddr(state, providerAddrs[i])
      if (providerTypes[i] == Provider.Multi) for (let val of value) values.push(val)
      else values.push(value)
    }
    let newVal = facet.combine(values)
    if (oldAddr != null && facet.compare(newVal, getAddr(tr!.startState, oldAddr))) return 0
    state.values[idx] = newVal
    return SlotStatus.Changed
  }
}

/// Parameters passed when creating a
/// [`StateField`](#state.StateField^define). The `Value` type
/// parameter refers to the content of the field. Since it will be
/// stored in (immutable) state objects, it should be an immutable
/// value itself.
export type StateFieldSpec<Value> = {
  /// Creates the initial value for the field when a state is created.
  create: (state: EditorState) => Value,

  /// Compute a new value from the field's previous value and a
  /// [transaction](#state.Transaction).
  update: (value: Value, transaction: Transaction, newState: EditorState) => Value,

  /// Compare two values of the field, returning `true` when they are
  /// the same. This is used to avoid recomputing facets that depend
  /// on the field when its value did not change.
  compare?: (a: Value, b: Value) => boolean,
}

/// Fields can store additional information in an editor state, and
/// keep it in sync with the rest of the state.
export class StateField<Value> {
  private constructor(
    /// @internal
    readonly id: number,
    private createF: (state: EditorState) => Value,
    private updateF: (value: Value, tr: Transaction, state: EditorState) => Value,
    private compareF: (a: Value, b: Value) => boolean,
    /// @internal
    readonly facets: readonly Extension[]
  ) {}

  /// Define a state field.
  static define<Value>(config: StateFieldSpec<Value>): StateField<Value> {
    return new StateField<Value>(nextID++, config.create, config.update, config.compare || ((a, b) => a === b), [])
  }

  /// Extends the field to also provide a facet value. Returns a new
  /// `StateField` instance that, when used to extend a state,
  /// provides an input to the given facet that's derived from the
  /// field. When no `get` value is given, the entire value of the
  /// field is used as facet input.
  provide(facet: Facet<Value, any>): StateField<Value>
  provide<T>(facet: Facet<T, any>, get: (value: Value) => T, prec?: Precedence): StateField<Value>
  provide<T>(facet: Facet<T, any>, get?: (value: Value) => T, prec?: Precedence) {
    let provider = computedFacet(facet, [this], get ? state => get(state.field(this)) : state => state.field(this) as any)
    return new StateField(this.id, this.createF, this.updateF, this.compareF, this.facets.concat(maybePrec(prec, provider)))
  }

  /// Extends the field to provide zero or more input values for the
  /// given facet.
  provideN<T>(facet: Facet<T, any>, get: (value: Value) => readonly T[], prec?: Precedence): StateField<Value> {
    let provider = computedFacetN(facet, [this], state => get(state.field(this)))
    return new StateField(this.id, this.createF, this.updateF, this.compareF, this.facets.concat(maybePrec(prec, provider)))
  }

  /// @internal
  slot(addresses: {[id: number]: number}) {
    let idx = addresses[this.id] >> 1
    return (state: EditorState, tr: Transaction | null) => {
      let oldIdx = !tr ? null : tr.reconfigured ? tr.startState.config.address[this.id] >> 1 : idx
      if (oldIdx == null) {
        state.values[idx] = this.createF(state)
        return SlotStatus.Changed
      } else {
        let oldVal = tr!.startState.values[oldIdx], value = this.updateF(oldVal, tr!, state)
        if (this.compareF(oldVal, value)) return 0
        state.values[idx] = value
        return SlotStatus.Changed
      }
    }
  }

  [isExtension]!: true
}

/// An extension can be a [state field](#state.StateField), a facet
/// provider, or an array of other extensions.
export type Extension = {[isExtension]: true} | readonly Extension[]

/// By default extensions are registered in the order they are
/// provided in a flattening of the nested arrays that were provided.
/// Individual extension values can be assigned a precedence to
/// override this. Extensions that do not have a precedence set get
/// the precedence of the nearest parent with a precedence, or
/// [`Default`](#state.Precedence.Default) if there is no such parent.
/// The final ordering of extensions is determined by first sorting by
/// precedence and then by order within each precedence.
export class Precedence {
  private constructor(
    /// @internal
    readonly val: number
  ) {}

  /// A precedence below the default precedence, which will cause
  /// default-precedence extensions to override it even if they are
  /// specified later in the extension ordering.
  static Fallback = new Precedence(3)
  /// Normal, default precedence.
  static Default = new Precedence(2)
  /// A precedence above the default precedence.
  static Extend = new Precedence(1)
  /// Precedence above the `Default` and `Extend` precedences.
  static Override = new Precedence(0)

  /// Tag an extension with this precedence.
  set(extension: Extension) {
    return new PrecExtension(extension, this.val)
  }
}

function maybePrec(prec: Precedence | undefined, ext: Extension) {
  return prec == null ? ext : prec.set(ext)
}

class PrecExtension {
  constructor(readonly e: Extension, readonly prec: number) {}
  [isExtension]!: true
}

type DynamicSlot = (state: EditorState, tr: Transaction | null) => number

export class Configuration {
  readonly statusTemplate: SlotStatus[] = []

  constructor(readonly dynamicSlots: DynamicSlot[],
              readonly address: {[id: number]: number},
              readonly staticValues: readonly any[]) {
    while (this.statusTemplate.length < staticValues.length)
      this.statusTemplate.push(SlotStatus.Uninitialized)
  }

  staticFacet<Output>(facet: Facet<any, Output>) {
    let data = FacetData.get(facet), addr = this.address[data.id]
    return addr == null ? data.default : this.staticValues[addr >> 1]
  }

  // Passing EditorState as argument to avoid cyclic dependency
  static resolve(extension: Extension, oldState?: EditorState) {
    let fields: StateField<any>[] = []
    let facets: {[id: number]: FacetProvider<any>[]} = Object.create(null)
    for (let ext of flatten(extension)) {
      if (ext instanceof StateField) fields.push(ext)
      else (facets[ext.facet.id] || (facets[ext.facet.id] = [])).push(ext)
    }

    let address: {[id: number]: number} = Object.create(null)
    let staticValues: any[] = []
    let dynamicSlots: ((address: {[id: number]: number}) => DynamicSlot)[] = []
    for (let field of fields) {
      address[field.id] = dynamicSlots.length << 1
      dynamicSlots.push(a => field.slot(a))
    }
    for (let id in facets) {
      let providers = facets[id], facet = providers[0].facet
      if (providers.every(p => p.type == Provider.Static)) {
        address[facet.id] = (staticValues.length << 1) | 1
        let value = facet.combine(providers.map(p => p.value))
        let oldAddr = oldState ? oldState.config.address[facet.id] : null
        if (oldAddr != null) {
          let oldVal = getAddr(oldState!, oldAddr)
          if (facet.compare(value, oldVal)) value = oldVal
        }
        staticValues.push(value)
      } else {
        for (let p of providers) {
          if (p.type == Provider.Static) {
            address[p.id] = (staticValues.length << 1) | 1
            staticValues.push(p.value)
          } else {
            address[p.id] = dynamicSlots.length << 1
            dynamicSlots.push(a => p.dynamicSlot(a))
          }
        }
        address[facet.id] = dynamicSlots.length << 1
        dynamicSlots.push(a => dynamicFacetSlot(a, facet, providers))
      }
    }

    return new Configuration(dynamicSlots.map(f => f(address)), address, staticValues)
  }
}

function flatten(extension: Extension) {
  let result: (FacetProvider<any> | StateField<any>)[][] = [[], [], [], []]
  let seen = new Set<Extension>()
  ;(function inner(ext, prec: number) {
    if (seen.has(ext)) return
    seen.add(ext)
    if (Array.isArray(ext)) {
      for (let e of ext) inner(e, prec)
    } else if (ext instanceof PrecExtension) {
      inner(ext.e, ext.prec)
    } else {
      result[prec].push(ext as any)
      if (ext instanceof StateField) inner(ext.facets, prec)
    }
  })(extension, Precedence.Default.val)
  return result.reduce((a, b) => a.concat(b))
}

export const enum SlotStatus {
  Uninitialized = 0,
  Changed = 1,
  Computed = 2,
  Computing = 4
}

export function ensureAddr(state: EditorState, addr: number) {
  if (addr & 1) return SlotStatus.Computed
  let idx = addr >> 1
  let status = state.status[idx]
  if (status == SlotStatus.Computing) throw new Error("Cyclic dependency between fields and/or facets")
  if (status & SlotStatus.Computed) return status
  state.status[idx] = SlotStatus.Computing
  let changed = state.config.dynamicSlots[idx](state, state.applying)
  return state.status[idx] = SlotStatus.Computed | changed
}

export function getAddr(state: EditorState, addr: number) {
  return addr & 1 ? state.config.staticValues[addr >> 1] : state.values[addr >> 1]
}
