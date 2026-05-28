import { invoke } from "@tauri-apps/api/core";
import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/shared/utils";
import { getFileTypeIcon, getFileTypeIconSvg } from "./fileTypeIcons";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MentionFileEntry {
  path: string;
  kind: "file" | "dir";
}

interface MentionListResponse {
  entries: MentionFileEntry[];
  truncated: boolean;
}

type MentionSearchEntry = {
  entry: MentionFileEntry;
  searchPath: string;
};

export type MentionComposerSkill = {
  name: string;
  description: string;
  skillFile: string;
  baseDir: string;
};

export type MentionComposerSkillMention = MentionComposerSkill;

type MentionSuggestion =
  | { type: "file"; entry: MentionFileEntry }
  | { type: "skill"; skill: MentionComposerSkill };

/** Where the @/$ trigger lives inside a text node */
interface MentionContext {
  trigger: "file" | "skill";
  query: string;
  textNode: Text;
  triggerOffset: number; // char offset of the trigger inside textNode
}

export interface MentionComposerHandle {
  getText: () => string;
  getDraft: () => MentionComposerDraft;
  hasContent: () => boolean;
  setText: (text: string) => void;
  setDraft: (draft: MentionComposerDraft) => void;
  insertFileMention: (path: string, kind: "file" | "dir") => void;
  clear: () => void;
  focus: () => void;
}

export type MentionComposerLargePaste = {
  id: string;
  label: string;
  text: string;
  charCount: number;
  lineCount: number;
  preview: string;
};

export type MentionComposerDraftSegment =
  | { type: "text"; text: string }
  | { type: "largePaste"; paste: MentionComposerLargePaste }
  | { type: "skillMention"; skill: MentionComposerSkillMention };

export type MentionComposerDraft = {
  segments: MentionComposerDraftSegment[];
  text: string;
  textWithoutLargePastes: string;
  largePastes: MentionComposerLargePaste[];
  skillMentions: MentionComposerSkillMention[];
  isEmpty: boolean;
};

