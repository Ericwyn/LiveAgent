import type { Context, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { DisplayImageItemDetails, DisplayImageResultDetails } from "../../tools/builtinTypes";
import { normalizeHostedSearchBlock } from "../messages/hostedSearch";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeDisplayImageItem(value: unknown): DisplayImageItemDetails | null {
  if (!isRecord(value)) return null;
  const {
    root,
    path,
    sourceType,
    renderMode,
    sourceUrl,
    mimeType,
    sizeBytes,
    mtimeMs,
    contentHash,
  } = value;
  if (typeof path !== "string") {
    return null;
  }
  return {
    ...(typeof root === "string" ? { root: root as DisplayImageItemDetails["root"] } : {}),
    path,
    ...(typeof sourceType === "string"
      ? { sourceType: sourceType as DisplayImageItemDetails["sourceType"] }
      : {}),
    ...(typeof renderMode === "string"
      ? { renderMode: renderMode as DisplayImageItemDetails["renderMode"] }
      : {}),
    ...(typeof sourceUrl === "string" ? { sourceUrl } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
    ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
    ...(typeof mtimeMs === "number" ? { mtimeMs } : {}),
    ...(typeof contentHash === "string" ? { contentHash } : {}),
  };
}

function getDisplayImageItems(details: unknown): DisplayImageItemDetails[] {
  if (!isRecord(details) || details.kind !== "display_image" || !Array.isArray(details.images)) {
    return [];
  }
  return details.images.flatMap((item) => {
    const normalized = normalizeDisplayImageItem(item);
    return normalized ? [normalized] : [];
  });
}

function isDisplayImageToolResult(
  message: Message,
): message is ToolResultMessage<DisplayImageResultDetails> {
  return (
    message.role === "toolResult" &&
    !message.isError &&
    (message.toolName === "Image" ||
      (isRecord(message.details) && message.details.kind === "display_image"))
  );
}

function getToolResultText(message: ToolResultMessage) {
  return message.content
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text.trim()] : []))
    .join("\n\n");
}

function buildDisplayImageContextText(message: ToolResultMessage<DisplayImageResultDetails>) {
  const images = getDisplayImageItems(message.details);
  if (images.length === 0) {
    const text = getToolResultText(message);
    return [
      text || "Image tool displayed image content in the chat UI.",
      "Inline image bytes are omitted from model context because Image is a display-only UI tool.",
    ].join("\n\n");
  }

  const noun = images.length === 1 ? "image" : "images";
  const formatPath = (image: DisplayImageItemDetails) =>
    image.root && image.root !== "workspace" ? `root=${image.root} path=${image.path}` : image.path;
  return [
    `Displayed ${images.length} ${noun} in the chat UI successfully.`,
    ...images.map((image, index) => {
      const facts = [
        image.sourceType ? `sourceType=${image.sourceType}` : null,
        image.renderMode ? `renderMode=${image.renderMode}` : null,
        image.mimeType ? `mime=${image.mimeType}` : null,
        typeof image.sizeBytes === "number" ? `sizeBytes=${image.sizeBytes}` : null,
      ].filter(Boolean);
      return `${index + 1}. ${formatPath(image)}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
    }),
    "Inline image bytes are omitted from model context because Image is a display-only UI tool.",
  ].join("\n");
}

export function sanitizeMessageForModelContext(message: Message): Message {
  let nextMessage = message;

  if (message.role === "assistant") {
    const nextContent: unknown[] = [];
    let changed = false;
    for (const block of message.content as unknown[]) {
      const hostedSearch = normalizeHostedSearchBlock(block);
      if (hostedSearch) {
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (changed) {
      nextMessage = {
        ...message,
        content: nextContent as Message["content"],
      } as Message;
    }
  }

  if (!isDisplayImageToolResult(nextMessage)) return nextMessage;
  const hasInlineImages = nextMessage.content.some((block) => block.type === "image");
  const hasDisplayImageDetails = getDisplayImageItems(nextMessage.details).length > 0;
  if (!hasInlineImages && !hasDisplayImageDetails) return nextMessage;

  const text: TextContent = {
    type: "text",
    text: buildDisplayImageContextText(nextMessage),
  };

  return {
    ...nextMessage,
    content: [text],
  };
}

export function sanitizeMessagesForModelContext(messages: Message[]): Message[] {
  return messages
    .map(sanitizeMessageForModelContext)
    .filter(
      (message) =>
        message.role !== "assistant" ||
        (Array.isArray(message.content) && message.content.length > 0),
    );
}

export function stripAbortedMessagesForModelContext(messages: Message[]): Message[] {
  const sanitized: Message[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.stopReason === "aborted") {
      while (index + 1 < messages.length && messages[index + 1]?.role === "toolResult") {
        index += 1;
      }
      continue;
    }
    sanitized.push(message);
  }

  return sanitized;
}

export function sanitizeMessagesForContinuation(messages: Message[]): Message[] {
  return sanitizeMessagesForModelContext(stripAbortedMessagesForModelContext(messages));
}

export function sanitizeContextForModelRequest(context: Context): Context {
  return {
    ...context,
    messages: sanitizeMessagesForContinuation(context.messages),
  };
}
