const warned = new Set<string>()

export function warnOnce(msg: string) {
    if (warned.has(msg))
        return
    console.warn('[nulCss]', msg)
    warned.add(msg)
}