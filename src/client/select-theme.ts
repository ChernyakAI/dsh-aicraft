/**
 * FILE: plugin/src/client/select-theme.ts
 * DESCRIPTION: Style native form pickers and editable-field focus while OneC Dark is active
 */
export const oneCSelectStyles = `
.aicraft-text-surface input:not([type="checkbox"]):not([type="radio"]):focus-visible,
.aicraft-text-surface textarea:focus-visible,
.aicraft-text-surface select:focus-visible {
  outline-style: solid;
}
select, select option, select optgroup {
  color-scheme: dark;
}
select {
  position: relative;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  background-color: var(--dsw-specific-selector) !important;
  border-color: var(--dsw-alias-border-l3) !important;
}
select option, select optgroup {
  background-color: var(--dsw-menu-surface-fill);
  color: var(--dsw-alias-label-primary);
}
@supports (appearance: base-select) {
  select, select::picker(select) {
    /* DSH model settings explicitly opt out of native appearance. Both the
       field and its picker must opt in for option colors to be painted. */
    appearance: base-select !important;
  }
  /* base-select replaces the native control font and intrinsic box metrics.
     Keep the native small-control font unless the form explicitly inherits one.
     Chromium's native select includes two internal vertical pixels beyond its text box. */
  select {
    /* The customizable picker supplies its own arrow, replacing DSH's SVG. */
    background-image: none !important;
    font: -webkit-small-control;
    /* The shipped DSH shell makes form controls inherit the text font family. */
    font-family: inherit;
    line-height: normal;
    display: inline-flex;
    align-items: center;
    column-gap: 0;
    min-block-size: 0;
    min-inline-size: 0;
    padding: 0;
    padding-inline-end: 20px !important;
    border-width: 1px;
    border-style: solid;
    border-radius: 0;
  }
  /* A zero-width strut keeps the native control's internal text clearance
     without adding to or replacing each form's own padding and border. */
  select::before {
    content: '';
    block-size: calc(1lh + 2px);
    inline-size: 0;
    flex: none;
  }
  select::picker(select) {
    background: var(--dsw-menu-surface-fill);
    color: var(--dsw-alias-label-primary);
    border: 1px solid var(--dsw-alias-border-l3);
    border-radius: var(--dsw-radius-lg);
    padding: 4px;
    box-shadow: var(--dsw-elevation-prominent);
  }
  select::picker-icon {
    position: absolute;
    inset-inline-end: 4px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--dsw-alias-label-secondary);
    background: var(--dsw-specific-selector);
    border-inline-start: 6px solid var(--dsw-specific-selector);
    pointer-events: none;
  }
  select option {
    padding: 4px 8px;
    border-radius: var(--dsw-radius-md);
    font: inherit;
  }
  select option:hover:not(:disabled), select option:focus-visible:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  select option:checked {
    background: var(--dsw-alias-bg-multi-select);
    color: var(--dsw-alias-label-primary);
  }
  select option:focus-visible {
    outline: 1px solid var(--dsw-alias-border-l4);
    outline-offset: -1px;
  }
  select option:disabled {
    color: var(--dsw-alias-label-dimmed);
  }
  select option::checkmark {
    color: var(--dsw-alias-link);
  }
}
`
