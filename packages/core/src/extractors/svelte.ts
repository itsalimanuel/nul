import type { Extractor } from '../types'
import { splitCode } from './split'

export const extractorSvelte: Extractor = {
    name: 'svelte',
    order: 0,
    extract({ code, id }) {
        let result = splitCode(code)
        if (id && id.endsWith('.svelte')) {
            result = result.map((r) => {
                return r.startsWith('class:') ? r.slice(6) : r
            })
        }
        return new Set(result)
    },
}