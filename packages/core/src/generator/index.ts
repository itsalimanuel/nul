import { createNanoEvents } from '../utils/events'
import type { CSSEntries, CSSObject, ExtractorContext, GenerateOptions, GenerateResult, ParsedUtil, PreflightContext, PreparedRule, RawUtil, ResolvedConfig, Rule, RuleContext, RuleMeta, Shortcut, StringifiedUtil, UserConfig, UserConfigDefaults, UtilObject, Variant, VariantContext, VariantHandler, VariantHandlerContext, VariantMatchedResult } from '../types'
// @ts-ignore
import { resolveConfig } from '../config'
import { CONTROL_SHORTCUT_NO_MERGE, TwoKeyMap, e, entriesToCss, expandVariantGroup, isRawUtil, isStaticShortcut, noop, normalizeCSSEntries, normalizeCSSValues, notNull, uniq, warnOnce } from '../utils'
// @ts-ignore
import { version } from '../../package.json'

export class NulGenerator {
    public version = version
    private _cache = new Map<string, StringifiedUtil[] | null>()
    public config: ResolvedConfig
    public blocked = new Set<string>()
    public parentOrders = new Map<string, number>()
    public events = createNanoEvents<{
        config: (config: ResolvedConfig) => void
    }>()

    constructor(
        public userConfig: UserConfig = {},
        public defaults: UserConfigDefaults = {},
    ) {
        this.config = resolveConfig(userConfig, defaults)
        this.events.emit('config', this.config)
    }

    setConfig(userConfig?: UserConfig, defaults?: UserConfigDefaults) {
        if (!userConfig)
            return
        if (defaults)
            this.defaults = defaults
        this.userConfig = userConfig
        this.blocked.clear()
        this.parentOrders.clear()
        this._cache.clear()
        this.config = resolveConfig(userConfig, this.defaults)
        this.events.emit('config', this.config)
    }

    async applyExtractors(code: string, id?: string, set = new Set<string>()) {
        const context: ExtractorContext = {
            get original() { return code },
            code,
            id,
        }

        for (const extractor of this.config.extractors) {
            const result = await extractor.extract(context)
            result?.forEach(t => set.add(t))
        }

        return set
    }

    makeContext(raw: string, applied: VariantMatchedResult) {

        const context: RuleContext = {
            rawSelector: raw,
            currentSelector: applied[1],
            theme: this.config.theme,
            generator: this,
            variantHandlers: applied[2],
            // @ts-ignore
            constructCSS: (...args) => this.constructCustomCSS(context, ...args),
            variantMatch: applied,
        }
        return context
    }

    async parseToken(raw: string, alias?: string) {
        if (this.blocked.has(raw))
            return

        const cacheKey = `${raw}${alias ? ` ${alias}` : ''}`

        // use caches if possible
        if (this._cache.has(cacheKey))
            return this._cache.get(cacheKey)

        let current = raw
        for (const p of this.config.preprocess)
            current = p(raw)!

        if (this.isBlocked(current)) {
            this.blocked.add(raw)
            this._cache.set(cacheKey, null)
            return
        }

        const applied = this.matchVariants(raw, current)

        if (!applied || this.isBlocked(applied[1])) {
            this.blocked.add(raw)
            this._cache.set(cacheKey, null)
            return
        }

        const context = this.makeContext(
            raw,
            [alias || applied[0], applied[1], applied[2], applied[3]],
        )

        if (this.config.details)
            { // @ts-ignore
                context.variants = [...applied[3]]
            }

        // expand shortcuts
        const expanded = this.expandShortcut(context.currentSelector, context)
        if (expanded) {
            const utils = await this.stringifyShortcuts(context.variantMatch, context, expanded[0], expanded[1])
            if (utils?.length) {
                this._cache.set(cacheKey, utils)
                return utils
            }
        }
        // no shortcut
        else {
            const utils = (await this.parseUtil(context.variantMatch, context))?.map(i => this.stringifyUtil(i, context)).filter(notNull)
            if (utils?.length) {
                // @ts-ignore
                this._cache.set(cacheKey, utils)
                return utils
            }
        }

        // set null cache for unmatched result
        this._cache.set(cacheKey, null)
    }

