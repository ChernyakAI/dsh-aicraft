/**
 * FILE: plugin/src/client/theme-text.ts
 * DESCRIPTION: Scope softer profile text colors to AICraft surfaces and preserve native defaults
 */
// Capture native colors on the surface before its children override the aliases.
// Separate DOM levels avoid self-referencing custom properties when OneC Dark is off.
export const aicraftTextStyles = `
.aicraft-text-surface {
  --aicraft-host-primary: var(--dsw-alias-label-primary);
  --aicraft-host-primary-bluish: var(--dsw-alias-label-primary-bluish);
  --aicraft-host-primary-dimmed: var(--dsw-alias-label-primary-dimmed);
  --aicraft-host-foreground: var(--dsw-alias-label-primary-foreground);
  --aicraft-host-secondary: var(--dsw-alias-label-secondary);
  --aicraft-host-tertiary: var(--dsw-alias-label-tertiary);
  --aicraft-host-caption: var(--dsw-alias-label-caption);
  color: var(--aicraft-text-primary, var(--dsw-alias-label-primary));
}
.aicraft-text-surface > * {
  --dsw-alias-label-primary: var(--aicraft-text-primary, var(--aicraft-host-primary));
  --dsw-alias-label-primary-bluish: var(--aicraft-text-primary, var(--aicraft-host-primary-bluish));
  --dsw-alias-label-primary-dimmed: var(--aicraft-text-secondary, var(--aicraft-host-primary-dimmed));
  --dsw-alias-label-primary-foreground: var(--aicraft-text-primary, var(--aicraft-host-foreground));
  --dsw-alias-label-secondary: var(--aicraft-text-secondary, var(--aicraft-host-secondary));
  --dsw-alias-label-tertiary: var(--aicraft-text-tertiary, var(--aicraft-host-tertiary));
  --dsw-alias-label-caption: var(--aicraft-text-tertiary, var(--aicraft-host-caption));
}
`
