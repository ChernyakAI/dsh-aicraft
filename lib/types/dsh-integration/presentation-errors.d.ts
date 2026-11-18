/**
 * Retain native codes and payloads; serialize metadata only for an explicitly described own error.
 */
export declare function presentationFailure(error: unknown): unknown;
/** Adapt unary and stream errors without changing inputs, values, cancellation or publication semantics.
 */
export declare function presentationErrors<This extends object, Args extends unknown[], Result>(method: (this: This, ...args: Args) => Result, _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>): (this: This, ...args: Args) => Result;
