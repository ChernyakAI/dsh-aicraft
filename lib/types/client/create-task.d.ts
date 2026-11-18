import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { CreateTaskRequest, ProjectView } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/**
 * Collect requirements and a process before creating a task.
 * @param props - Project templates, translations and creation operation.
 * @returns The task creation form.
 */
export declare function CreateTaskForm({ project, busy, t, submit, initial }: {
    initial?: CreateTaskRequest;
    project: ProjectView;
    busy: boolean;
    t: PropsLocale<'aicraft'>['t'];
    submit(request: CreateTaskRequest): Promise<void>;
}): ReactNode;
