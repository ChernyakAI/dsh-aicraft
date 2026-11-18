import type { Translator } from './messages.ts';
import type { RoleDocument } from '../types.ts';
interface Props {
    t: Translator;
    workspaceId: string;
    roles: RoleDocument[];
    save(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>;
    remove(workspaceId: string, id: string, version: string): Promise<void>;
    reload(): Promise<RoleDocument[]>;
    updated(roles: RoleDocument[]): void;
    status(active: boolean): void;
}
/** Shared role instructions and confirmed deletion, without changing process drafts.
 */
export declare function RolesSettings({ t, workspaceId, roles, save, remove, reload, updated, status }: Props): import("react").JSX.Element;
export {};
