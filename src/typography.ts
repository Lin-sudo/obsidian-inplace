const typographyStyle = "unified-typography-dynamic-styles";
const paragraphVariable = "--inplace-typography-paragraph";
const lineHeightVariable = "--inplace-typography-line-height";

// Unified Typography publishes its values through a stylesheet, but themes
// can override the same variables on <body>. Read just its editor settings.
export function followUnifiedTypography(document: Document): () => void {
  const target = document.documentElement.style;
  let previousStyle: HTMLElement | null | undefined;
  let previousCss: string | null | undefined;

  function refresh() {
    const style = document.getElementById(typographyStyle) as HTMLStyleElement | null;
    const css = style?.textContent;
    if (style === previousStyle && css === previousCss) return;
    previousStyle = style;
    previousCss = css;
    const rules = Array.from(style?.sheet?.cssRules ?? []).filter(
      (rule): rule is CSSStyleRule => "selectorText" in rule && "style" in rule,
    );
    const editing = rules.some(rule => rule.selectorText.includes(".markdown-source-view.mod-cm6") &&
      rule.style.getPropertyValue("line-height"));
    const vars = editing ? rules.find(rule => rule.selectorText === "body")?.style : undefined;
    const spacing = vars?.getPropertyValue("--p-spacing").trim();
    const height = vars?.getPropertyValue("--line-height-normal").trim();
    if (spacing) target.setProperty(paragraphVariable, spacing);
    else target.removeProperty(paragraphVariable);
    if (height && Number(height) > 0) target.setProperty(lineHeightVariable, height);
    else target.removeProperty(lineHeightVariable);
  }

  refresh();
  const observer = new MutationObserver(refresh);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    target.removeProperty(paragraphVariable);
    target.removeProperty(lineHeightVariable);
  };
}
