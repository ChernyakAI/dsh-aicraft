/**
 * FILE: plugin/src/client/project-sync.ts
 * DESCRIPTION: Bound project rereads and publish only the latest live request
 */

/**
 * START_METHOD_projectReader
 * Own read cancellation independently of the project event stream.
 * @param load - Read the selected project.
 * @param lifetime - Selected context lifetime.
 * @param available - Whether DSH currently provides a ready connection.
 * @param publish - Apply a result of the latest live read.
 * @param failed - Report a read failure without ending observation.
 * @param settled - Finish the latest live cycle after success or its last failed attempt.
 * @returns A request function with its current in-flight state.
 */
export function projectReader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  lifetime: AbortSignal,
  available: () => boolean,
  publish: (value: T) => void,
  failed: (error: unknown) => void,
  settled: () => void = () => {},
): (() => void) & { pending(): boolean } {
  let current: AbortController | undefined
  let pending = false
  const read = () => {
    current?.abort()
    const request = new AbortController()
    current = request
    pending = true
    const signal = AbortSignal.any([lifetime, request.signal])
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
          try {
            const value = await load(signal)
            if (!signal.aborted) publish(value)
            return
          } catch (error) {
            if (signal.aborted) return
            failed(error)
            if (!available()) return
          }
        }
      } finally {
        if (current === request) {
          pending = false
          if (!signal.aborted) settled()
        }
      }
    })()
  }
  read.pending = () => pending
  return read
}
// END_METHOD_projectReader
