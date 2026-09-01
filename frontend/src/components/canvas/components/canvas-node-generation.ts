import { imageReferenceLabel } from "../lib/image-reference-prompt";
import type { ReferenceImage } from "../types-media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
  prompt: string;
  referenceImages: ReferenceImage[];
  textCount: number;
  imageCount: number;
};

export type NodeGenerationInput = {
  nodeId: string;
  type: "text" | "image";
  title: string;
  text?: string;
  image?: ReferenceImage;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
  const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
  const sourceNode = nodes.find((node) => node.id === nodeId);
  if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
    return buildComposerGenerationContext(inputs, prompt);
  }

  const upstreamText = inputs
    .map((input) => input.text)
    .filter(Boolean)
    .join("\n\n");
  const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  return {
    prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
    referenceImages,
    textCount: inputs.filter((input) => input.type === "text").length,
    imageCount: referenceImages.length,
  };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
  const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
  const selectedInputs: NodeGenerationInput[] = [];
  const labelByNodeId = new Map<string, string>();
  const textBlocks: string[] = [];
  const counts = { image: 0, text: 0 };
  let hasToken = false;
  let lastIndex = 0;
  let nextPrompt = "";

  for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
    if (match.index === undefined) continue;
    hasToken = true;
    nextPrompt += prompt.slice(lastIndex, match.index);
    const input = inputByNodeId.get(match[1]);
    if (input) {
      let label = labelByNodeId.get(input.nodeId);
      if (!label) {
        label = generationLabel(input.type, counts[input.type]++);
        labelByNodeId.set(input.nodeId, label);
        if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
        else selectedInputs.push(input);
      }
      nextPrompt += input.type === "text" ? `【${label}】` : label;
    }
    lastIndex = match.index + match[0].length;
  }

  nextPrompt += prompt.slice(lastIndex);
  if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
  const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  if (!hasToken) {
    return {
      prompt,
      referenceImages: [],
      textCount: 0,
      imageCount: 0,
    };
  }

  return {
    prompt: nextPrompt,
    referenceImages,
    textCount: counts.text,
    imageCount: referenceImages.length,
  };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
  return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
    const text = readNodeTextInput(node);
    if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
    return [];
  });
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
  const { imageToDataUrl } = await import("../lib/image-storage");
  return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
  if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
  return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
  if (type === "image") return imageReferenceLabel(index);
  return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
  if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return null;
  return {
    id: node.id,
    name: `${node.title || node.id}.png`,
    type: node.metadata.mimeType || "image/png",
    dataUrl: node.metadata.content || "",
    storageKey: node.metadata.storageKey,
  };
}
