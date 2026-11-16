import { Plugin, editorLivePreviewField } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection, EditorState, MapMode, Prec, StateField,
  type Range, type Text, type Transaction,
} from "@codemirror/state";
import { Decoration, Direction, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { gapRows, type GapRow } from "./gaps";
import { followUnifiedTypography } from "./typography";

interface Draft {
  position: number;
  breaks: 1 | 2;
}

interface Layout {
  readonly draft: Draft | null;
  readonly headings: ReadonlySet<number>;
  readonly topLevelList: ReadonlySet<number>;
  readonly separators: ReadonlySet<number>;
  readonly gapStarts: readonly number[];
  readonly structuredRows: ReadonlySet<number>;
  readonly decorations: DecorationSet;
}

const inactive: Layout = { draft: null, headings: new Set(), topLevelList: new Set(), separators: new Set(), gapStarts: [], structuredRows: new Set(), decorations: Decoration.none };
const protectedLine = /(?:^|_)(?:HyperMD-(?:codeblock|frontmatter|table|quote)(?:_|$)|math(?:_|$)|math-block(?:_|$)|comment(?:_|$)|hmd-frontmatter(?:_|$))/i;
const headingLine = /(?:^|_)HyperMD-header(?:_|$)/;
const structuredToken = /(?:^|_)(?:HyperMD-(?:hr|html[^_]*|link-ref[^_]*)(?:_|$)|math-block(?:_|$)|link-reference(?:_|$))/i;
const listLine = /(?:^|_)HyperMD-list-line(?:_|$)/;
const blankLine = /^[ \t]*$/;
const atxHeading = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const emptyListItem = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/;
const topLevelListLine = /(?:^|_)HyperMD-list-line-1(?:_|$)/;

function livePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField, false) === true;
}

function draftAfter(transaction: Transaction, old: Layout): Draft | null {
  const selection = transaction.newSelection;
  // Keep the layout still while a mouse drag extends from a new empty paragraph.
  if (!transaction.docChanged && old.draft !== null && transaction.isUserEvent("select.pointer") &&
      !selection.main.empty) return old.draft;
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const line = transaction.newDoc.lineAt(selection.main.head);
  if (line.length !== 0) return null;

  // A deletion that lands on an existing blank line must not turn it into
  // a new editing row. Tracking the preceding break also lets Backspace
  // remove an actual draft without promoting the previous separator.
  if (old.draft !== null && transaction.changes.mapPos(old.draft.position, -1, MapMode.TrackBefore) === line.from) {
    return old.draft.position === line.from ? old.draft : { ...old.draft, position: line.from };
  }
  if (!transaction.docChanged || !transaction.isUserEvent("input") ||
      transaction.isUserEvent("input.paste")) return null;

  let breaks: 0 | 1 | 2 = 0;
  transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (inserted.lines < 2 || line.from <= fromB || line.from > toB) return;
    const completePair = line.from >= fromB + 2 &&
      transaction.newDoc.sliceString(line.from - 2, line.from) === "\n\n";
    breaks = completePair ? 2 : 1;
  });
  if (breaks) return { position: line.from, breaks };
  // A native empty-list exit can remove just the marker, leaving the
  // already existing line ready for typing.
  const previous = transaction.startState.doc.lineAt(transaction.startState.selection.main.head);
  return emptyListItem.test(previous.text) ? { position: line.from, breaks: 1 } : null;
}

function lineDecoration(row: GapRow, heading: boolean, from: number): Range<Decoration> {
  return Decoration.line({ attributes: {
    class: `inplace-native-gap${heading ? " inplace-native-heading-gap" : ""}`,
    "data-inplace-gap": row,
  } }).range(from);
}