    async generate(
        input: string | Set<string> = '',
        {
            id,
            scope,
            preflights = true,
            safelist = true,
            minify = false,
        }: GenerateOptions = {},
    ): Promise<GenerateResult> {
        const tokens = typeof input === 'string'
            ? await this.applyExtractors(input, id)
            : input

        if (safelist)
            this.config.safelist.forEach(s => tokens.add(s))

        const nl = minify ? '' : '\n'

        const layerSet = new Set<string>(['default'])
        const matched = new Set<string>()
        const sheet = new Map<string, StringifiedUtil[]>()
        let preflightsMap: Record<string, string> = {}

        const tokenPromises = Array.from(tokens).map(async (raw) => {
            if (matched.has(raw))
                return

            const payload = await this.parseToken(raw)
            if (payload == null)
                return

            matched.add(raw)

            for (const item of payload) {
                const parent = item[3] || ''
                // @ts-ignore
                const layer = item[4]?.layer
                if (!sheet.has(parent))
                    sheet.set(parent, [])
                // @ts-ignore
                sheet.get(parent)!.push(item)
                if (layer)
                    layerSet.add(layer)
            }
        })

        const preflightPromise = (async () => {
            if (!preflights)
                return

            const preflightContext: PreflightContext = {
                generator: this,
                theme: this.config.theme,
            }

            const preflightLayerSet = new Set<string>(['default'])
            this.config.preflights.forEach(({ layer }) => {
                if (layer) {
                    layerSet.add(layer)
                    preflightLayerSet.add(layer)
                }
            })

            preflightsMap = Object.fromEntries(
                await Promise.all(Array.from(preflightLayerSet).map(
                    async (layer) => {
                        const preflights = await Promise.all(
                            this.config.preflights
                                .filter(i => (i.layer || 'default') === layer)
                                .map(async i => await i.getCSS(preflightContext)),
                        )
                        const css = preflights
                            .filter(Boolean)
                            .join(nl)
                        return [layer, css]
                    },
                )),
            )
        })()

        await Promise.all([
            ...tokenPromises,
            preflightPromise,
        ])

        const layers = this.config.sortLayers(Array
            .from(layerSet)
            .sort((a, b) => ((this.config.layers[a] ?? 0) - (this.config.layers[b] ?? 0)) || a.localeCompare(b)),
        )

        const layerCache: Record<string, string> = {}
        const getLayer = (layer: string) => {
            if (layerCache[layer])
                return layerCache[layer]

            let css = Array.from(sheet)
                .sort((a, b) => ((this.parentOrders.get(a[0]) ?? 0) - (this.parentOrders.get(b[0]) ?? 0)) || a[0]?.localeCompare(b[0] || '') || 0)
                .map(([parent, items]) => {
                    const size = items.length
                    const sorted: PreparedRule[] = items
                        .filter(i => (i[4]?.layer || 'default') === layer)
                        .sort((a, b) => a[0] - b[0] || (a[4]?.sort || 0) - (b[4]?.sort || 0) || a[1]?.localeCompare(b[1] || '') || a[2]?.localeCompare(b[2] || '') || 0)
                        .map(([, selector, body,, meta]) => {
                            const scopedSelector = selector ? applyScope(selector, scope) : selector
                            return [
                                [[scopedSelector ?? '', meta?.sort ?? 0]],
                                body,
                                !!meta?.noMerge,
                            ]
                        })
                    if (!sorted.length)
                        return undefined
                    const rules = sorted
                        .reverse()
                        .map(([selectorSortPair, body, noMerge], idx) => {
                            if (!noMerge && this.config.mergeSelectors) {
                                // search for rules that has exact same body, and merge them
                                for (let i = idx + 1; i < size; i++) {
                                    const current = sorted[i]
                                    if (current && !current[2] && ((selectorSortPair && current[0]) || (selectorSortPair == null && current[0] == null)) && current[1] === body) {
                                        if (selectorSortPair && current[0])
                                            current[0].push(...selectorSortPair)
                                        return null
                                    }
                                }
                            }


                            const selectors = selectorSortPair
                                // @ts-ignore
                                ? [...new Set(selectorSortPair
                                    .sort((a, b) => a[1] - b[1] || a[0]?.localeCompare(b[0] || '') || 0)
                                    .map(pair => pair[0])
                                    .filter(Boolean),
                                )]
                                : []

                            return selectors.length
                                ? `${selectors.join(`,${nl}`)}{${body}}`
                                : body
                        })
                        .filter(Boolean)
                        .reverse()
                        .join(nl)

                    return parent
                        ? `${parent}{${nl}${rules}${nl}}`
                        : rules
                })
                .filter(Boolean)
                .join(nl)

            if (preflights) {
                css = [preflightsMap[layer], css]
                    .filter(Boolean)
                    .join(nl)
            }

            return layerCache[layer] = !minify && css
                ? `/* layer: ${layer} */${nl}${css}`
                : css
        }

        const getLayers = (includes = layers, excludes?: string[]) => {
            return includes
                .filter(i => !excludes?.includes(i))
                .map(i => getLayer(i) || '')
                .filter(Boolean)
                .join(nl)
        }

        return {
            get css() { return getLayers() },
            layers,
            getLayers,
            getLayer,
            matched,
        }
    }

