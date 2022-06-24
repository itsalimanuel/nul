export function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}


export function escapeSelector(str: string): string {
    const length = str.length
    let index = -1
    let codeUnit
    let result = ''
    const firstCodeUnit = str.charCodeAt(0)
    while (++index < length) {
        codeUnit = str.charCodeAt(index)


        if (codeUnit === 0x0000) {
            result += '\uFFFD'
            continue
        }

        // Comma
        if (codeUnit === 44) {
            result += '\\,'
            continue
        }

        if (

            (codeUnit >= 0x0001 && codeUnit <= 0x001F)
            || codeUnit === 0x007F

            || (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039)
            || (index === 1
                && codeUnit >= 0x0030
                && codeUnit <= 0x0039
                && firstCodeUnit === 0x002D)
        ) {
            // https://drafts.csswg.org/cssom/#escape-a-character-as-code-point
            result += `\\${codeUnit.toString(16)} `
            continue
        }

        if (

            index === 0
            && length === 1
            && codeUnit === 0x002D
        ) {
            result += `\\${str.charAt(index)}`
            continue
        }

        if (
            codeUnit >= 0x0080
            || codeUnit === 0x002D
            || codeUnit === 0x005F
            || (codeUnit >= 0x0030 && codeUnit <= 0x0039)
            || (codeUnit >= 0x0041 && codeUnit <= 0x005A)
            || (codeUnit >= 0x0061 && codeUnit <= 0x007A)
        ) {
            // the character itself
            result += str.charAt(index)
            continue
        }

        result += `\\${str.charAt(index)}`
    }
    return result
}

export const e = escapeSelector