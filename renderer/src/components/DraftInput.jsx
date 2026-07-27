// src/components/DraftInput.jsx
import React from "react";

/**
 * An input/textarea that buffers keystrokes in local state and only calls
 * `onCommit` on blur (or Enter, when `commitOnEnter`). This keeps typing from
 * writing to global app state on every keystroke — which, in a large tree,
 * re-runs every memo and reconciles every sibling on each character.
 *
 * The local draft re-syncs to `value` whenever the incoming value changes and
 * the field is NOT focused, so external updates (sync pushes, markup buttons)
 * still flow in without clobbering what the user is actively typing.
 *
 * Pass `as="textarea"` to render a textarea; all other props spread through.
 */
export default function DraftInput({
  as: Component = "input",
  value,
  onCommit,
  onFocus,
  onBlur,
  commitOnEnter = false,
  ...rest
}) {
  const [draft, setDraft] = React.useState(value ?? "");
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    if (!focusedRef.current) setDraft(value ?? "");
  }, [value]);

  const commit = () => {
    if (String(draft) !== String(value ?? "")) onCommit?.(draft);
  };

  return (
    <Component
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        commit();
        onBlur?.(e);
      }}
      onKeyDown={
        commitOnEnter
          ? (e) => {
              if (e.key === "Enter" && Component === "input") {
                commit();
                e.currentTarget.blur();
              }
            }
          : rest.onKeyDown
      }
    />
  );
}