    matchVariants(raw: string, current?: string): VariantMatchedResult {
        // process variants
        const variants = new Set<Variant>()
        const handlers: VariantHandler[] = []
        let processed = current || raw
        let applied = false

        const context: VariantContext = {
            rawSelector: raw,
            theme: this.config.theme,
            generator: this,
        }

        while (true) {
            applied = false
            for (const v of this.config.variants) {
                if (!v.multiPass && variants.has(v))
                    continue
                let handler = v.match(processed, context)
                if (!handler)
                    continue
                if (typeof handler === 'string')
                    handler = { matcher: handler }
                processed = handler.matcher
                handlers.unshift(handler)
                variants.add(v)
                applied = true
                break
            }
            if (!applied)
                break

            if (handlers.length > 500)
                throw new Error(`Too many variants applied to "${raw}"`)
        }

        return [raw, processed, handlers, variants]
    }

    applyVariants(parsed: ParsedUtil, variantHandlers = parsed[4], raw = parsed[1]): UtilObject {
        const handler = [...variantHandlers]
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .reverse()
            .reduce(
                (previous, v) =>
                    (input: VariantHandlerContext) => {
                        const entries = v.body?.(input.entries) || input.entries
                        const parents: [string | undefined, number | undefined] = Array.isArray(v.parent) ? v.parent : [v.parent, undefined]
                        return (v.handle ?? defaultVariantHandler)({
                            entries,
                            selector: v.selector?.(input.selector, entries) || input.selector,
                            parent: parents[0] || input.parent,
                            parentOrder: parents[1] || input.parentOrder,
                            layer: v.layer || input.layer,
                            sort: v.sort || input.sort,
                        }, previous)
                    },
                (input: VariantHandlerContext) => input,
            )

        const variantContextResult = handler({
            entries: parsed[2],
            selector: toEscapedSelector(raw),
        })

        const { parent, parentOrder, selector } = variantContextResult
        if (parent != null && parentOrder != null)
            this.parentOrders.set(parent, parentOrder)

        const obj: UtilObject = {
            selector: movePseudoElementsEnd(selector),
            entries: variantContextResult.entries,
            parent,
            layer: variantContextResult.layer,
            sort: variantContextResult.sort,
        }

        for (const p of this.config.postprocess)
            p(obj)
        return obj
    }

    constructCustomCSS(context: Readonly<RuleContext>, body: CSSObject | CSSEntries, overrideSelector?: string) {
        const normalizedBody = normalizeCSSEntries(body)
        if (typeof normalizedBody === 'string')
            return normalizedBody

        const { selector, entries, parent } = this.applyVariants([0, overrideSelector || context.rawSelector, normalizedBody, undefined, context.variantHandlers])
        const cssBody = `${selector}{${entriesToCss(entries)}}`
        if (parent)
            return `${parent}{${cssBody}}`
        return cssBody
    }