function buildLayout(state: EditorState, draft: Draft | null): Layout {
  const { doc } = state;
  const tree = syntaxTree(state);
  const lastParsedLine = doc.lineAt(Math.min(tree.length, doc.length)).number;
  const protectedRows = new Set<number>();
  const headingRows = new Set<number>();
  const topLevelList = new Set<number>();
  const structuredRows = new Set<number>();

  // Obsidian's Markdown grammar labels physical lines and block tokens.
  // Protect those rows even when the source line itself is empty.
  tree.iterate({
    enter({ name, from, to }) {
      const isProtected = protectedLine.test(name);
      const heading = headingLine.test(name);
      const list = listLine.test(name);
      const structured = isProtected || heading || list || structuredToken.test(name);
      if (!structured) return;
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(Math.max(from, to - 1)).number;
      for (let number = first; number <= last; number++) {
        structuredRows.add(number);
        const text = doc.line(number).text;
        if (isProtected || (list && text.length > 0 && blankLine.test(text))) protectedRows.add(number);
        if (heading) headingRows.add(number);
        if (list && topLevelListLine.test(name)) topLevelList.add(number);
      }
    },
  });

  const separators = new Set<number>();
  const gapStarts: number[] = [];
  const decorations: Range<Decoration>[] = [];
  const draftPosition = draft?.position;
  const formatRun = (before: number, after: number) => {
    if (after - before <= 1) return;
    const heading = headingRows.has(before) || headingRows.has(after);
    for (const [index, row] of gapRows(after - before).entries()) {
      const line = doc.line(before + index + 1);
      if (row === "half") separators.add(line.from);
      gapStarts.push(line.from);
      decorations.push(lineDecoration(row, heading, line.from));
    }
  };

  let before = 0;
  for (let after = 1; after <= lastParsedLine; after++) {
    const line = doc.line(after);
    if (line.from !== draftPosition && !protectedRows.has(after) && blankLine.test(line.text)) continue;
    formatRun(before, after);
    before = after;
  }
  // A fully parsed document has a real trailing region even without a
  // following paragraph. Keep a completely blank document editable.
  if (before && tree.length >= doc.length) formatRun(before, doc.lines + 1);

  if (draftPosition !== undefined && !protectedRows.has(doc.lineAt(draftPosition).number)) {
    decorations.push(Decoration.line({ class: "inplace-native-draft" }).range(draftPosition));
  }
  return { draft, headings: headingRows, topLevelList, separators, gapStarts, structuredRows,
    decorations: Decoration.set(decorations, true) };
}