export interface MentionComposerProps {
  /** Called when user presses Enter (without Shift). */
  onSend: () => void;
  /** Called only when empty/non-empty state flips. */
  onEmptyChange?: (isEmpty: boolean) => void;
  onBusyChange?: (isBusy: boolean) => void;
  onPasteFiles?: (files: File[]) => void;
  disabled?: boolean;
  placeholder?: string;
  workdir: string;
  enabledSkills?: MentionComposerSkill[];
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_SUGGESTIONS = 20;
const MENTION_INDEX_MAX_RESULTS = 5000;
const MENTION_TAG_ATTR = "data-mention-path";
const MENTION_KIND_ATTR = "data-mention-kind";
const SKILL_MENTION_NAME_ATTR = "data-skill-name";
const SKILL_MENTION_FILE_ATTR = "data-skill-file";
const SKILL_MENTION_BASE_DIR_ATTR = "data-skill-base-dir";
const SKILL_MENTION_DESCRIPTION_ATTR = "data-skill-description";
const LARGE_PASTE_TAG_ATTR = "data-large-paste-id";
const LARGE_PASTE_CHAR_THRESHOLD = 8_000;
const LARGE_PASTE_LINE_THRESHOLD = 200;
const LARGE_PASTE_PREVIEW_CHARS = 160;
const CARET_ANCHOR_TEXT = "\u200B";
const IME_ENTER_SUPPRESS_WINDOW_MS = 300;
const IME_COMPOSITION_END_ENTER_TAIL_MS = 80;

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                        */
/* ------------------------------------------------------------------ */

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function formatMarkdownLinkDestination(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (/[\s()<>]/.test(normalized)) {
    return `<${normalized.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
  }
  return normalized;
}

function formatMentionReference(path: string, kind: "file" | "dir") {
  const normalized = path.replace(/\\/g, "/");
  const target = kind === "dir" && !normalized.endsWith("/") ? `${normalized}/` : normalized;
  const labelPath = target.replace(/\/+$/, "");
  const baseName = labelPath.split("/").pop() || labelPath || target;
  const label = kind === "dir" ? `${baseName}/` : baseName;
  return `[${escapeMarkdownLinkLabel(label)}](${formatMarkdownLinkDestination(target)})`;
}

function formatSkillMentionToken(skill: Pick<MentionComposerSkillMention, "name">) {
  return `$${skill.name}`;
}

function removeCaretAnchors(value: string) {
  return value.split(CARET_ANCHOR_TEXT).join("");
}

function normalizeSerializedText(value: string) {
  return removeCaretAnchors(value).replace(/\u00A0/g, " ");
}

function isMentionBoundaryChar(value: string) {
  return /\s/.test(value) || value === CARET_ANCHOR_TEXT;
}

/** Recursively serialise a contenteditable DOM tree back to plain text.
 *  Mention chips become Markdown file references. */
function pushTextSegment(out: MentionComposerDraftSegment[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  out.push({ type: "text", text });
}

function serializeChildrenToSegments(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): MentionComposerDraftSegment[] {
  const parts: MentionComposerDraftSegment[] = [];
  parent.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      pushTextSegment(parts, removeCaretAnchors(child.textContent || ""));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const mentionPath = el.getAttribute(MENTION_TAG_ATTR);
      if (mentionPath) {
        const kind = el.getAttribute(MENTION_KIND_ATTR);
        pushTextSegment(
          parts,
          formatMentionReference(mentionPath, kind === "dir" ? "dir" : "file"),
        );
      } else if (el.hasAttribute(SKILL_MENTION_NAME_ATTR)) {
        const name = el.getAttribute(SKILL_MENTION_NAME_ATTR)?.trim() ?? "";
        const skillFile = el.getAttribute(SKILL_MENTION_FILE_ATTR)?.trim() ?? "";
        const baseDir = el.getAttribute(SKILL_MENTION_BASE_DIR_ATTR)?.trim() ?? "";
        if (name && skillFile && baseDir) {
          parts.push({
            type: "skillMention",
            skill: {
              name,
              skillFile,
              baseDir,
              description: el.getAttribute(SKILL_MENTION_DESCRIPTION_ATTR)?.trim() ?? "",
            },
          });
        }
      } else {
        const largePasteId = el.getAttribute(LARGE_PASTE_TAG_ATTR);
        const largePaste = largePasteId ? largePastes.get(largePasteId) : undefined;
        if (largePaste) {
          parts.push({ type: "largePaste", paste: largePaste });
          return;
        }
        if (el.tagName === "BR") {
          pushTextSegment(parts, "\n");
        } else {
          // Block-level wrappers (DIV / P) inserted by the browser on Enter
          if (el.tagName === "DIV" || el.tagName === "P") {
            if (parts.length > 0) pushTextSegment(parts, "\n");
          }
          for (const segment of serializeChildrenToSegments(el, largePastes)) {
            if (segment.type === "text") {
              pushTextSegment(parts, segment.text);
            } else {
              parts.push(segment);
            }
          }
        }
      }
    }
  });
  return parts;
}

function serializeChildren(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): string {
  return serializeChildrenToSegments(parent, largePastes)
    .map((segment) => {
      if (segment.type === "largePaste") return segment.paste.text;
      if (segment.type === "skillMention") return formatSkillMentionToken(segment.skill);
      return segment.text;
    })
    .join("");
}

function editorTextIsEmpty(editor: HTMLElement) {
  const raw = normalizeSerializedText(editor.textContent || "");
  return raw.trim().length === 0;
}

function normalizeMentionQuery(query: string) {
  return removeCaretAnchors(query).trim().replace(/\\/g, "/").toLowerCase();
}

function normalizeLargePastePreview(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, LARGE_PASTE_PREVIEW_CHARS);
}

function countLargePasteLines(text: string) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isLargePasteText(text: string) {
  if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
  return countLargePasteLines(text) >= LARGE_PASTE_LINE_THRESHOLD;
}

function clipboardFileExtension(mimeType: string) {
  switch (mimeType.trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

function normalizeClipboardFile(file: File, index: number) {
  if (file.name.trim()) {
    return file;
  }
  const extension = clipboardFileExtension(file.type);
  const fallbackName = `clipboard-file-${index + 1}.${extension}`;
  return new File([file], fallbackName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
  });
}

function extractClipboardFiles(data: DataTransfer) {
  const files: File[] = [];
  const seen = new Set<string>();

  const addFile = (file: File | null) => {
    if (!file) return;
    const key = [
      file.name.trim() || "__clipboard_file__",
      file.type,
      file.size,
      file.lastModified,
    ].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const normalized = normalizeClipboardFile(file, files.length);
    files.push(normalized);
  };

  const clipboardFiles = Array.from(data.files ?? []);
  if (clipboardFiles.length > 0) {
    for (const file of clipboardFiles) {
      addFile(file);
    }
    return files;
  }

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    addFile(item.getAsFile());
  }

  return files;
}

function isImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
  return (
    nativeEvent.isComposing === true ||
    nativeEvent.keyCode === 229 ||
    nativeEvent.which === 229 ||
    event.key === "Process"
  );
}

function isActiveImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
  };
  return nativeEvent.isComposing === true || event.key === "Process";
}

function isEnterKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
  return (
    event.key === "Enter" || nativeEvent.code === "Enter" || nativeEvent.code === "NumpadEnter"
  );
}

function hasLegacyImeKeyboardSignal(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    keyCode?: number;
    which?: number;
  };
  return nativeEvent.keyCode === 229 || nativeEvent.which === 229;
}

function formatLargePasteCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function createMentionIcon(svgMarkup: string) {
  const template = document.createElement("template");
  template.innerHTML = svgMarkup.trim();
  const parsed = template.content.firstElementChild;
  const icon =
    parsed instanceof SVGElement && parsed.tagName.toLowerCase() === "svg"
      ? (parsed.cloneNode(true) as SVGSVGElement)
      : document.createElementNS("http://www.w3.org/2000/svg", "svg");

  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.style.flexShrink = "0";
  return icon;
}

function createFileTypeMentionIcon(path: string, kind: "file" | "dir") {
  return createMentionIcon(getFileTypeIconSvg(path, kind));
}

function isComposerChipElement(node: Node | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.hasAttribute(MENTION_TAG_ATTR) ||
      node.hasAttribute(SKILL_MENTION_NAME_ATTR) ||
      node.hasAttribute(LARGE_PASTE_TAG_ATTR))
  );
}

function createCaretAnchorText(afterRaw: string, options?: { ensureLeadingSpace?: boolean }) {
  const cleaned = removeCaretAnchors(afterRaw);
  const matchedWhitespace = cleaned.match(/^\s+/)?.[0] ?? "";
  const leadingWhitespace = matchedWhitespace || (options?.ensureLeadingSpace === true ? " " : "");
  const rest = cleaned.slice(matchedWhitespace.length);
  const caretOffset =
    leadingWhitespace.length > 0 ? leadingWhitespace.length : CARET_ANCHOR_TEXT.length;
  return {
    text: `${leadingWhitespace}${CARET_ANCHOR_TEXT}${rest}`,
    caretOffset,
  };
}

function placeCaretInTextNode(textNode: Text, offset: number) {
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textNode.data.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function ensureCaretAnchorAfterChip(chip: HTMLElement): { textNode: Text; offset: number } | null {
  const parent = chip.parentNode;
  if (!parent) return null;

  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE) {
    const textNode = next as Text;
    const anchor = createCaretAnchorText(textNode.data);
    if (textNode.data !== anchor.text) {
      textNode.data = anchor.text;
    }
    return { textNode, offset: anchor.caretOffset };
  }

  const anchor = createCaretAnchorText("");
  const textNode = document.createTextNode(anchor.text);
  parent.insertBefore(textNode, next);
  return { textNode, offset: anchor.caretOffset };
}

function normalizeCaretAfterChip(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  const { startContainer: node, startOffset: offset } = range;
  if (!root.contains(node)) return false;

  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const before = textNode.data.slice(0, offset);
    if (removeCaretAnchors(before).length === 0 && isComposerChipElement(textNode.previousSibling)) {
      const anchor = ensureCaretAnchorAfterChip(textNode.previousSibling);
      if (!anchor) return false;
      if (anchor.textNode !== textNode || anchor.offset !== offset) {
        placeCaretInTextNode(anchor.textNode, anchor.offset);
      }
      return true;
    }
    return false;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const childBefore = node.childNodes[offset - 1] ?? null;
    if (isComposerChipElement(childBefore)) {
      const anchor = ensureCaretAnchorAfterChip(childBefore);
      if (!anchor) return false;
      placeCaretInTextNode(anchor.textNode, anchor.offset);
      return true;
    }
  }

  return false;
}

function ensureTrailingCaretAnchor(root: HTMLElement) {
  const last = root.lastChild;
  if (isComposerChipElement(last)) {
    ensureCaretAnchorAfterChip(last);
  }
}

/** Find the nearest previous leaf node (for checking what precedes @). */
function prevLeaf(node: Node, root: Node): Node | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.previousSibling) {
      cur = cur.previousSibling;
      // Descend to rightmost leaf
      while (cur.lastChild && !isComposerChipElement(cur)) cur = cur.lastChild;
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

function rightmostTextNode(node: Node | null): Text | null {
  let cur = node;
  while (cur) {
    if (isComposerChipElement(cur)) {
      return null;
    }
    if (cur.nodeType === Node.TEXT_NODE) {
      return cur as Text;
    }
    cur = cur.lastChild;
  }
  return null;
}

function selectionTextPosition(root: HTMLElement): { textNode: Text; offset: number } | null {
  normalizeCaretAfterChip(root);

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (isComposerChipElement(node.parentNode)) return null;
    return { textNode: node as Text, offset };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const childBefore = element.childNodes[offset - 1] ?? null;
  if (isComposerChipElement(childBefore)) {
    const anchor = ensureCaretAnchorAfterChip(childBefore);
    if (!anchor) return null;
    placeCaretInTextNode(anchor.textNode, anchor.offset);
    return { textNode: anchor.textNode, offset: anchor.offset };
  }
  const textNode = rightmostTextNode(childBefore);
  if (textNode) {
    return { textNode, offset: (textNode.textContent || "").length };
  }
  return null;
}

/** Detect an in-progress @file or $skill mention at the cursor position. */
function detectMention(root: HTMLElement, skillsEnabled: boolean): MentionContext | null {
  const position = selectionTextPosition(root);
  if (!position) return null;

  const { textNode: node, offset } = position;
  const text = node.textContent || "";
  const before = text.slice(0, offset);

  let triggerIdx = -1;
  let trigger: MentionContext["trigger"] | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === "@") {
      triggerIdx = i;
      trigger = "file";
      break;
    }
    if (before[i] === "$" && skillsEnabled) {
      triggerIdx = i;
      trigger = "skill";
      break;
    }
    if (isMentionBoundaryChar(before[i])) break;
  }
  if (triggerIdx < 0 || !trigger) return null;

  // Trigger must be preceded by whitespace or be the very first character.
  if (triggerIdx > 0) {
    if (!isMentionBoundaryChar(before[triggerIdx - 1])) return null;
  } else {
    // triggerIdx === 0 — check previous leaf
    const prev = prevLeaf(node, root);
    if (prev) {
      if (prev.nodeType === Node.TEXT_NODE) {
        const pt = prev.textContent || "";
        if (pt.length > 0 && !isMentionBoundaryChar(pt[pt.length - 1])) return null;
      }
      // Element node (e.g. mention chip) acts as word boundary → OK
    }
  }

  return {
    trigger,
    query: before.slice(triggerIdx + 1),
    textNode: node as Text,
    triggerOffset: triggerIdx,
  };
}

function createFileMentionChip(path: string, kind: "file" | "dir") {
  const chip = document.createElement("span");
  chip.setAttribute(MENTION_TAG_ATTR, path);
  chip.setAttribute(MENTION_KIND_ATTR, kind);
  chip.contentEditable = "false";
  chip.className =
    kind === "dir"
      ? "mention-chip inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 mx-0.5 text-amber-700 dark:text-amber-300 align-baseline whitespace-nowrap select-none"
      : "mention-chip inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 mx-0.5 text-blue-700 dark:text-blue-300 align-baseline whitespace-nowrap select-none";
  chip.title = path;

  chip.appendChild(createFileTypeMentionIcon(path, kind));

  const fileName = path.split("/").pop() || path;
  chip.appendChild(document.createTextNode(fileName));
  return chip;
}

function insertMentionChipElement(
  ctx: MentionContext,
  chip: HTMLElement,
  options?: { ensureSpaceAfterChip?: boolean },
) {
  const { textNode, triggerOffset, query } = ctx;
  const text = textNode.textContent || "";
  const parent = textNode.parentNode!;

  const beforeText = text.slice(0, triggerOffset);
  const afterRaw = text.slice(triggerOffset + 1 + query.length);
  const anchor = createCaretAnchorText(afterRaw, {
    ensureLeadingSpace: options?.ensureSpaceAfterChip === true,
  });
  const afterNode = document.createTextNode(anchor.text);

  if (beforeText) {
    parent.insertBefore(document.createTextNode(beforeText), textNode);
  }
  parent.insertBefore(chip, textNode);
  parent.insertBefore(afterNode, textNode);
  parent.removeChild(textNode);

  placeCaretInTextNode(afterNode, anchor.caretOffset);
}

/** Replace the @query text with a styled mention chip. */
function insertMentionChip(ctx: MentionContext, path: string, kind: "file" | "dir") {
  const chip = createFileMentionChip(path, kind);
  insertMentionChipElement(ctx, chip, { ensureSpaceAfterChip: true });
}

function createSkillMentionChip(skill: MentionComposerSkillMention) {
  const chip = document.createElement("span");
  chip.setAttribute(SKILL_MENTION_NAME_ATTR, skill.name);
  chip.setAttribute(SKILL_MENTION_FILE_ATTR, skill.skillFile);
  chip.setAttribute(SKILL_MENTION_BASE_DIR_ATTR, skill.baseDir);
  chip.setAttribute(SKILL_MENTION_DESCRIPTION_ATTR, skill.description);
  chip.contentEditable = "false";
  chip.className =
    "mention-chip inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 mx-0.5 text-violet-700 dark:text-violet-300 align-baseline whitespace-nowrap select-none";
  chip.title = skill.description ? `${skill.name}\n${skill.description}` : skill.name;

  const sigil = document.createElement("span");
  sigil.textContent = "$";
  sigil.className = "text-[10px] font-semibold opacity-70";
  chip.appendChild(sigil);
  chip.appendChild(document.createTextNode(skill.name));
  return chip;
}

function insertSkillMentionChip(ctx: MentionContext, skill: MentionComposerSkill) {
  const chip = createSkillMentionChip(skill);
  insertMentionChipElement(ctx, chip);
}

function createLargePasteChip(paste: MentionComposerLargePaste) {
  const chip = document.createElement("span");
  chip.setAttribute(LARGE_PASTE_TAG_ATTR, paste.id);
  chip.contentEditable = "false";
  chip.className =
    "mention-chip inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 mx-0.5 text-emerald-700 dark:text-emerald-300 align-baseline whitespace-nowrap select-none";
  chip.title = paste.preview
    ? `${paste.label}\n${paste.preview}`
    : `${paste.label} (${paste.charCount} chars)`;

  chip.appendChild(createFileTypeMentionIcon("pasted.txt", "file"));

  chip.appendChild(
    document.createTextNode(
      `${paste.label} · ${formatLargePasteCount(paste.charCount)} chars · ${formatLargePasteCount(paste.lineCount)} lines`,
    ),
  );
  return chip;
}

function insertNodeAtCursor(
  root: HTMLElement,
  node: Node,
  options?: { ensureSpaceAfterNode?: boolean },
) {
  const anchor = createCaretAnchorText("", {
    ensureLeadingSpace: options?.ensureSpaceAfterNode === true,
  });
  const afterNode = document.createTextNode(anchor.text);
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(afterNode);
      range.insertNode(node);
      placeCaretInTextNode(afterNode, anchor.caretOffset);
      return;
    }
  }

  root.appendChild(node);
  root.appendChild(afterNode);
  placeCaretInTextNode(afterNode, anchor.caretOffset);
}

function scrollSelectionIntoComposerView(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    root.scrollTop = root.scrollHeight;
    return;
  }

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return;
  }

  const marker = document.createElement("span");
  marker.textContent = "\u200B";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.overflow = "hidden";

  const markerRange = range.cloneRange();
  markerRange.insertNode(marker);

  const markerRect = marker.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const margin = 4;
  const bottomOverflow = markerRect.bottom - (rootRect.bottom - margin);
  const topOverflow = rootRect.top + margin - markerRect.top;

  if (bottomOverflow > 0) {
    root.scrollTop += bottomOverflow;
  } else if (topOverflow > 0) {
    root.scrollTop -= topOverflow;
  }

  marker.remove();
}

function scheduleComposerSelectionScroll(root: HTMLElement | null) {
  if (!root) return;
  window.requestAnimationFrame(() => {
    if (!root.isConnected) return;
    scrollSelectionIntoComposerView(root);
  });
}

/** Check if cursor is right after a mention chip, return that chip if so. */
function chipBeforeCursor(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;

  // Case 1: cursor is inside the text anchor after a mention chip.
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const before = textNode.data.slice(0, offset);
    if (removeCaretAnchors(before).length === 0 && isComposerChipElement(textNode.previousSibling)) {
      return textNode.previousSibling;
    }
  }

  // Case 2: cursor inside the contenteditable element itself (not a text node),
  // offset points to a child index — check the child before that index
  if (node === root || (node.nodeType === Node.ELEMENT_NODE && root.contains(node))) {
    const el = node as HTMLElement;
    const childBefore = el.childNodes[offset - 1];
    if (isComposerChipElement(childBefore)) {
      return childBefore;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Popup sub-component                                                */
/* ------------------------------------------------------------------ */

function Popup({
  anchorRef,
  suggestions,
  highlightIndex,
  isLoading,
  error,
  showEmpty,
  emptyLabel,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  suggestions: MentionSuggestion[];
  highlightIndex: number;
  isLoading: boolean;
  error: string | null;
  showEmpty: boolean;
  emptyLabel: string;
  onSelect: (suggestion: MentionSuggestion) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      popup.style.left = `${rect.left}px`;
      popup.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
      popup.style.width = `${rect.width}px`;
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={popupRef}
      className={cn(
        "mention-popup-enter fixed z-[100] overflow-hidden rounded-2xl",
        "border border-white/55 bg-white/75 shadow-[0_18px_48px_-12px_rgba(15,23,42,0.22),0_2px_8px_-2px_rgba(15,23,42,0.06)]",
        "backdrop-blur-2xl backdrop-saturate-[180%]",
        "dark:border-white/[0.08] dark:bg-slate-900/65 dark:shadow-[0_18px_48px_-10px_rgba(0,0,0,0.55)]",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-4 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/85 to-transparent dark:via-white/15"
      />
      <div className="mention-popup-scroll relative max-h-[260px] overflow-y-auto py-1">
        {isLoading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Indexing files...</div>
        )}
        {error && !isLoading && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
        {suggestions.map((suggestion, i) => {
          const isSkill = suggestion.type === "skill";
          const entry = suggestion.type === "file" ? suggestion.entry : null;
          const skill = suggestion.type === "skill" ? suggestion.skill : null;
          const isDir = entry?.kind === "dir";
          const parts = entry ? entry.path.split("/") : [];
          const fileName = parts.pop() || "";
          const dirPath = parts.join("/");
          const Icon = entry ? getFileTypeIcon(entry.path, entry.kind) : null;
          const title = skill?.name ?? fileName;
          const subtitle = skill?.description ?? (dirPath ? `${dirPath}/` : "");
          return (
            <div
              key={
                entry ? `${entry.kind}:${entry.path}` : `skill:${skill?.skillFile ?? skill?.name}`
              }
              ref={i === highlightIndex ? hlRef : undefined}
              className={cn(
                "mention-popup-item group mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm transition-all",
                i === highlightIndex
                  ? "bg-foreground/[0.08] text-foreground shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)] dark:bg-white/[0.08] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                  : "text-foreground/85 hover:bg-foreground/[0.04] dark:text-foreground/90 dark:hover:bg-white/[0.04]",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion);
              }}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                  isSkill
                    ? "bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300"
                    : isDir
                      ? "bg-amber-500/10 dark:bg-amber-400/15"
                      : "bg-foreground/[0.04] dark:bg-white/[0.05]",
                )}
              >
                {Icon ? (
                  <Icon width={14} height={14} />
                ) : (
                  <span className="text-[12px] font-semibold">$</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium tracking-tight text-foreground/95">{title}</span>
                {subtitle && (
                  <span className="ml-1.5 text-[11px] text-muted-foreground/85">{subtitle}</span>
                )}
              </span>
              {isSkill ? (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  skill
                </span>
              ) : (
                isDir && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    dir
                  </span>
                )
              )}
            </div>
          );
        })}
        {showEmpty && !isLoading && !error && suggestions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/*  MentionComposer                                                    */
/* ------------------------------------------------------------------ */

export const MentionComposer = memo(
  forwardRef<MentionComposerHandle, MentionComposerProps>(function MentionComposer(
    {
      onSend,
      onEmptyChange,
      onBusyChange,
      onPasteFiles,
      disabled = false,
      placeholder = "",
      workdir,
      enabledSkills = [],
      className,
    }: MentionComposerProps,
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [isEmpty, setIsEmpty] = useState(true);
    const lastIsEmptyRef = useRef(true);
    const isComposingRef = useRef(false);
    const compositionEnterKeyRef = useRef(false);
    const lastCompositionEndAtRef = useRef(0);
    const imeEnterSuppressUntilRef = useRef(0);
    const busyReleaseTimerRef = useRef<number | null>(null);
    const isBusyRef = useRef(false);
    const largePastesRef = useRef(new Map<string, MentionComposerLargePaste>());
    const largePasteCounterRef = useRef(0);

    const setBusy = useCallback(
      (nextBusy: boolean) => {
        if (isBusyRef.current === nextBusy) return;
        isBusyRef.current = nextBusy;
        onBusyChange?.(nextBusy);
      },
      [onBusyChange],
    );

    const scheduleBusyRelease = useCallback(() => {
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
      }
      busyReleaseTimerRef.current = window.setTimeout(() => {
        busyReleaseTimerRef.current = null;
        setBusy(false);
      }, 140);
    }, [setBusy]);

    // ---- File list ----
    const normalizedWorkdir = workdir.trim();
    const [mentionSessionEntries, setMentionSessionEntries] = useState<MentionFileEntry[]>([]);
    const [mentionSessionLoading, setMentionSessionLoading] = useState(false);
    const [mentionSessionError, setMentionSessionError] = useState<string | null>(null);
    const mentionSessionRequestSeqRef = useRef(0);
    const mentionActiveRef = useRef(false);
    const mentionSessionQueryRef = useRef("");

    // ---- Mention state ----
    const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
    const [highlightIdx, setHighlightIdx] = useState(0);

    const resetMentionSession = useCallback(() => {
      mentionSessionRequestSeqRef.current += 1;
      mentionSessionQueryRef.current = "";
      setMentionSessionEntries([]);
      setMentionSessionLoading(false);
      setMentionSessionError(null);
    }, []);

    const closeMentionSession = useCallback(() => {
      mentionActiveRef.current = false;
      setMentionCtx(null);
      setHighlightIdx(0);
      resetMentionSession();
    }, [resetMentionSession]);

    const startMentionSession = useCallback(
      (ctx: MentionContext) => {
        const requestSeq = ++mentionSessionRequestSeqRef.current;
        mentionSessionQueryRef.current = ctx.query;
        setMentionSessionEntries([]);
        setMentionSessionLoading(ctx.trigger === "file" && Boolean(normalizedWorkdir));
        setMentionSessionError(null);

        if (ctx.trigger === "skill") {
          return;
        }
        if (!normalizedWorkdir) {
          return;
        }

        invoke<MentionListResponse>("fs_mention_list", {
          workdir: normalizedWorkdir,
          max_results: MENTION_INDEX_MAX_RESULTS,
          query: ctx.query,
        })
          .then((resp) => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries(resp.entries);
          })
          .catch(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries([]);
            setMentionSessionError("Could not index files");
          })
          .finally(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionLoading(false);
          });
      },
      [normalizedWorkdir],
    );

    const mentionSessionSearchIndex = useMemo<MentionSearchEntry[]>(
      () =>
        mentionSessionEntries.map((entry) => ({
          entry,
          searchPath: entry.path.toLowerCase(),
        })),
      [mentionSessionEntries],
    );

    useEffect(() => {
      closeMentionSession();
    }, [normalizedWorkdir, closeMentionSession]);

    useEffect(() => {
      return () => {
        mentionSessionRequestSeqRef.current += 1;
        if (busyReleaseTimerRef.current !== null) {
          window.clearTimeout(busyReleaseTimerRef.current);
        }
        setBusy(false);
      };
    }, [setBusy]);

    useEffect(() => {
      if (!disabled) return;
      closeMentionSession();
      setBusy(false);
    }, [disabled, closeMentionSession, setBusy]);

    const normalizedMentionQuery = mentionCtx ? normalizeMentionQuery(mentionCtx.query) : "";
    const suggestions = useMemo<MentionSuggestion[]>(() => {
      if (mentionCtx === null) {
        return [];
      }

      if (mentionCtx.trigger === "skill") {
        const next: MentionSuggestion[] = [];
        for (const skill of enabledSkills) {
          const haystack = `${skill.name}\n${skill.description}\n${skill.baseDir}`.toLowerCase();
          if (normalizedMentionQuery && !haystack.includes(normalizedMentionQuery)) {
            continue;
          }
          next.push({ type: "skill", skill });
          if (next.length >= MAX_SUGGESTIONS) {
            break;
          }
        }
        return next;
      }

      const next: MentionSuggestion[] = [];
      for (const item of mentionSessionSearchIndex) {
        if (normalizedMentionQuery && !item.searchPath.includes(normalizedMentionQuery)) {
          continue;
        }
        next.push({ type: "file", entry: item.entry });
        if (next.length >= MAX_SUGGESTIONS) {
          break;
        }
      }
      return next;
    }, [enabledSkills, mentionCtx, mentionSessionSearchIndex, normalizedMentionQuery]);

    useEffect(() => {
      setHighlightIdx((current) => {
        if (suggestions.length === 0) return 0;
        return Math.min(current, suggestions.length - 1);
      });
    }, [suggestions.length]);

    const popupLoading = mentionSessionLoading;
    const popupError = suggestions.length === 0 ? mentionSessionError : null;
    const popupEmptyLabel =
      mentionCtx?.trigger === "skill" ? "No matching enabled Skills" : "No matching files";
    const showEmpty =
      mentionCtx !== null && !popupLoading && !popupError && suggestions.length === 0;
    const popupVisible =
      mentionCtx !== null &&
      (popupLoading || Boolean(popupError) || suggestions.length > 0 || showEmpty);

    const applyEmptyState = useCallback(
      (nextEmpty: boolean) => {
        if (lastIsEmptyRef.current === nextEmpty) return;
        lastIsEmptyRef.current = nextEmpty;
        setIsEmpty(nextEmpty);
        onEmptyChange?.(nextEmpty);
      },
      [onEmptyChange],
    );

    const refreshEmptyState = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      applyEmptyState(editorTextIsEmpty(el));
    }, [applyEmptyState]);

    const buildDraft = useCallback((): MentionComposerDraft => {
      const el = editorRef.current;
      if (!el) {
        return {
          segments: [],
          text: "",
          textWithoutLargePastes: "",
          largePastes: [],
          skillMentions: [],
          isEmpty: true,
        };
      }

      const segments = serializeChildrenToSegments(el, largePastesRef.current);
      const largePastes: MentionComposerLargePaste[] = [];
      const skillMentions: MentionComposerSkillMention[] = [];
      const textParts: string[] = [];
      const textWithoutLargePastesParts: string[] = [];
      for (const segment of segments) {
        if (segment.type === "text") {
          textParts.push(segment.text);
          textWithoutLargePastesParts.push(segment.text);
        } else if (segment.type === "largePaste") {
          largePastes.push(segment.paste);
          textParts.push(segment.paste.text);
        } else {
          skillMentions.push(segment.skill);
          const token = formatSkillMentionToken(segment.skill);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        }
      }

      const text = normalizeSerializedText(textParts.join(""));
      const textWithoutLargePastes = normalizeSerializedText(textWithoutLargePastesParts.join(""));
      return {
        segments,
        text,
        textWithoutLargePastes,
        largePastes,
        skillMentions,
        isEmpty: editorTextIsEmpty(el),
      };
    }, []);

    const createLargePaste = useCallback((text: string): MentionComposerLargePaste => {
      const index = largePasteCounterRef.current + 1;
      largePasteCounterRef.current = index;
      return {
        id: `large-paste-${Date.now()}-${crypto.randomUUID()}`,
        label: `Pasted text ${index}`,
        text,
        charCount: text.length,
        lineCount: countLargePasteLines(text),
        preview: normalizeLargePastePreview(text),
      };
    }, []);

    const insertLargePaste = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el) return;
        const paste = createLargePaste(text);
        largePastesRef.current.set(paste.id, paste);
        insertNodeAtCursor(el, createLargePasteChip(paste));
        closeMentionSession();
        refreshEmptyState();
      },
      [closeMentionSession, createLargePaste, refreshEmptyState],
    );

    // ---- Mention detection (called after DOM updates) ----
    const refreshMention = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const applyContext = (ctx: MentionContext | null) => {
        if (ctx) {
          if (!mentionActiveRef.current) {
            mentionActiveRef.current = true;
            mentionSessionQueryRef.current = ctx.query;
            setMentionCtx(ctx);
            setHighlightIdx(0);
            startMentionSession(ctx);
            return;
          }
          setMentionCtx(ctx);
          if (ctx.query !== mentionSessionQueryRef.current) {
            mentionSessionQueryRef.current = ctx.query;
            setHighlightIdx(0);
          }
        } else if (mentionActiveRef.current) {
          closeMentionSession();
        }
      };

      applyContext(detectMention(el, enabledSkills.length > 0));
      window.requestAnimationFrame(() => {
        const nextEl = editorRef.current;
        if (!nextEl || document.activeElement !== nextEl) return;
        applyContext(detectMention(nextEl, enabledSkills.length > 0));
      });
    }, [closeMentionSession, enabledSkills.length, startMentionSession]);

    useImperativeHandle(
      ref,
      () => ({
        getText: () => {
          const el = editorRef.current;
          if (!el) return "";
          return normalizeSerializedText(serializeChildren(el, largePastesRef.current));
        },
        getDraft: buildDraft,
        hasContent: () => !buildDraft().isEmpty,
        setText: (text: string) => {
          const el = editorRef.current;
          if (!el) return;
          el.innerHTML = "";
          largePastesRef.current.clear();
          if (isLargePasteText(text)) {
            insertLargePaste(text);
          } else {
            el.innerText = text;
            closeMentionSession();
            refreshEmptyState();
          }
        },
        setDraft: (draft: MentionComposerDraft) => {
          const el = editorRef.current;
          if (!el) return;
          el.innerHTML = "";
          largePastesRef.current.clear();

          if (draft.segments.length === 0 && draft.text) {
            if (isLargePasteText(draft.text)) {
              insertLargePaste(draft.text);
              return;
            }
            el.innerText = draft.text;
          } else {
            for (const segment of draft.segments) {
              if (segment.type === "largePaste") {
                largePastesRef.current.set(segment.paste.id, segment.paste);
                el.appendChild(createLargePasteChip(segment.paste));
              } else if (segment.type === "skillMention") {
                el.appendChild(createSkillMentionChip(segment.skill));
              } else if (segment.text) {
                el.appendChild(document.createTextNode(segment.text));
              }
            }
            largePasteCounterRef.current = Math.max(
              largePasteCounterRef.current,
              largePastesRef.current.size,
            );
          }

          ensureTrailingCaretAnchor(el);
          closeMentionSession();
          refreshEmptyState();
        },
        insertFileMention: (path: string, kind: "file" | "dir") => {
          const el = editorRef.current;
          if (!el) return;
          el.focus();
          insertNodeAtCursor(el, createFileMentionChip(path, kind), { ensureSpaceAfterNode: true });
          closeMentionSession();
          refreshEmptyState();
        },
        clear: () => {
          const el = editorRef.current;
          if (!el) return;
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeMentionSession();
          refreshEmptyState();
        },
        focus: () => editorRef.current?.focus(),
      }),
      [buildDraft, closeMentionSession, insertLargePaste, refreshEmptyState],
    );

    // ---- Select suggestion ----
    const selectSuggestion = useCallback(
      (suggestion: MentionSuggestion) => {
        if (!mentionCtx) return;
        if (suggestion.type === "skill") {
          insertSkillMentionChip(mentionCtx, suggestion.skill);
        } else {
          insertMentionChip(mentionCtx, suggestion.entry.path, suggestion.entry.kind);
        }
        closeMentionSession();
        refreshEmptyState();
        editorRef.current?.focus();
      },
      [closeMentionSession, mentionCtx, refreshEmptyState],
    );

    // ---- Event handlers ----
    const handleInput = useCallback(() => {
      const el = editorRef.current;
      if (el) {
        normalizeCaretAfterChip(el);
      }
      refreshEmptyState();
      if (!isComposingRef.current) {
        refreshMention();
      }
    }, [refreshEmptyState, refreshMention]);

    const handleKeyUp = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || isComposingRef.current || isImeKeyboardEvent(e)) return;
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Enter" ||
          e.key === "Escape"
        ) {
          return;
        }
        const el = editorRef.current;
        if (el) {
          normalizeCaretAfterChip(el);
        }
        refreshMention();
      },
      [disabled, refreshMention],
    );

    const handleMouseUp = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      if (normalizeCaretAfterChip(el)) {
        refreshMention();
      }
    }, [refreshMention]);

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        const isEnter = isEnterKeyboardEvent(e);
        const isActiveCompositionKey = isComposingRef.current || isActiveImeKeyboardEvent(e);
        const hasLegacyImeSignal = hasLegacyImeKeyboardSignal(e);

        if (isActiveCompositionKey) {
          if (isEnter && !e.shiftKey) {
            compositionEnterKeyRef.current = true;
            refreshEmptyState();
            refreshMention();
          } else {
            compositionEnterKeyRef.current = false;
          }
          return;
        }

        if (isEnter && !e.shiftKey && imeEnterSuppressUntilRef.current >= performance.now()) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        const compositionEndedAgoMs = performance.now() - lastCompositionEndAtRef.current;
        if (
          isEnter &&
          !e.shiftKey &&
          lastCompositionEndAtRef.current > 0 &&
          compositionEndedAgoMs >= 0 &&
          compositionEndedAgoMs <= IME_COMPOSITION_END_ENTER_TAIL_MS
        ) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        // Legacy keyCode 229 is too broad in WebViews. It is still useful for
        // ignoring non-Enter IME key noise, but should not block normal sending.
        if (!isEnter && hasLegacyImeSignal) {
          return;
        }

        // Popup navigation
        if (popupVisible && suggestions.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((p) => (p + 1) % suggestions.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((p) => (p - 1 + suggestions.length) % suggestions.length);
            return;
          }
          if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            if (suggestions[highlightIdx]) {
              selectSuggestion(suggestions[highlightIdx]);
            }
            return;
          }
        }
        if (popupVisible && e.key === "Escape") {
          e.preventDefault();
          closeMentionSession();
          return;
        }

        // Backspace: delete mention chip if cursor is right after one
        if (e.key === "Backspace") {
          const chip = chipBeforeCursor(editorRef.current!);
          if (chip) {
            e.preventDefault();
            const largePasteId = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
            if (largePasteId) {
              largePastesRef.current.delete(largePasteId);
            }
            chip.remove();
            refreshEmptyState();
            refreshMention();
            return;
          }
        }

        // Normal Enter → send
        if (isEnter && !e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          onSend();
          return;
        }

        // Shift+Enter → line break (normalise to <br>)
        if (isEnter && e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          document.execCommand("insertLineBreak");
          scheduleComposerSelectionScroll(editorRef.current);
          refreshEmptyState();
          refreshMention();
          return;
        }
      },
      [
        popupVisible,
        suggestions,
        highlightIdx,
        selectSuggestion,
        disabled,
        closeMentionSession,
        onSend,
        refreshEmptyState,
        refreshMention,
      ],
    );

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        const clipboardFiles = extractClipboardFiles(e.clipboardData);
        if (clipboardFiles.length > 0) {
          e.preventDefault();
          onPasteFiles?.(clipboardFiles);
          return;
        }
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (isLargePasteText(text)) {
          insertLargePaste(text);
          return;
        }
        document.execCommand("insertText", false, text);
        refreshEmptyState();
        refreshMention();
      },
      [disabled, insertLargePaste, onPasteFiles, refreshEmptyState, refreshMention],
    );

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(true);
    }, [setBusy]);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
      if (compositionEnterKeyRef.current) {
        imeEnterSuppressUntilRef.current = performance.now() + IME_ENTER_SUPPRESS_WINDOW_MS;
        compositionEnterKeyRef.current = false;
      }
      refreshEmptyState();
      refreshMention();
      scheduleBusyRelease();
    }, [refreshEmptyState, refreshMention, scheduleBusyRelease]);

    const handleBlur = useCallback(() => {
      isComposingRef.current = false;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(false);
      closeMentionSession();
    }, [closeMentionSession, setBusy]);

    return (
      <div ref={wrapperRef} className="relative w-full min-w-0 max-w-full flex-1">
        {popupVisible && (
          <Popup
            anchorRef={wrapperRef}
            suggestions={suggestions}
            highlightIndex={highlightIdx}
            isLoading={popupLoading}
            error={popupError}
            showEmpty={showEmpty}
            emptyLabel={popupEmptyLabel}
            onSelect={selectSuggestion}
          />
        )}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          aria-placeholder={placeholder}
          aria-disabled={disabled}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onMouseUp={handleMouseUp}
          onPaste={handlePaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onBlur={handleBlur}
          className={cn(
            "mention-composer min-h-[70px] max-h-[160px] w-full min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] outline-hidden",
            "text-sm",
            isEmpty && "is-empty",
            disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          data-placeholder={placeholder}
        />
      </div>
    );
  }),
);

MentionComposer.displayName = "MentionComposer";