    async parseUtil(input: string | VariantMatchedResult, context: RuleContext, internal = false): Promise<(ParsedUtil | RawUtil)[] | undefined> {
        const [raw, processed, variantHandlers] = typeof input === 'string'
            ? this.matchVariants(input)
            : input

        const recordRule = this.config.details
            ? (r: Rule) => {
                context.rules = context.rules ?? []
                context.rules.push(r)
            }
            : noop

        // use map to for static rules
        const staticMatch = this.config.rulesStaticMap[processed]
        if (staticMatch) {
            if (staticMatch[1] && (internal || !staticMatch[2]?.internal)) {
                recordRule(staticMatch[3])
                const index = staticMatch[0]
                const entry = normalizeCSSEntries(staticMatch[1])
                const meta = staticMatch[2]
                if (typeof entry === 'string')
                    return [[index, entry, meta]]
                else
                    return [[index, raw, entry, meta, variantHandlers]]
            }
        }

        context.variantHandlers = variantHandlers

        const { rulesDynamic, rulesSize } = this.config

        // match rules, from last to first
        for (let i = rulesSize - 1; i >= 0; i--) {
            const rule = rulesDynamic[i]

            // static rules are omitted as undefined
            if (!rule)
                continue

            // ignore internal rules
            if (rule[2]?.internal && !internal)
                continue

            // dynamic rules
            const [matcher, handler, meta] = rule
            const match = processed.match(matcher)
            if (!match)
                continue

            const result = await handler(match, context)
            if (!result)
                continue

            recordRule(rule)

            const entries = normalizeCSSValues(result).filter(i => i.length)
            if (entries.length) {
                return entries.map((e) => {
                    if (typeof e === 'string')
                        return [i, e, meta]
                    else
                        return [i, raw, e, meta, variantHandlers]
                })
            }
        }
    }

    stringifyUtil(parsed?: ParsedUtil | RawUtil, context?: RuleContext): [number, string, string, string, { internal?: boolean; noMerge?: boolean; // @ts-ignore
        autocomplete?: Arrayable<AutoCompleteTemplate>; sort: number; layer: string }, RuleContext<{}>] {
        if (!parsed)
            return
        if (isRawUtil(parsed))
            { // @ts-ignore
                return [parsed[0], undefined, parsed[1], undefined, parsed[2], this.config.details ? context : undefined]
            }

        // @ts-ignore
        const { selector, entries, parent, layer: variantLayer, sort: variantSort } = this.applyVariants(parsed)
        const body = entriesToCss(entries)

        if (!body)
            return

        const { layer: metaLayer, sort: metaSort, ...meta } = parsed[3] ?? {}
        const ruleMeta = {
            ...meta,
            layer: variantLayer ?? metaLayer,
            sort: variantSort ?? metaSort,
        }
        return [parsed[0], selector, body, parent, ruleMeta, this.config.details ? context : undefined]
    }

    expandShortcut(processed: string, context: RuleContext, depth = 3): [string[], RuleMeta | undefined] | undefined {
        if (depth === 0)
            return

        const recordShortcut = this.config.details
            ? (s: Shortcut) => {
                context.shortcuts = context.shortcuts ?? []
                context.shortcuts.push(s)
            }
            : noop

        let meta: RuleMeta | undefined
        let result: string | string[] | undefined
        for (const s of this.config.shortcuts) {
            if (isStaticShortcut(s)) {
                if (s[0] === processed) {
                    meta = meta || s[2]
                    // @ts-ignore
                    result = s[1]
                    recordShortcut(s)
                    break
                }
            }
            else {
                const match = processed.match(s[0])
                if (match)
                    { // @ts-ignore
                        result = s[1](match, context)
                    }
                if (result) {
                    meta = meta || s[2]
                    recordShortcut(s)
                    break
                }
            }
        }

        if (typeof result === 'string')
            result = expandVariantGroup(result).split(/\s+/g)

        if (!result)
            return


        return [
            result
                // @ts-ignore
                .flatMap(r => this.expandShortcut(r, context, depth - 1)?.[0] || [r])
                .filter(r => r !== ''),
            meta,
        ]
    }

