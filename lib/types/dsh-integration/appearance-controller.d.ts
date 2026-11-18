/**
 * FILE: plugin/src/dsh-integration/appearance-controller.tsx
 * DESCRIPTION: Own OneC Dark registration, native choice bridge and teardown outside panel lifetime
 */
import type { Context } from '@deepseek-ai/cordis';
/** Connect native profile settings to presentation without changing task or editor owners. @backlink MIF-81 MIF-82 */
export declare function mountAppearance(ctx: Context): () => void;
