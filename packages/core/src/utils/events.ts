type EventsMap = Record<string, any>

interface DefaultEvents extends EventsMap {
    [event: string]: (...args: any) => void
}

export interface Unsubscribe {
    (): void
}

export declare class Emitter<Events extends EventsMap = DefaultEvents> {

    events: Partial<{ [E in keyof Events]: Events[E][] }>


    on<K extends keyof Events>(this: this, event: K, cb: Events[K]): Unsubscribe

    emit<K extends keyof Events>(
        this: this,
        event: K,
        ...args: Parameters<Events[K]>
    ): void
}


export function createNanoEvents<Events extends EventsMap = DefaultEvents>(): Emitter<Events> {
    return {
        events: {},
        emit(event, ...args) {
            (this.events[event] || [] as any).forEach((i: any) => i(...args))
        },
        on(event, cb) {
            (this.events[event] = this.events[event] || [] as any).push(cb)
            return () =>
                (this.events[event] = (this.events[event] || [] as any).filter((i: any) => i !== cb))
        },
    }
}