    async stringifyShortcuts(
        parent: VariantMatchedResult,
        context: RuleContext,
        expanded: string[],
        meta: RuleMeta = { layer: this.config.shortcutsLayer },
    ): Promise<StringifiedUtil[] | undefined> {
        const selectorMap = new TwoKeyMap<string, string | undefined, [[CSSEntries, boolean, number][], number]>()
        const parsed = (
            await Promise.all(uniq(expanded)
                .map(async (i) => {
                    const result = await this.parseUtil(i, context, true)
                    if (!result)
                        warnOnce(`unmatched utility "${i}" in shortcut "${parent[1]}"`)
                    return (result || []) as ParsedUtil[]
                })))
            .flat(1)
            .filter(Boolean)
            .sort((a, b) => a[0] - b[0])

        const [raw, , parentVariants] = parent
        const rawStringfieldUtil: StringifiedUtil[] = []
        for (const item of parsed) {
            if (isRawUtil(item)) {
                rawStringfieldUtil.push([item[0], undefined, item[1], undefined, item[2], context])
                continue
            }
            const { selector, entries, parent, sort } = this.applyVariants(item, [...item[4], ...parentVariants], raw)

            // find existing selector/mediaQuery pair and merge
            const mapItem = selectorMap.getFallback(selector, parent, [[], item[0]])
            // add entries
            mapItem[0].push([entries, !!item[3]?.noMerge, sort ?? 0])
        }
        return rawStringfieldUtil.concat(selectorMap
            .map(([e, index], selector, joinedParents) => {
                const stringify = (flatten: boolean, noMerge: boolean, entrySortPair: [CSSEntries, number][]): (StringifiedUtil | undefined)[] => {
                    const maxSort = Math.max(...entrySortPair.map(e => e[1]))
                    const entriesList = entrySortPair.map(e => e[0])
                    return (flatten ? [entriesList.flat(1)] : entriesList).map((entries: CSSEntries): StringifiedUtil | undefined => {
                        const body = entriesToCss(entries)
                        if (body)
                            return [index, selector, body, joinedParents, { ...meta, noMerge, sort: maxSort }, context]
                        return undefined
                    })
                }

                const merges = [
                    [e.filter(([, noMerge]) => noMerge).map(([entries,, sort]) => [entries, sort]), true],
                    [e.filter(([, noMerge]) => !noMerge).map(([entries,, sort]) => [entries, sort]), false],
                ] as [[CSSEntries, number][], boolean][]

                return merges.map(([e, noMerge]) => [
                    ...stringify(false, noMerge, e.filter(([entries]) => entries.some(entry => entry[0] === CONTROL_SHORTCUT_NO_MERGE))),
                    ...stringify(true, noMerge, e.filter(([entries]) => entries.every(entry => entry[0] !== CONTROL_SHORTCUT_NO_MERGE))),
                ])
            })
            .flat(2)
            .filter(Boolean) as StringifiedUtil[])
    }

    isBlocked(raw: string) {
        return !raw || this.config.blocklist.some(e => typeof e === 'string' ? e === raw : e.test(raw))
    }
}

export function createGenerator(config?: UserConfig, defaults?: UserConfigDefaults) {
    return new NulGenerator(config, defaults)
}

export const regexScopePlaceholder = / \$\$ /
export const hasScopePlaceholder = (css: string) => css.match(regexScopePlaceholder)

function applyScope(css: string, scope?: string) {
    if (hasScopePlaceholder(css))
        return css.replace(regexScopePlaceholder, scope ? ` ${scope} ` : ' ')
    else
        return scope ? `${scope} ${css}` : css
}

export function movePseudoElementsEnd(selector: string) {
    const pseudoElements = selector.match(/::[\w-]+/g)
    if (pseudoElements) {
        pseudoElements.forEach(e => (selector = selector.replace(e, '')))
        selector += pseudoElements.join('')
    }
    return selector
}

const attributifyRe = /^\[(.+?)(~?=)"(.*)"\]$/
export function toEscapedSelector(raw: string) {
    if (attributifyRe.test(raw))
        return raw.replace(attributifyRe, (_, n, s, i) => `[${e(n)}${s}"${e(i)}"]`)
    return `.${e(raw)}`
}

function defaultVariantHandler(input: VariantHandlerContext, next: (input: VariantHandlerContext) => VariantHandlerContext) {
    return next(input)
}