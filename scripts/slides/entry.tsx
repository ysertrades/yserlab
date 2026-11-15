// The slides editor's own renderer, bundled for the bot (scripts/slides/build.mjs -> vendor/slides.mjs).
// The bot draws a diagram with the same code the editor draws a page with, so it has the same look.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageView } from "../../../charts/src/slides/render";
import { create, makeBars, makePage, PATTERNS, COLORS, DEFAULT_FOOTER, DEFAULT_BG, PAGE_W, PAGE_H, bodyStyle, titleStyle, uid, withBox } from "../../../charts/src/slides/model";
import type { Deck, Page } from "../../../charts/src/slides/model";

export function pageSvg(page: Page, deck: Pick<Deck, "brand" | "numbering" | "footer">, number = 1): string {
  return renderToStaticMarkup(createElement(PageView, { page, deck, number, total: 1 }));
}
export { create, makeBars, makePage, PATTERNS, COLORS, DEFAULT_FOOTER, DEFAULT_BG, PAGE_W, PAGE_H, bodyStyle, titleStyle, uid, withBox };