const gapLayout = StateField.define<Layout>({
  create: state => livePreview(state) ? buildLayout(state, null) : inactive,
  update(layout, transaction) {
    if (!livePreview(transaction.state)) return inactive;
    const draft = draftAfter(transaction, layout);
    if (layout === inactive || transaction.docChanged || draft !== layout.draft ||
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildLayout(transaction.state, draft);
    }
    return layout;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

const selectedGap = Decoration.line({ class: "inplace-native-gap-selected" });

function firstGapAtOrAfter(starts: readonly number[], position: number): number {
  let start = 0;
  let end = starts.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (starts[middle] < position) start = middle + 1;
    else end = middle;
  }
  return start;
}

function selectedGaps(state: EditorState): DecorationSet {
  const { doc } = state;
  const starts = state.field(gapLayout).gapStarts;
  const selected = new Set<number>();
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    let index = firstGapAtOrAfter(starts, doc.lineAt(range.from).from);
    const first = index;
    while (index < starts.length && starts[index] < range.to) {
      selected.add(starts[index++]);
    }
    // A drag from the previous paragraph to the first blank caret offset
    // selects the incoming break. Paint one half row for that selection too.
    if (index === first && starts[index] === range.to) selected.add(range.to);
  }
  return Decoration.set(Array.from(selected, from => selectedGap.range(from)), true);
}

const gapSelection = StateField.define<DecorationSet>({
  create: selectedGaps,
  update(value, transaction) {
    // On hot enable, Obsidian reconfigures an existing editor. The previous
    // state predates this extension and does not yet contain gapLayout.
    if (transaction.selection || transaction.docChanged ||
        transaction.startState.field(gapLayout, false) !== transaction.state.field(gapLayout)) {
      return selectedGaps(transaction.state);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

function isSeparator(state: EditorState, position: number): boolean {
  return state.field(gapLayout).separators.has(state.doc.lineAt(position).from);
}

function separatorEnds(state: EditorState, position: number): [number, number] {
  const { doc } = state;
  let first = doc.lineAt(position).number;
  let last = first;
  while (first > 1 && isSeparator(state, doc.line(first - 1).from)) first--;
  while (last < doc.lines && isSeparator(state, doc.line(last + 1).from)) last++;
  return [first, last];
}

function adjacentCaret(state: EditorState, first: number, last: number, forward: boolean): number {
  const { doc } = state;
  if ((forward || first === 1) && last < doc.lines) return doc.line(last + 1).from;
  return first > 1 ? doc.line(first - 1).to : 0;
}

const redirectPointerCaret = EditorState.transactionFilter.of(transaction => {
  if (transaction.docChanged || !transaction.selection || !transaction.isUserEvent("select.pointer") ||
      !livePreview(transaction.startState)) return transaction;
  const state = transaction.startState;
  let changed = false;
  const ranges = transaction.newSelection.ranges.map(range => {
    if (!range.empty || !isSeparator(state, range.head)) return range;
    const [first, last] = separatorEnds(state, range.head);
    changed = true;
    return EditorSelection.cursor(adjacentCaret(state, first, last, state.selection.main.head <= range.head));
  });
  return changed
    ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }]
    : transaction;
});

const redirectDeletedCaret = EditorState.transactionFilter.of(transaction => {
  const before = transaction.startState;
  const selection = transaction.newSelection.main;
  if (!transaction.docChanged || !transaction.isUserEvent("delete") || !livePreview(before) ||
      transaction.newSelection.ranges.length !== 1 || !selection.empty ||
      isSeparator(before, before.selection.main.head)) return transaction;
  const after = transaction.state;
  if (!isSeparator(after, selection.head)) return transaction;
  const [first, last] = separatorEnds(after, selection.head);
  return [transaction, { selection: { anchor: adjacentCaret(after, first, last, false) }, sequential: true }];
});

interface GapHit {
  start: number;
  decoration: string;
  box: DOMRect;
}

function gapHit(view: EditorView, event: MouseEvent): GapHit | null {
  const row = view.contentDOM.ownerDocument.elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>(".cm-line[data-inplace-gap]");
  if (!row || row.parentElement !== view.contentDOM) return null;
  const start = view.state.doc.lineAt(view.posAtDOM(row, 0)).from;
  const decoration = row.dataset.inplaceGap;
  if (!decoration) return null;
  return { start, decoration, box: row.getBoundingClientRect() };
}

function clickPosition(view: EditorView, hit: GapHit, y: number): number {
  if (hit.decoration !== "half") return hit.start;
  const { state } = view;
  const { doc } = state;
  const [first, last] = separatorEnds(state, hit.start);
  // Two adjacent half rows form one separator. The hit direction changes only
  // once across the entire visual gap, regardless of which half was clicked.
  const middle = first === last
    ? (hit.box.top + hit.box.bottom) / 2
    : view.documentTop + (view.lineBlockAt(doc.line(first).from).top +
      view.lineBlockAt(doc.line(last).from).bottom) / 2;
  const forward = y >= middle;
  return adjacentCaret(state, first, last, forward);
}

const gapMouseSelection = EditorView.mouseSelectionStyle.of((view, down) => {
  if (!livePreview(view.state) || down.button !== 0 || down.detail > 1 ||
      down.altKey || down.ctrlKey || down.metaKey) return null;
  const first = gapHit(view, down);
  let start: number;
  let click: number;
  let assoc = 0;
  if (first) {
    start = first.start;
    click = clickPosition(view, first, down.clientY);
  } else {
    // Give drags from a neighboring text row an exact source endpoint
    // when they reach a half-height separator. Plain text and widget
    // clicks elsewhere continue to use the editor's own mouse handling.
    const element = view.contentDOM.ownerDocument.elementFromPoint(down.clientX, down.clientY);
    if (element?.closest("a, button, input, [contenteditable=false]")) return null;
    const row = element?.closest(".cm-line");
    if (!row || row.parentElement !== view.contentDOM) return null;
    const point = { x: down.clientX, y: down.clientY };
    const at = typeof view.posAndSideAtCoords === "function" ? view.posAndSideAtCoords(point) : null;
    const position = at?.pos ?? view.posAtCoords(point);
    if (position === null) return null;
    const { state } = view;
    const { doc } = state;
    const line = doc.lineAt(position);
    if (!(line.number > 1 && isGap(state, doc.line(line.number - 1).from)) &&
        !(line.number < doc.lines && isGap(state, doc.line(line.number + 1).from))) return null;
    start = click = position;
    assoc = at?.assoc ?? 0;
  }

  let initial = view.state.selection;
  return {
    get(event, extend, multiple) {
      const dragging = event.clientX !== down.clientX || event.clientY !== down.clientY;
      const head = dragging
        ? gapHit(view, event)?.start ?? view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
        : click;
      if (head === null) return view.state.selection;
      const anchor = extend ? initial.main.anchor : dragging ? start : click;
      const range = EditorSelection.range(anchor, head, undefined, undefined, dragging ? 0 : assoc);
      return multiple ? initial.addRange(range) : EditorSelection.create([range]);
    },
    update(update) {
      start = update.changes.mapPos(start);
      click = update.changes.mapPos(click);
      initial = initial.map(update.changes);
    },
  };
});

function editorOwnsKeyboard(view: EditorView): boolean {
  return livePreview(view.state) && !view.composing && !view.compositionStarted &&
    !view.dom.matches(".cm-vim-mode, .cm-vimMode") &&
    view.contentDOM.ownerDocument.activeElement === view.contentDOM;
}

function isGap(state: EditorState, position: number): boolean {
  const starts = state.field(gapLayout).gapStarts;
  const start = state.doc.lineAt(position).from;
  return starts[firstGapAtOrAfter(starts, start)] === start;
}

function verticalMove(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (!editorOwnsKeyboard(view)) return false;

    let skipped = false;
    const ranges = state.selection.ranges.map(range => {
      if (!extend && !range.empty) {
        return EditorSelection.cursor(forward ? range.to : range.from);
      }
      const target = view.moveVertically(range, forward);
      const { doc } = state;
      const originalLine = doc.lineAt(range.head);
      const targetLine = doc.lineAt(target.head);
      const step = forward ? 1 : -1;
      const adjacentNumber = originalLine.number + step;
      if (adjacentNumber < 1 || adjacentNumber > doc.lines) return target;
      const adjacent = doc.line(adjacentNumber);
      if (!isGap(state, originalLine.from) && !isGap(state, adjacent.from) && !isGap(state, targetLine.from)) {
        return target;
      }
      const original = view.coordsAtPos(range.head, range.assoc || 1);
      // Preserve native motion inside an actual wrapped row.
      if (targetLine.number === originalLine.number && !isGap(state, originalLine.from)) {
        const destination = view.coordsAtPos(target.head, target.assoc || 1);
        if (original && destination && (forward
          ? destination.top >= original.bottom - 1
          : destination.bottom <= original.top + 1)) return target;
      }
      skipped = true;
      let line = adjacent;
      while (isSeparator(state, line.from)) {
        const number = line.number + step;
        if (number < 1 || number > doc.lines) return range;
        line = doc.line(number);
      }
      const edge = forward ? line.from : line.to;
      const row = view.coordsAtPos(edge, forward ? 1 : -1);
      const contentLeft = view.contentDOM.getBoundingClientRect().left;
      const goal = target.goalColumn ?? range.goalColumn ?? (original ? original.left - contentLeft : undefined);
      const x = contentLeft + (goal ?? 0);
      const visual = row && view.posAtCoords({ x, y: (row.top + row.bottom) / 2 }, false);
      const head = visual !== null && visual >= line.from && visual <= line.to ? visual : edge;
      return EditorSelection.cursor(head, forward ? 1 : -1, undefined, goal);
    });
    if (!skipped) return false;
    const selection = ranges.map((target, index) => {
      const range = state.selection.ranges[index];
      return extend ? EditorSelection.range(range.anchor, target.head, target.goalColumn, undefined, target.assoc) : target;
    });
    view.dispatch({ selection: EditorSelection.create(selection, state.selection.mainIndex),
      scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

function horizontalMove(right: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (!editorOwnsKeyboard(view) || state.selection.ranges.length !== 1 ||
        !state.selection.main.empty) return false;
    const start = state.selection.main;
    const forward = right === (view.textDirection === Direction.LTR);
    let target = view.moveByChar(start, forward);
    if (!isSeparator(state, target.head)) return false;
    do {
      const next = view.moveByChar(target, forward);
      if (next.head === target.head) return true;
      target = next;
    } while (isSeparator(state, target.head));
    view.dispatch({ selection: EditorSelection.create([target]), scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

function caretAfterBlankDeletion(doc: Text, position: number): number {
  const merged = doc.lineAt(position);
  if (!blankLine.test(merged.text)) return position;
  let previous = merged.number;
  let following = merged.number;
  while (previous >= 1 && blankLine.test(doc.line(previous).text)) previous--;
  while (following <= doc.lines && blankLine.test(doc.line(following).text)) following++;

  // Keep the caret on a remaining full row when possible. The leading
  // and trailing blank rows are separators after the run shrinks.
  const firstFull = previous + 2;
  const lastFull = following - 2;
  if (firstFull <= lastFull) {
    return doc.line(Math.max(firstFull, Math.min(merged.number, lastFull))).from;
  }
  if (previous > 0) return doc.line(previous).to;
  return following <= doc.lines ? doc.line(following).from : 0;
}

function deleteBlankRow(view: EditorView): boolean {
  const { state } = view;
  if (!editorOwnsKeyboard(view) || state.readOnly || state.selection.ranges.length !== 1 ||
      !state.selection.main.empty) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const draft = state.field(gapLayout).draft;
  const terminalDraft = line.length === 0 && line.from > 0 &&
    line.from === state.doc.length && draft?.position === line.from;
  if (!terminalDraft && (!isGap(state, line.from) || isSeparator(state, line.from) ||
      line.from === 0 || line.to === state.doc.length)) return false;

  const paired = terminalDraft && draft.breaks === 2 && line.from >= 2 &&
    state.doc.sliceString(line.from - 2, line.from) === "\n\n";
  const from = line.from - (paired ? 2 : 1);
  const to = terminalDraft ? line.from : line.to + 1;
  const changes = state.changes({ from, to });
  view.dispatch({
    changes, selection: { anchor: caretAfterBlankDeletion(changes.apply(state.doc), from) },
    scrollIntoView: true, userEvent: "delete.backward",
  });
  return true;
}

function insertProseBreak(view: EditorView, paragraph: boolean): boolean {
  const { state } = view;
  if (!editorOwnsKeyboard(view) || state.readOnly || state.selection.ranges.length !== 1) return false;
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  const layout = state.field(gapLayout);
  if (to > line.to || syntaxTree(state).length < line.to) return false;
  // Obsidian or the completion plugin must get Enter first when accepting a suggestion.
  if (Array.from(view.dom.ownerDocument.querySelectorAll(".suggestion-container")).some(
    element => element.getClientRects().length > 0,
  )) return false;

  if (layout.structuredRows.has(line.number) || /^(?: {4}|\t)/.test(line.text)) {
    if (from !== to || to !== line.to) return false;
    if (paragraph && layout.topLevelList.has(line.number) && emptyListItem.test(line.text) &&
        line.number > 1 && !blankLine.test(state.doc.line(line.number - 1).text)) {
      view.dispatch({
        changes: { from: line.from, to, insert: state.lineBreak },
        selection: { anchor: line.from + 1 }, scrollIntoView: true, userEvent: "input.inplace-list-exit",
      });
      return true;
    }
    // A plain ATX heading starts body text below the heading. A caret
    // inside its title, or a heading-like token in another block, stays native.
    if (!layout.headings.has(line.number) || !atxHeading.test(line.text)) return false;
  }

  let count = paragraph ? 2 : 1;
  let followingBreak = 0;
  if (paragraph && to === line.to && from > line.from && line.number < state.doc.lines) {
    const next = state.doc.line(line.number + 1);
    // Split a line already followed by a soft break by reusing that break.
    if (!blankLine.test(next.text) && !layout.structuredRows.has(next.number)) {
      count = 1;
      followingBreak = 1;
    }
  }
  view.dispatch({
    changes: { from, to, insert: state.lineBreak.repeat(count) },
    selection: { anchor: from + count + followingBreak },
    scrollIntoView: true,
    userEvent: paragraph ? "input.inplace-paragraph" : "input.inplace-line",
  });
  return true;
}

export default class InplacePlugin extends Plugin {
  onload() {
    this.register(followUnifiedTypography(document));
    this.registerEditorExtension([
      gapLayout,
      gapSelection,
      redirectPointerCaret,
      redirectDeletedCaret,
      Prec.highest(gapMouseSelection),
      Prec.highest(keymap.of([
        { key: "ArrowUp", run: verticalMove(false, false), shift: verticalMove(false, true) },
        { key: "ArrowDown", run: verticalMove(true, false), shift: verticalMove(true, true) },
        { key: "ArrowLeft", run: horizontalMove(false) },
        { key: "ArrowRight", run: horizontalMove(true) },
        { key: "Backspace", run: deleteBlankRow },
        { key: "Enter", run: view => insertProseBreak(view, true) },
        { key: "Shift-Enter", run: view => insertProseBreak(view, false) },
      ])),
    ]);
  }
}
