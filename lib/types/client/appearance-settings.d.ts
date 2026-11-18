import type { AppearanceSettings } from '../dsh-integration/appearance-settings.tsx';
import type { LocaleSource } from '../dsh-integration/client-locale.tsx';
/**
 * Render read availability independently of the retained write outcome, without repeating actions.
 */
export declare function AppearanceStatus({ settings, locale }: {
    settings: AppearanceSettings;
    locale: LocaleSource;
}): import("react").JSX.Element;
/** Global settings remain usable with no project, task, or session. @backlink UC-212 UC-213 MIF-81 */
export declare function AppearancePage({ settings, locale }: {
    settings: AppearanceSettings;
    locale: LocaleSource;
}): import("react").JSX.Element;
