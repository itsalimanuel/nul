import type MagicString from 'magic-string'

export const regexClassGroup = /([!\w+:_/-]+?)([:-])\(((?:[~!\w\s:/\\,%#.$-]|\[.*?\])*?)\)/gm

export function expandVariantGroup(string: string): string
export function expandVariantGroup(string: MagicString): MagicString
export function expandVariantGroup(string: string | MagicString) {
    regexClassGroup.lastIndex = 0
    let hasChanged = false
    do {
        const before = string.toString()
        string = string.replace(
            regexClassGroup,
            (_, pre, sep, body: string) => {
                return body
                    .split(/\s/g)
                    .map(i => i === '~' ? pre : i.replace(/^(!?)(.*)/, `$1${pre}${sep}$2`))
                    .join(' ')
            },
        )
        hasChanged = string.toString() !== before
    } while (hasChanged)

    return string
}